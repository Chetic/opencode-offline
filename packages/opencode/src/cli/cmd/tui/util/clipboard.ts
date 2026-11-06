import { $ } from "bun"
import { platform, release } from "os"
import clipboardy from "clipboardy"
import { lazy } from "../../../../util/lazy.js"
import { tmpdir } from "os"
import path from "path"
import { Filesystem } from "../../../../util/filesystem"
import { Process } from "../../../../util/process"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

/**
 * Writes text to clipboard via OSC 52 escape sequence.
 * This allows clipboard operations to work over SSH by having
 * the terminal emulator handle the clipboard locally.
 */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const passthrough = process.env["TMUX"] || process.env["STY"]
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
  process.stdout.write(sequence)
}

export namespace Clipboard {
  export interface Content {
    data: string
    mime: string
    files?: string[]
  }

  export function parseWindowsContent(text: string): Content | undefined {
    if (!text.trim()) return
    if (text.length > Math.ceil((64 * 1024 * 1024) / 3) * 4 + 1024)
      throw new Error("Clipboard image exceeds the 64 MiB input limit")
    const value = JSON.parse(text)
    if (Array.isArray(value.files)) {
      if (
        value.files.length > 16 ||
        value.files.some((p: unknown) => typeof p !== "string" || !p || p.length > 32768 || /[\0\r\n]/.test(p))
      )
        throw new Error("Clipboard file list is invalid or contains more than 16 files")
      if (!value.files.length) return
      return { data: "", mime: "application/x-opencode-file-list", files: value.files }
    }
    if (value.mime !== "image/png" || typeof value.data !== "string")
      throw new Error("Clipboard image format is invalid")
    const data = value.data
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      throw new Error("Clipboard image contains invalid base64")
    const bytes = Buffer.from(data, "base64")
    if (bytes.length > 64 * 1024 * 1024 || bytes.toString("base64") !== data)
      throw new Error("Clipboard image is invalid or exceeds the 64 MiB input limit")
    return { data, mime: "image/png" }
  }

  export async function read(): Promise<Content | undefined> {
    const os = platform()

    if (os === "darwin") {
      const tmpfile = path.join(tmpdir(), "opencode-clipboard.png")
      try {
        await $`osascript -e 'set imageData to the clipboard as "PNGf"' -e 'set fileRef to open for access POSIX file "${tmpfile}" with write permission' -e 'set eof fileRef to 0' -e 'write imageData to fileRef' -e 'close access fileRef'`
          .nothrow()
          .quiet()
        const buffer = await Filesystem.readBytes(tmpfile)
        return { data: buffer.toString("base64"), mime: "image/png" }
      } catch {
      } finally {
        await $`rm -f "${tmpfile}"`.nothrow().quiet()
      }
    }

    if (os === "win32" || release().includes("WSL")) {
      const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files.Count -gt 0) {
  if ($files.Count -gt 16) { throw 'Paste at most 16 image files at once' }
  @{ files = @($files) } | ConvertTo-Json -Compress
  exit
}
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) {
  try {
    if ([long]$img.Width * $img.Height -gt 67108864) { throw 'Clipboard image exceeds the 64 megapixel limit' }
    $ms = New-Object System.IO.MemoryStream
    try {
      $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      if ($ms.Length -gt 67108864) { throw 'Clipboard image exceeds the 64 MiB limit' }
      @{ mime = 'image/png'; data = [System.Convert]::ToBase64String($ms.ToArray()) } | ConvertTo-Json -Compress
    } finally { $ms.Dispose() }
  } finally { $img.Dispose() }
}`
      const result = await promisify(execFile)(
        "powershell.exe",
        ["-NonInteractive", "-NoProfile", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 90 * 1024 * 1024, windowsHide: true },
      ).catch(() => {
        throw new Error("Windows clipboard could not be read; copy the image again or paste its local file path")
      })
      const content = parseWindowsContent(result.stdout.toString())
      if (content) return content
    }

    if (os === "linux") {
      const wayland = await $`wl-paste -t image/png`.nothrow().arrayBuffer()
      if (wayland && wayland.byteLength > 0) {
        return { data: Buffer.from(wayland).toString("base64"), mime: "image/png" }
      }
      const x11 = await $`xclip -selection clipboard -t image/png -o`.nothrow().arrayBuffer()
      if (x11 && x11.byteLength > 0) {
        return { data: Buffer.from(x11).toString("base64"), mime: "image/png" }
      }
    }

    const text = await clipboardy.read().catch(() => {})
    if (text) {
      return { data: text, mime: "text/plain" }
    }
  }

  const getCopyMethod = lazy(() => {
    const os = platform()

    if (os === "darwin" && Bun.which("osascript")) {
      console.log("clipboard: using osascript")
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await $`osascript -e 'set the clipboard to "${escaped}"'`.nothrow().quiet()
      }
    }

    if (os === "linux") {
      if (process.env["WAYLAND_DISPLAY"] && Bun.which("wl-copy")) {
        console.log("clipboard: using wl-copy")
        return async (text: string) => {
          const proc = Process.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
          if (!proc.stdin) return
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
      if (Bun.which("xclip")) {
        console.log("clipboard: using xclip")
        return async (text: string) => {
          const proc = Process.spawn(["xclip", "-selection", "clipboard"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          if (!proc.stdin) return
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
      if (Bun.which("xsel")) {
        console.log("clipboard: using xsel")
        return async (text: string) => {
          const proc = Process.spawn(["xsel", "--clipboard", "--input"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          if (!proc.stdin) return
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
    }

    if (os === "win32") {
      console.log("clipboard: using powershell")
      return async (text: string) => {
        // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
        const proc = Process.spawn(
          [
            "powershell.exe",
            "-NonInteractive",
            "-NoProfile",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
          ],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          },
        )

        if (!proc.stdin) return
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }

    console.log("clipboard: no native support")
    return async (text: string) => {
      await clipboardy.write(text).catch(() => {})
    }
  })

  export async function copy(text: string): Promise<void> {
    writeOsc52(text)
    await getCopyMethod()(text)
  }
}
