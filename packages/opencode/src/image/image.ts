import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Config } from "../config/config"
import { ImageInputError, normalize as normalizeBytes, parseDataUrl } from "./codec"

export namespace Image {
  export const InputError = NamedError.create(
    "ImageInputError",
    z.object({
      message: z.string(),
      kind: z.string(),
      details: z.record(z.string(), z.union([z.string(), z.number()])),
    }),
  )

  export function isImage(input: { mime: string; url: string }) {
    return input.mime.toLowerCase().startsWith("image/") || /^data:image\//i.test(input.url)
  }

  export async function attachments<T extends { mime: string; url: string }>(parts?: T[]): Promise<T[] | undefined> {
    if (!parts) return
    return Promise.all(parts.map((part) => (isImage(part) ? normalize(part) : part)))
  }

  export async function normalize<T extends { mime: string; url: string }>(input: T): Promise<T> {
    const config = (await Config.get()).attachment?.image
    try {
      const parsed = parseDataUrl(input.url, input.mime)
      const output = await normalizeBytes(parsed.base64, parsed.mime, {
        autoResize: config?.auto_resize ?? true,
        maxWidth: config?.max_width ?? 2000,
        maxHeight: config?.max_height ?? 2000,
        maxBase64Bytes: config?.max_base64_bytes ?? 5 * 1024 * 1024,
      })
      return { ...input, mime: output.mime, url: `data:${output.mime};base64,${output.base64}` }
    } catch (error) {
      if (!(error instanceof ImageInputError)) throw error
      const failure = new InputError({ message: error.message, kind: error.kind, details: error.details })
      failure.message = error.message
      throw failure
    }
  }
}
