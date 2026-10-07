export * as Offline from "./offline"

// offline-fork: resolves dependencies shipped in the offline bundle's deps/ directory.
// The bundle layout is produced by script/download-offline-deps.ts and
// script/package-offline-bundle.ts; the opencode-offline wrapper sets the env vars.

import path from "path"
import { existsSync } from "fs"
import { truthy } from "./flag/flag"

export function deps() {
  if (!truthy("OPENCODE_OFFLINE_MODE")) return
  return process.env["OPENCODE_OFFLINE_DEPS_PATH"]
}

function find(...parts: string[]) {
  const root = deps()
  if (!root) return
  const file = path.join(root, ...parts)
  if (existsSync(file)) return file
}

// Executable shim for a bundled npm binary. Shims run on the opencode binary
// itself (BUN_BE_BUN=1) so the target machine does not need node installed.
export function bin(name: string) {
  return find("bin", name)
}

export function pkg(name: string) {
  return find("node_modules", name)
}

export function tsserver() {
  return find("node_modules", "typescript", "lib", "tsserver.js")
}

// Bundled language servers are enabled unless the config explicitly sets `lsp`.
export function lsp<T extends { lsp?: unknown }>(cfg: T): T {
  if (!deps() || cfg.lsp !== undefined) return cfg
  return { ...cfg, lsp: true }
}
