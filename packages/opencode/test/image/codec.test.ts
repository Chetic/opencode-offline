import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ImageInputError, normalize, parseDataUrl } from "../../src/image/codec"

// Public libavif fixtures, commit e760e8f05375cbd0c6d72065b18cac4542b13092:
// https://github.com/AOMediaCodec/libavif/tree/e760e8f05375cbd0c6d72065b18cac4542b13092/tests/data
const still = readFileSync(new URL("./fixtures/white-1x1.avif", import.meta.url))
const animation = readFileSync(new URL("./fixtures/colors-animated-8bpc.avif", import.meta.url))
const limits = { autoResize: true, maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 5 * 1024 * 1024 }

function sequenceOnly() {
  const bytes = Buffer.from(animation)
  for (let offset = 8; offset + 4 <= bytes.readUInt32BE(0); offset += 4)
    if (bytes.toString("ascii", offset, offset + 4) === "avif") bytes.write("avis", offset, "ascii")
  for (let offset = 0; offset + 8 <= bytes.length; offset += bytes.readUInt32BE(offset))
    if (bytes.toString("ascii", offset + 4, offset + 8) === "meta") bytes.write("free", offset + 4, "ascii")
  return bytes
}

describe("image codec", () => {
  test("transcodes a real AVIF into a decodable PNG", async () => {
    const image = await normalize(still.toString("base64"), "image/avif", limits)
    expect(image).toMatchObject({ mime: "image/png", width: 1, height: 1 })
    expect(Buffer.from(image.base64, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(await normalize(image.base64, image.mime, limits)).toEqual(image)
  })

  test("rejects malformed URLs, base64, mismatched MIME, and damaged bytes", async () => {
    expect(() => parseDataUrl("file:///image.avif", "image/avif")).toThrow(ImageInputError)
    expect(() => parseDataUrl("data:image/png;base64,AAAA", "image/avif")).toThrow("does not match")
    await expect(normalize("Zg", "image/avif", limits)).rejects.toThrow("base64")
    await expect(normalize("Zh==", "image/avif", limits)).rejects.toThrow("noncanonical")
    await expect(normalize(still.toString("base64"), "image/png", limits)).rejects.toThrow("MIME")
    await expect(normalize(still.subarray(0, 32).toString("base64"), "image/avif", limits)).rejects.toThrow(
      ImageInputError,
    )
    expect((await normalize(still.toString("base64"), "image/avif", limits)).width).toBe(1)
  })

  test("preserves configured limits without bypassing auto_resize false", async () => {
    await expect(
      normalize(animation.toString("base64"), "image/avif", { ...limits, maxWidth: 1, autoResize: false }),
    ).rejects.toThrow("configured")
    const image = await normalize(animation.toString("base64"), "image/avif", { ...limits, maxWidth: 1, maxHeight: 1 })
    expect(image.width).toBe(1)
    expect(image.height).toBe(1)
    await expect(normalize(still.toString("base64"), "image/avif", { ...limits, maxBase64Bytes: 8 })).rejects.toThrow(
      "configured",
    )
  })

  test("decodes the primary frame of animated and sequence-only AVIF", async () => {
    const primary = await normalize(animation.toString("base64"), "image/avif", limits)
    const sequence = await normalize(sequenceOnly().toString("base64"), "image/avif", limits)
    expect(primary).toMatchObject({ mime: "image/png", width: 150, height: 150 })
    expect(sequence).toEqual(primary)
  })

  test("rejects oversized track dimensions before AVIF decoding", async () => {
    const bytes = sequenceOnly()
    const tag = bytes.indexOf("tkhd")
    expect(tag).toBeGreaterThan(0)
    const end = tag - 4 + bytes.readUInt32BE(tag - 4)
    bytes.writeUInt32BE(0xffff0000, end - 8)
    bytes.writeUInt32BE(0xffff0000, end - 4)
    await expect(normalize(bytes.toString("base64"), "image/avif", limits)).rejects.toThrow("64 megapixel")
  })
})
