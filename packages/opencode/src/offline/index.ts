import path from "path"
import { Flag } from "../flag/flag"
import { Filesystem } from "../util/filesystem"

export namespace Offline {
  // Browser requests use a separate network stack from the CLI fetch guard.
  export const webCSP = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ")

  export function isEnabled(): boolean {
    return Flag.OPENCODE_OFFLINE_MODE
  }

  export function getDepsPath(): string | undefined {
    return Flag.OPENCODE_OFFLINE_DEPS_PATH
  }

  export function resolveBinary(name: string, subpath: string): string | undefined {
    const depsPath = getDepsPath()
    if (!isEnabled() || !depsPath) return undefined
    return path.join(depsPath, subpath, name)
  }

  export function resolveNpmPackage(pkg: string): string | undefined {
    const depsPath = getDepsPath()
    if (!isEnabled() || !depsPath) return undefined
    return path.join(depsPath, "node_modules", pkg)
  }

  export function resolveLspBinary(lspName: string, binaryName: string): string | undefined {
    const depsPath = getDepsPath()
    if (!isEnabled() || !depsPath) return undefined
    return path.join(depsPath, "lsp", lspName, "bin", binaryName)
  }

  export function resolveAppDist(): string | undefined {
    const depsPath = getDepsPath()
    if (!isEnabled() || !depsPath) return undefined
    return path.join(depsPath, "app")
  }

  export async function tryServeStaticFile(reqPath: string): Promise<{ body: ReturnType<typeof Bun.file>; mime: string } | undefined> {
    const appDir = resolveAppDist()
    if (!appDir) return undefined
    const filePath = path.resolve(appDir, "." + (reqPath === "/" ? "/index.html" : reqPath))
    const relative = path.relative(appDir, filePath)
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("Offline web asset path leaves the bundled app directory.")
    }
    const file = Bun.file(filePath)
    if (await file.exists()) return { body: file, mime: Filesystem.mimeType(filePath) }
    // SPA fallback: serve index.html for client-side routes
    const index = Bun.file(path.join(appDir, "index.html"))
    if (await index.exists()) return { body: index, mime: "text/html; charset=utf-8" }
    return undefined
  }
}
