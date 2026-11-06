// CPU-only image ingress. Both session APIs use this boundary before a provider sees image bytes.
// @ts-ignore Bun embeds these resources in compiled executables.
import avifWasm from "@jsquash/avif/codec/dec/avif_dec.wasm" with { type: "file" }
// @ts-ignore Bun embeds these resources in compiled executables.
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const INPUT_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const
export const MAX_INPUT_BYTES = 64 * 1024 * 1024
export const MAX_PIXELS = 64 * 1024 * 1024
const JPEG_QUALITIES = [80, 85, 70, 55, 40]

export class ImageInputError extends Error {
  constructor(
    readonly kind: "data_url" | "base64" | "format" | "mime" | "decode" | "input_size" | "dimensions" | "size",
    message: string,
    readonly details: Record<string, number | string> = {},
  ) {
    super(message)
    this.name = "ImageInputError"
  }
}

export interface Limits {
  readonly autoResize: boolean
  readonly maxWidth: number
  readonly maxHeight: number
  readonly maxBase64Bytes: number
}

function canonical(mime: string) {
  return mime.toLowerCase() === "image/jpg" ? "image/jpeg" : mime.toLowerCase()
}

export function parseDataUrl(url: string, mime: string) {
  if (url.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 128)
    throw new ImageInputError("input_size", "Image file exceeds the 64 MiB input limit")
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url)
  if (!match) throw new ImageInputError("data_url", "Image must be a base64 data URL with an explicit image MIME type")
  if (canonical(match[1]) !== canonical(mime))
    throw new ImageInputError("mime", "Image MIME type does not match its data URL")
  return { mime: canonical(mime), base64: match[2] }
}

function bytesFromBase64(value: string) {
  if (value.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4)
    throw new ImageInputError("input_size", "Image file exceeds the 64 MiB input limit")
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new ImageInputError("base64", "Image contains invalid or incomplete base64 data")
  const bytes = Buffer.from(value, "base64")
  if (bytes.toString("base64") !== value) throw new ImageInputError("base64", "Image contains noncanonical base64 data")
  if (bytes.length > MAX_INPUT_BYTES)
    throw new ImageInputError("input_size", "Image file exceeds the 64 MiB input limit")
  return bytes
}

// Read dimensions before allocating a decoded pixel buffer, including AVIF's nested ISO-BMFF ispe properties.
function inspect(bytes: Buffer) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    return { mime: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset + 2 > bytes.length) break
      const size = bytes.readUInt16BE(offset)
      if (size < 2 || offset + size > bytes.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 8)
        return { mime: "image/jpeg", width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) }
      offset += size
    }
    throw new ImageInputError("decode", "JPEG image is damaged or has no readable dimensions")
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString("ascii", offset, offset + 4)
      const size = bytes.readUInt32LE(offset + 4)
      const start = offset + 8
      if (start + size > bytes.length) break
      if (type === "VP8X" && size >= 10)
        return {
          mime: "image/webp",
          width: bytes.readUIntLE(start + 4, 3) + 1,
          height: bytes.readUIntLE(start + 7, 3) + 1,
        }
      if (type === "VP8 " && size >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42])))
        return {
          mime: "image/webp",
          width: bytes.readUInt16LE(start + 6) & 16383,
          height: bytes.readUInt16LE(start + 8) & 16383,
        }
      if (type === "VP8L" && size >= 5 && bytes[start] === 47) {
        const bits = bytes.readUInt32LE(start + 1)
        return { mime: "image/webp", width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 }
      }
      offset = start + size + (size & 1)
    }
    throw new ImageInputError("decode", "WebP image is damaged or has no readable dimensions")
  }
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const ftypSize = bytes.readUInt32BE(0)
    if (ftypSize < 16 || ftypSize > bytes.length) throw new ImageInputError("decode", "AVIF file header is damaged")
    const brands = [bytes.toString("ascii", 8, 12)]
    for (let offset = 16; offset + 4 <= ftypSize; offset += 4) brands.push(bytes.toString("ascii", offset, offset + 4))
    if (!brands.some((brand) => brand === "avif" || brand === "avis"))
      throw new ImageInputError(
        "format",
        "This image container is not AVIF; supported inputs are PNG, JPEG, GIF, WebP and AVIF",
      )
    const sizes: Array<{ width: number; height: number }> = []
    const visit = (start: number, end: number, depth: number) => {
      if (depth > 8) throw new ImageInputError("decode", "AVIF image has excessively nested metadata")
      for (let offset = start; offset + 8 <= end; ) {
        const type = bytes.toString("ascii", offset + 4, offset + 8)
        const declared = bytes.readUInt32BE(offset)
        const header = declared === 1 ? 16 : 8
        if (offset + header > end) throw new ImageInputError("decode", "AVIF image metadata is truncated")
        const size =
          declared === 0 ? end - offset : declared === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : declared
        if (!Number.isSafeInteger(size) || size < header || offset + size > end)
          throw new ImageInputError("decode", "AVIF image metadata has an invalid box size")
        if (type === "ispe" && size >= header + 12)
          sizes.push({
            width: bytes.readUInt32BE(offset + header + 4),
            height: bytes.readUInt32BE(offset + header + 8),
          })
        // Sequence-only AVIF stores its canvas in tkhd rather than an item ispe property.
        if (type === "tkhd") {
          const version = bytes[offset + header]
          const minimum = version === 1 ? 96 : version === 0 ? 84 : 0
          if (!minimum || size < header + minimum) throw new ImageInputError("decode", "AVIF track header is damaged")
          const width = Math.ceil(bytes.readUInt32BE(offset + size - 8) / 65536)
          const height = Math.ceil(bytes.readUInt32BE(offset + size - 4) / 65536)
          if (width || height) sizes.push({ width, height })
        }
        if (["meta", "iprp", "ipco", "moov", "trak"].includes(type))
          visit(offset + header + (type === "meta" ? 4 : 0), offset + size, depth + 1)
        offset += size
      }
    }
    visit(0, bytes.length, 0)
    if (!sizes.length) throw new ImageInputError("decode", "AVIF image has no readable dimensions")
    for (const size of sizes) checkDimensions(size.width, size.height)
    return { mime: "image/avif", ...sizes.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b)) }
  }
  throw new ImageInputError("format", "Image bytes are not a supported PNG, JPEG, GIF, WebP or AVIF image")
}

