import path from "path"
import { Flag } from "../flag/flag"

export namespace Offline {
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
}
