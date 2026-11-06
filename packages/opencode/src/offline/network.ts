// Local deployment hardening for the community offline fork.
// This guards JavaScript fetch in each imported realm, not raw sockets or child processes.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveObjectURL } from "node:buffer"

const enabled = ["1", "true"].includes(process.env.OPENCODE_OFFLINE_MODE?.toLowerCase() ?? "")

export function assertOfflineURL(input: string | URL | Request) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  // Inline data and registered Blob URLs are resolved locally by fetch, without network I/O.
  // This includes image data downloaded by the AI SDK and OpenTUI's embedded WASM.
  if (url.protocol === "data:") return
  if (url.protocol === "blob:" && resolveObjectURL(url.href)) return
  // Compiled Bun assets may use file URLs inside its virtual filesystem only.
  // Host/UNC paths and ordinary disk file URLs are deliberately excluded.
  if (url.protocol === "file:" && !url.hostname) {
    const root = process.platform === "win32" ? "B:\\~BUN\\root" : "/$bunfs/root"
    const file = (() => {
      try {
        return fileURLToPath(url)
      } catch {
        return undefined
      }
    })()
    if (file) {
      const relative = path.relative(root, file)
      if (relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) return
    }
  }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Offline mode blocks this network request; only literal loopback HTTP endpoints are allowed.")
  }
}

if (enabled) {
  const native = globalThis.fetch
  const guarded = (async (input, init) => {
    assertOfflineURL(input)
    // Never let a permitted local endpoint automatically redirect to the internet.
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined)
    return native(input, { ...init, redirect: redirect === "manual" ? "manual" : "error" })
  }) as typeof fetch
  if (native.preconnect) {
    guarded.preconnect = ((...args: Parameters<typeof native.preconnect>) => {
      assertOfflineURL(args[0])
      return native.preconnect(...args)
    }) as typeof native.preconnect
  }
  globalThis.fetch = guarded
}