function checkDimensions(width: number, height: number) {
  if (!width || !height || width * height > MAX_PIXELS)
    throw new ImageInputError("dimensions", "Image dimensions are invalid or exceed the 64 megapixel decode limit", {
      width,
      height,
      maxPixels: MAX_PIXELS,
    })
}

function embeddedPath(value: string) {
  return path.isAbsolute(value) ? value : fileURLToPath(new URL(value, import.meta.url))
}

let photonPromise: Promise<typeof import("@silvia-odwyer/photon-node")> | undefined
function loadPhoton() {
  return (photonPromise ??= Promise.resolve().then(() => {
    ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
      embeddedPath(photonWasm)
    return import("@silvia-odwyer/photon-node")
  }))
}

let avifPromise: Promise<typeof import("@jsquash/avif/decode.js")> | undefined
function loadAvif() {
  return (avifPromise ??= import("@jsquash/avif/decode.js").then(async (module) => {
    const wasmPath = embeddedPath(avifWasm)
    const options = { wasmBinary: new Uint8Array(readFileSync(wasmPath)), locateFile: () => wasmPath }
    await module.init(options)
    return module
  }))
}

export async function normalize(base64: string, mime: string, limits: Limits) {
  const bytes = bytesFromBase64(base64)
  const info = inspect(bytes)
  if (canonical(mime) !== info.mime)
    throw new ImageInputError("mime", `Declared image MIME type does not match its ${info.mime} bytes`)
  checkDimensions(info.width, info.height)
  const photon = await loadPhoton()
  const decoded = await (async () => {
    try {
      if (info.mime !== "image/avif") return photon.PhotonImage.new_from_byteslice(bytes)
      const avif = await loadAvif()
      // decode() returns the primary still image / first frame. It never forwards AVIF to the model.
      const image = await avif.default(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      if (!image) throw new Error("empty decoded image")
      checkDimensions(image.width, image.height)
      return new photon.PhotonImage(new Uint8Array(image.data), image.width, image.height)
    } catch (error) {
      if (error instanceof ImageInputError) throw error
      throw new ImageInputError("decode", `The ${info.mime} image is damaged or could not be decoded`)
    }
  })()
  try {
    const width = decoded.get_width()
    const height = decoded.get_height()
    checkDimensions(width, height)
    const over = width > limits.maxWidth || height > limits.maxHeight || base64.length > limits.maxBase64Bytes
    if (!over && info.mime !== "image/avif") return { base64, mime: info.mime, width, height }
    const sizeError = () =>
      new ImageInputError(
        "size",
        `Image ${width}x${height} exceeds the configured ${limits.maxWidth}x${limits.maxHeight}/${limits.maxBase64Bytes} base64-byte limit`,
        {
          width,
          height,
          bytes: base64.length,
          maxWidth: limits.maxWidth,
          maxHeight: limits.maxHeight,
          maxBytes: limits.maxBase64Bytes,
        },
      )
    if (over && !limits.autoResize) throw sizeError()
    const scale = over ? Math.min(1, limits.maxWidth / width, limits.maxHeight / height) : 1
    let size = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    for (let step = 0; step < 32; step++) {
      const resized =
        size.width === width && size.height === height
          ? decoded
          : photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
      try {
        const encoders: Array<readonly [string, () => Uint8Array]> = [
          ["image/png", () => resized.get_bytes()],
          ...JPEG_QUALITIES.map((quality) => ["image/jpeg", () => resized.get_bytes_jpeg(quality)] as const),
        ]
        for (const [mime, encode] of encoders) {
          const candidate = Buffer.from(encode()).toString("base64")
          if (candidate.length <= limits.maxBase64Bytes) return { base64: candidate, mime, ...size }
        }
      } finally {
        if (resized !== decoded) resized.free()
      }
      if (!limits.autoResize || (size.width === 1 && size.height === 1)) break
      size = { width: Math.max(1, Math.floor(size.width * 0.75)), height: Math.max(1, Math.floor(size.height * 0.75)) }
    }
    throw sizeError()
  } finally {
    decoded.free()
  }
}
