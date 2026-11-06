import path from "node:path"
import { lstat, open, realpath } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { MAX_INPUT_BYTES, normalize, type Limits } from "@/image/codec"

const mimes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
}

export const defaultImageLimits: Limits = {
  autoResize: true,
  maxWidth: 2000,
  maxHeight: 2000,
  maxBase64Bytes: 5 * 1024 * 1024,
}

export function parseLocalImagePath(input: string, platform: NodeJS.Platform = process.platform) {
  let value = input.trim()
  if (!value) return
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  if (quoted) value = value.slice(1, -1)
  if (!/\.(png|jpe?g|gif|webp|avif|svg)(?:[?#:].*)?$/i.test(value)) return
  if (value.length > 32768) throw new Error("Image path exceeds the supported length")
  if (!quoted && /\s/.test(value) && !/[\\/]/.test(value)) return
  if (/[\0\r\n]/.test(value)) throw new Error("Paste one local image path at a time")
  if (/^file:/i.test(value)) {
    const url = new URL(value)
    if (url.hostname || url.search || url.hash) throw new Error("Only local image files are supported")
    value = fileURLToPath(url)
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new Error("Only local image files are supported; network URLs are not loaded")
  }
  if (/^(?:\\\\|\/\/)/.test(value)) throw new Error("Network and device image paths are not supported")
  if (platform === "win32" && value.slice(/^[a-z]:/i.test(value) ? 2 : 0).includes(":"))
    throw new Error("Alternate data stream image paths are not supported")
  // Keep Windows separators intact; only POSIX shell escaping uses backslash-space.
  if (platform !== "win32") value = value.replace(/\\ /g, " ")
  return value
}

// Query metadata with OPEN_REPARSE_POINT before a data read. Cloud Files placeholders
// must be made resident by the user; attaching an image must not hydrate them.
const windowsMetadataScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ImageLocalMetadata {
  [StructLayout(LayoutKind.Sequential)] struct TagInfo { public uint Attributes; public uint Tag; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int k, out TagInfo i, uint n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder p, uint n, uint f);
  public static void Check(string value) {
    string full = Path.GetFullPath(value);
    if (new DriveInfo(Path.GetPathRoot(full)).DriveType != DriveType.Fixed)
      throw new IOException("Only image files on a local fixed drive are supported");
    string current = full;
    bool leaf = true;
    while (current != null) {
      using (var handle = CreateFileW(current, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new IOException("Image metadata could not be opened");
        TagInfo info;
        if (!GetFileInformationByHandleEx(handle, 9, out info, 8)) throw new IOException("Image metadata is unavailable");
        if ((info.Attributes & 0x400) != 0 && (info.Tag & 0xffff0fff) != 0x9000001a)
          throw new IOException("Image symlinks and junctions are not supported");
        if (leaf && (info.Attributes & (0x1000 | 0x40000 | 0x400000)) != 0)
          throw new IOException("Image is online-only. Download it in Explorer before attaching it");
        if (leaf && (info.Attributes & 0x10) != 0) throw new IOException("Choose an image file, not a folder");
        var final = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
        if (length == 0 || length >= final.Capacity) throw new IOException("Image path could not be verified");
        string actual = final.ToString();
        if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
        if (!String.Equals(actual.TrimEnd('\\'), current.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
          throw new IOException("Image path resolves outside its selected location");
      }
      leaf = false;
      current = Path.GetDirectoryName(current);
    }
  }
}
'@
try { [ImageLocalMetadata]::Check($env:OPENCODE_IMAGE_INPUT_PATH); 'ok' }
catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }
`

async function inspectWindows(filepath: string) {
  try {
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-EncodedCommand",
        Buffer.from(windowsMetadataScript, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, OPENCODE_IMAGE_INPUT_PATH: filepath },
        timeout: 10_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
    )
  } catch (error) {
    const message = (error as { stderr?: string }).stderr?.trim()
    throw new Error(message || "Image metadata could not be verified")
  }
}

export interface PreparedImage {
  filename?: string
  content: string
  mime: string
}

export async function prepareImage(image: PreparedImage, limits = defaultImageLimits): Promise<PreparedImage> {
  const result = await normalize(image.content, image.mime, limits)
  return { filename: image.filename, mime: result.mime, content: result.base64 }
}

export async function loadLocalImage(
  input: string,
  options: {
    limits?: Limits
    platform?: NodeJS.Platform
    inspectWindows?: (filepath: string) => Promise<void>
  } = {},
): Promise<PreparedImage | undefined> {
  const platform = options.platform ?? process.platform
  const value = parseLocalImagePath(input, platform)
  if (!value) return
  const filepath = path.resolve(value)
  if (platform === "win32") await (options.inspectWindows ?? inspectWindows)(filepath)
  const info = await lstat(filepath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Choose a regular local image file")
  const resolved = await realpath(filepath)
  if (platform === "win32" ? resolved.toLowerCase() !== filepath.toLowerCase() : resolved !== filepath)
    throw new Error("Image symlinks and junctions are not supported")
  if (info.size > MAX_INPUT_BYTES) throw new Error("Image file exceeds the 64 MiB input limit")
  const file = await open(filepath, "r")
  try {
    const current = await file.stat()
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino)
      throw new Error("Image file changed while it was being attached")
    if (current.size > MAX_INPUT_BYTES) throw new Error("Image file exceeds the 64 MiB input limit")
    const buffer = Buffer.alloc(current.size + 1)
    let count = 0
    while (count < buffer.length) {
      const result = await file.read(buffer, count, buffer.length - count, count)
      if (!result.bytesRead) break
      count += result.bytesRead
    }
    if (count > current.size) throw new Error("Image file changed while it was being attached")
    const content = buffer.subarray(0, count)
    const mime = mimes[path.extname(filepath).toLowerCase()]
    if (mime === "image/svg+xml") return { filename: path.basename(filepath), mime, content: content.toString("utf8") }
    return await prepareImage(
      { filename: path.basename(filepath), mime, content: content.toString("base64") },
      options.limits,
    )
  } finally {
    await file.close()
  }
}
