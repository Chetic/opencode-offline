#!/usr/bin/env bun

// offline-fork: downloads everything the offline bundle needs at runtime into dist/offline-deps.
//
// Layout (consumed by packages/core/src/offline.ts and the opencode-offline wrapper):
//   ripgrep/rg                     ripgrep binary (found via PATH)
//   lsp/clangd/bin/clangd          clangd (found via PATH)
//   lsp/rust-analyzer/bin/...      rust-analyzer (found via PATH)
//   node_modules/                  npm LSP packages (pyright, typescript, typescript-language-server)
//   bin/                           shims running npm binaries on the opencode binary's Bun runtime
//   models.json                    models.dev snapshot (OPENCODE_MODELS_PATH)
//
// The web UI no longer needs bundling: upstream embeds it into the opencode binary at build time.

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"

const DEPS = "dist/offline-deps"
// Keep in sync with RipgrepBinary.VERSION in packages/core/src/ripgrep/binary.ts
const RIPGREP = "15.1.0"
// typescript 7+ is the native (Go) port without lib/tsserver.js, which typescript-language-server needs
const PACKAGES = ["pyright", "typescript@6", "typescript-language-server"]
// npm packages whose binaries get a shim in deps/bin
const SHIMS = ["pyright", "typescript-language-server"]

type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] }

async function download(url: string, dest: string) {
  console.log(`Downloading ${url}...`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  await Bun.write(dest, await response.arrayBuffer())
}

async function release(repo: string): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
  })
  if (!response.ok) throw new Error(`Failed to fetch ${repo} release info: ${response.status}`)
  return response.json() as Promise<Release>
}

async function ripgrep() {
  console.log("\n=== ripgrep ===")
  const name = `ripgrep-${RIPGREP}-x86_64-unknown-linux-musl.tar.gz`
  const dir = path.join(DEPS, "ripgrep")
  const archive = path.join(DEPS, name)
  await fs.mkdir(dir, { recursive: true })
  await download(`https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP}/${name}`, archive)
  await $`tar -xzf ${archive} -C ${dir} --strip-components=1`
  await fs.unlink(archive)
  await fs.chmod(path.join(dir, "rg"), 0o755)
  return RIPGREP
}

async function clangd() {
  console.log("\n=== clangd ===")
  const info = await release("clangd/clangd")
  const asset = info.assets.find((a) => a.name.startsWith("clangd-linux-") && a.name.endsWith(".zip"))
  if (!asset) throw new Error("Could not find clangd Linux asset")
  const lsp = path.join(DEPS, "lsp")
  const archive = path.join(DEPS, asset.name)
  await fs.mkdir(lsp, { recursive: true })
  await download(asset.browser_download_url, archive)
  await $`unzip -o -q ${archive} -d ${lsp}`
  await fs.unlink(archive)
  await fs.rm(path.join(lsp, "clangd"), { recursive: true, force: true })
  await fs.rename(path.join(lsp, `clangd_${info.tag_name}`), path.join(lsp, "clangd"))
  await fs.chmod(path.join(lsp, "clangd", "bin", "clangd"), 0o755)
  return info.tag_name
}

async function rustAnalyzer() {
  console.log("\n=== rust-analyzer ===")
  const info = await release("rust-lang/rust-analyzer")
  const asset = info.assets.find((a) => a.name === "rust-analyzer-x86_64-unknown-linux-gnu.gz")
  if (!asset) throw new Error("Could not find rust-analyzer Linux asset")
  const dir = path.join(DEPS, "lsp", "rust-analyzer", "bin")
  const archive = path.join(DEPS, "rust-analyzer.gz")
  await fs.mkdir(dir, { recursive: true })
  await download(asset.browser_download_url, archive)
  await $`gunzip -c ${archive} > ${path.join(dir, "rust-analyzer")}`
  await fs.unlink(archive)
  await fs.chmod(path.join(dir, "rust-analyzer"), 0o755)
  return info.tag_name
}

async function packages() {
  console.log("\n=== npm packages ===")
  await Bun.write(path.join(DEPS, "package.json"), JSON.stringify({ dependencies: {} }, null, 2))
  await $`bun add --cwd ${DEPS} ${PACKAGES}`
  const pkg = await Bun.file(path.join(DEPS, "package.json")).json()
  return pkg.dependencies as Record<string, string>
}

// Shims let LSP servers run without node: the opencode binary acts as bun when BUN_BE_BUN=1.
// The bundle layout is <root>/bin/opencode and <root>/deps/bin/<shim>.
async function shims() {
  console.log("\n=== binary shims ===")
  const dir = path.join(DEPS, "bin")
  await fs.mkdir(dir, { recursive: true })
  for (const name of SHIMS) {
    const pkg = await Bun.file(path.join(DEPS, "node_modules", name, "package.json")).json()
    const bins: Record<string, string> = typeof pkg.bin === "string" ? { [name]: pkg.bin } : pkg.bin
    for (const [bin, target] of Object.entries(bins)) {
      const file = path.join(dir, bin)
      await Bun.write(
        file,
        `#!/bin/sh
# offline-fork: runs ${name}'s ${bin} on the bundled opencode binary's Bun runtime
DEPS="$(cd "$(dirname "$0")/.." && pwd)"
BUN_BE_BUN=1 exec "$DEPS/../bin/opencode" "$DEPS/node_modules/${name}/${path.posix.normalize(target)}" "$@"
`,
      )
      await fs.chmod(file, 0o755)
      console.log(`Created shim ${file}`)
    }
  }
}

async function models() {
  console.log("\n=== models.json ===")
  await download(`${process.env.OPENCODE_MODELS_URL || "https://models.dev"}/api.json`, path.join(DEPS, "models.json"))
}

console.log("=== OpenCode Offline Dependencies Downloader ===")
await fs.rm(DEPS, { recursive: true, force: true })
await fs.mkdir(DEPS, { recursive: true })

const manifest = {
  version: "2.0.0",
  created: new Date().toISOString(),
  platform: "linux",
  arch: "x64",
  components: {
    ripgrep: await ripgrep(),
    clangd: await clangd(),
    rustAnalyzer: await rustAnalyzer(),
    npmPackages: await packages(),
  },
}
await shims()
await models()
await Bun.write(path.join(DEPS, "manifest.json"), JSON.stringify(manifest, null, 2))

console.log(`\n=== Download complete: ${DEPS} ===`)
