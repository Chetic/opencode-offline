import { describe, expect, mock, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { MAX_INPUT_BYTES } from "../../src/image/codec"
import { Clipboard } from "../../src/cli/cmd/tui/util/clipboard"
import { Config } from "../../src/config/config"
import { Keybind } from "../../src/util/keybind"
import { loadLocalImage, parseLocalImagePath } from "../../src/cli/cmd/tui/util/image-input"
import { tmpdir } from "../fixture/fixture"

// The checked-in public libavif fixture is shared with codec.test.ts.
const avif = readFileSync(new URL("./fixtures/white-1x1.avif", import.meta.url))
const limits = { autoResize: true, maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 5 * 1024 * 1024 }
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="

function directory() {
  return tmpdir({
    dispose: async (dir) => {
      const root = path.resolve(os.tmpdir())
      const target = path.resolve(dir)
      const same = (a: string, b: string) =>
        process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
      if (!same(path.dirname(target), root) || !/^opencode-test-[a-z0-9]+$/.test(path.basename(target)))
        throw new Error("Refusing cleanup outside the owned test temporary directory")
      if (!same(path.dirname(await fs.realpath(target)), await fs.realpath(root)))
        throw new Error("Refusing redirected test temporary directory cleanup")
      await fs.rm(target, { recursive: true, force: true })
    },
  })
}

test("Windows paste defaults include a terminal-safe Alt+V alternative and preserve custom bindings", () => {
  const value = Config.Keybinds.parse({}).input_paste
  expect(value).toBe(process.platform === "win32" ? "ctrl+v,alt+v" : "ctrl+v")
  const [ctrl, alt] = Keybind.parse("ctrl+v,alt+v")
  expect(ctrl).toMatchObject({ name: "v", ctrl: true, meta: false })
  expect(alt).toMatchObject({ name: "v", ctrl: false, meta: true })
  expect(Keybind.match(ctrl, alt!)).toBe(false)
  expect(Config.Keybinds.parse({ input_paste: "super+v" }).input_paste).toBe("super+v")
})

describe("local image path input", () => {
  test("accepts a complete Windows image path with either surrounding quote style", () => {
    const file = String.raw`C:\image folder\图像 one.AVIF`
    expect(parseLocalImagePath(file, "win32")).toBe(file)
    expect(parseLocalImagePath(`"${file}"`, "win32")).toBe(file)
    expect(parseLocalImagePath(`'${file}'`, "win32")).toBe(file)
    expect(parseLocalImagePath(`  "${file}"  `, "win32")).toBe(file)
  })

  test("accepts quoted POSIX paths and shell-escaped spaces", () => {
    expect(parseLocalImagePath("'/tmp/image folder/one.png'", "linux")).toBe("/tmp/image folder/one.png")
    expect(parseLocalImagePath(String.raw`/tmp/image\ folder/one.png`, "linux")).toBe("/tmp/image folder/one.png")
  })

  test("preserves ordinary non-image text for the prompt", () => {
    for (const value of ["", "  ", "Please describe this image", "line one\nline two", "notes.txt", '"notes.txt"'])
      expect(parseLocalImagePath(value)).toBeUndefined()
  })

  test.each([
    "https://example.invalid/image.png",
    "http://127.0.0.1/image.avif",
    "ftp://example.invalid/image.jpg",
    "file://example.invalid/share/image.png",
    "https://example.invalid/image.png?download=1",
  ])("refuses a remote or non-file image URL: %s", (value) => {
    expect(() => parseLocalImagePath(value, "win32")).toThrow()
  })

  test.each([
    String.raw`\\server\share\image.png`,
    "//server/share/image.png",
    String.raw`\\?\C:\images\image.avif`,
    String.raw`\\.\C:\images\image.jpg`,
  ])("refuses UNC and device paths: %s", (value) => {
    expect(() => parseLocalImagePath(value, "win32")).toThrow()
  })

  test.each([
    String.raw`C:\images\image.png:stream`,
    String.raw`C:\images\image.png:stream:$DATA`,
    String.raw`C:\images\document.txt:stream.png`,
  ])("refuses Windows alternate data streams: %s", (value) => {
    expect(() => parseLocalImagePath(value, "win32")).toThrow()
  })

  test("refuses control characters in an image path", () => {
    for (const value of ["C:\\images\\one\ntwo.png", "C:\\images\\one\rtwo.png", "C:\\images\\one\0two.png"])
      expect(() => parseLocalImagePath(value, "win32")).toThrow()
  })
})

describe("local image file loading", () => {
  test("does not inspect or read an ordinary text prompt", async () => {
    const inspectWindows = mock(async (_file: string) => {})
    expect(
      await loadLocalImage("Please explain the attached diagram", { platform: "win32", inspectWindows }),
    ).toBeUndefined()
    expect(inspectWindows).not.toHaveBeenCalled()
  })

  test("normalizes an owned AVIF file after the Windows metadata check", async () => {
    await using tmp = await directory()
    const file = path.join(tmp.path, "image with spaces.avif")
    await fs.writeFile(file, avif)
    const inspectWindows = mock(async (_file: string) => {})
    const result = await loadLocalImage(`"${file}"`, { platform: "win32", inspectWindows, limits })
    expect(inspectWindows).toHaveBeenCalledTimes(1)
    expect(inspectWindows).toHaveBeenCalledWith(file)
    expect(result).toMatchObject({ filename: "image with spaces.avif", mime: "image/png" })
    expect(Buffer.from(result!.content, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  })

  test("accepts a native local file URL with encoded spaces", async () => {
    await using tmp = await directory()
    const file = path.join(tmp.path, "local image.avif")
    await fs.writeFile(file, avif)
    expect(parseLocalImagePath(pathToFileURL(file).href)).toBe(file)
    expect(await loadLocalImage(pathToFileURL(file).href, { inspectWindows: async () => {}, limits })).toMatchObject({
      filename: "local image.avif",
      mime: "image/png",
    })
  })

  test("a rejected metadata gate prevents file content reads", async () => {
    await using tmp = await directory()
    const file = path.join(tmp.path, "must-not-read.avif")
    await fs.writeFile(file, avif)
    const handle = await fs.open(file, "r")
    const read = spyOn(Object.getPrototypeOf(handle), "read")
    try {
      const inspectWindows = mock(async (_file: string) => {
        throw new Error("synthetic offline-only metadata")
      })
      await expect(loadLocalImage(file, { platform: "win32", inspectWindows })).rejects.toThrow(
        "synthetic offline-only metadata",
      )
      expect(inspectWindows).toHaveBeenCalledWith(file)
      expect(read).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
      await handle.close()
    }
  })

  test("checks Windows metadata before opening a nonexistent file", async () => {
    await using tmp = await directory()
    const file = path.join(tmp.path, "not-created.avif")
    await expect(
      loadLocalImage(file, {
        platform: "win32",
        inspectWindows: async () => {
          throw new Error("synthetic metadata refusal")
        },
      }),
    ).rejects.toThrow("synthetic metadata refusal")
  })

  test("rejects directories and damaged image files", async () => {
    await using tmp = await directory()
    const folder = path.join(tmp.path, "folder.png")
    const file = path.join(tmp.path, "damaged.avif")
    await fs.mkdir(folder)
    await fs.writeFile(file, "synthetic invalid image bytes")
    const options = { inspectWindows: async () => {}, limits }
    await expect(loadLocalImage(folder, options)).rejects.toThrow("regular")
    await expect(loadLocalImage(file, options)).rejects.toThrow("supported")
  })

  test("rejects an extension whose MIME does not match the image bytes", async () => {
    await using tmp = await directory()
    const file = path.join(tmp.path, "wrong.png")
    await fs.writeFile(file, avif)
    await expect(loadLocalImage(file, { inspectWindows: async () => {}, limits })).rejects.toThrow("MIME")
  })

  test("rejects an oversized sparse file before reading its contents", async () => {
    await using tmp = await directory()
    const file = path.join(tmp.path, "oversized.avif")
    const handle = await fs.open(file, "w+")
    await handle.truncate(MAX_INPUT_BYTES + 1)
    const read = spyOn(Object.getPrototypeOf(handle), "read")
    try {
      await expect(loadLocalImage(file, { inspectWindows: async () => {}, limits })).rejects.toThrow("64 MiB")
      expect(read).not.toHaveBeenCalled()
      expect((await handle.stat()).size).toBe(MAX_INPUT_BYTES + 1)
    } finally {
      read.mockRestore()
      await handle.close()
    }
  })

  test("keeps the existing SVG text contract", async () => {
    await using tmp = await directory()
    const file = path.join(tmp.path, "shape.svg")
    const content = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
    await fs.writeFile(file, content)
    expect(await loadLocalImage(file, { inspectWindows: async () => {} })).toEqual({
      filename: "shape.svg",
      mime: "image/svg+xml",
      content,
    })
  })
})

describe("Windows clipboard serialization", () => {
  // Only the pure parser is called here; no test reads or changes the system clipboard.
  test("returns no content for an empty response or empty file drop list", () => {
    expect(Clipboard.parseWindowsContent("")).toBeUndefined()
    expect(Clipboard.parseWindowsContent(" \r\n")).toBeUndefined()
    expect(Clipboard.parseWindowsContent('{"files":[]}')).toBeUndefined()
  })

  test("preserves file drop ordering, Unicode and spaces", () => {
    const files = [String.raw`C:\images\one image.avif`, String.raw`C:\images\图像二.png`]
    expect(Clipboard.parseWindowsContent(JSON.stringify({ files }))).toEqual({
      data: "",
      mime: "application/x-opencode-file-list",
      files,
    })
  })

  test("accepts sixteen files and rejects a larger drop", () => {
    const files = Array.from({ length: 16 }, (_, index) => String.raw`C:\images\${index}.png`)
    expect(Clipboard.parseWindowsContent(JSON.stringify({ files }))?.files).toEqual(files)
    expect(() =>
      Clipboard.parseWindowsContent(JSON.stringify({ files: [...files, String.raw`C:\images\extra.png`] })),
    ).toThrow()
  })

  test("rejects malformed file lists", () => {
    for (const files of [[""], [1], ["one\ntwo.png"], ["one\0two.png"], ["a".repeat(32769)]])
      expect(() => Clipboard.parseWindowsContent(JSON.stringify({ files }))).toThrow()
  })

  test("accepts a canonical PNG bitmap payload", () => {
    expect(Clipboard.parseWindowsContent(JSON.stringify({ data: png, mime: "image/png" }))).toEqual({
      data: png,
      mime: "image/png",
    })
  })

  test("rejects malformed JSON, unsupported payload shapes and invalid base64", () => {
    for (const value of ["{", "null", "[]", '{"files":"image.png"}', '{"data":"Zg==","mime":"image/jpeg"}'])
      expect(() => Clipboard.parseWindowsContent(value)).toThrow()
    for (const data of ["", "Zg", "Zg=", "Zh==", "Zg==\n", "%%%="])
      expect(() => Clipboard.parseWindowsContent(JSON.stringify({ data, mime: "image/png" }))).toThrow()
  })

  test("rejects an oversized clipboard response before parsing or decoding", () => {
    const content = "A".repeat(Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 1025)
    expect(() => Clipboard.parseWindowsContent(content)).toThrow("64 MiB")
  })
})
