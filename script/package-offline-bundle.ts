#!/usr/bin/env bun

// offline-fork: builds opencode for linux-x64 and packages it with dist/offline-deps
// into a self-contained bundle (dist/opencode-offline-linux-x64[.tar.gz]).

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"

const DEPS = "dist/offline-deps"
const BUNDLE = "dist/opencode-offline-linux-x64"
const TARBALL = "opencode-offline-linux-x64.tar.gz"

if (!(await fs.stat(DEPS).catch(() => undefined))) {
  console.error(`Error: Dependencies not found at ${DEPS}`)
  console.error("Please run 'bun run script/download-offline-deps.ts' first")
  process.exit(1)
}

const upstream = (await Bun.file("packages/opencode/package.json").json()).version as string
const bundle = process.env.BUNDLE_VERSION ?? "dev"
const sha = process.env.BUNDLE_COMMIT_SHA ?? (await $`git rev-parse --short=7 HEAD`.nothrow().text()).trim()
// Shown by `opencode --version` and in the TUI, e.g. 1.18.35-offline.12+abc1234.
// A non-0.0.0 version also selects the "latest" channel, so data lives in the standard opencode.db.
const version = `${upstream}-offline.${bundle}${sha ? `+${sha}` : ""}`

console.log(`\n=== Building opencode ${version} for linux-x64 ===`)
await $`bun run ./script/build.ts --single`.cwd("packages/opencode").env({
  ...process.env,
  OPENCODE_VERSION: version,
  // Build-time models snapshot matches the bundled models.json
  MODELS_DEV_API_JSON: path.resolve(DEPS, "models.json"),
})

console.log("\n=== Creating bundle ===")
await fs.rm(BUNDLE, { recursive: true, force: true })
await fs.mkdir(path.join(BUNDLE, "bin"), { recursive: true })
await fs.copyFile("packages/opencode/dist/opencode-linux-x64/bin/opencode", path.join(BUNDLE, "bin", "opencode"))
await fs.chmod(path.join(BUNDLE, "bin", "opencode"), 0o755)
await $`cp -r ${DEPS} ${path.join(BUNDLE, "deps")}`

const manifest = await Bun.file(path.join(DEPS, "manifest.json")).json()
await Bun.write(
  path.join(BUNDLE, "manifest.json"),
  JSON.stringify({ ...manifest, opencode: upstream, bundleVersion: bundle, commitSha: sha, version }, null, 2),
)

await Bun.write(
  path.join(BUNDLE, "opencode-offline"),
  `#!/bin/bash
# OpenCode Offline wrapper: configures offline mode and runs the bundled opencode binary.

ROOT="$(cd "$(dirname "$(readlink -f "\${BASH_SOURCE[0]}")")" && pwd)"
DEPS="$ROOT/deps"

export OPENCODE_OFFLINE_MODE=true
export OPENCODE_OFFLINE_DEPS_PATH="$DEPS"
export OPENCODE_DISABLE_AUTOUPDATE=true
export OPENCODE_DISABLE_LSP_DOWNLOAD=true
export OPENCODE_DISABLE_MODELS_FETCH=true
export OPENCODE_MODELS_PATH="\${OPENCODE_MODELS_PATH:-$DEPS/models.json}"
# Bundled tools are a fallback: binaries already installed on the system take precedence.
export PATH="$PATH:$DEPS/bin:$DEPS/ripgrep:$DEPS/lsp/clangd/bin:$DEPS/lsp/rust-analyzer/bin"

# Native libraries embedded in the binary are extracted before loading. The default is /tmp,
# which hardened hosts mount noexec, so extract into the user's cache instead.
export BUN_TMPDIR="\${BUN_TMPDIR:-\${XDG_CACHE_HOME:-$HOME/.cache}/opencode/native}"
mkdir -p "$BUN_TMPDIR" && find "$BUN_TMPDIR" -maxdepth 1 -name '.*.so' -mmin +1440 -delete 2>/dev/null

exec "$ROOT/bin/opencode" "$@"
`,
)
await fs.chmod(path.join(BUNDLE, "opencode-offline"), 0o755)

await Bun.write(
  path.join(BUNDLE, "README.md"),
  `# OpenCode Offline Bundle (${version})

Self-contained offline bundle of OpenCode for Linux x64 (RHEL9 compatible). No outbound network access is needed.

## Contents

- \`opencode-offline\` - Wrapper script that sets up the offline environment (use this)
- \`bin/opencode\` - OpenCode binary (web UI embedded)
- \`deps/\` - Pre-bundled dependencies
  - \`ripgrep/\` - ripgrep for file search
  - \`lsp/\` - clangd and rust-analyzer
  - \`node_modules/\` - pyright, typescript, typescript-language-server
  - \`bin/\` - shims running the npm language servers on the bundled runtime (no node needed)
  - \`models.json\` - Model definitions snapshot
- \`manifest.json\` - Versions of all bundled components

## Usage

\`\`\`bash
./opencode-offline              # terminal UI
./opencode-offline web          # web UI, served locally from the binary
./opencode-offline run "hello"  # non-interactive
\`\`\`

The wrapper can be symlinked onto your PATH, e.g. \`ln -s $PWD/opencode-offline ~/.local/bin/opencode\`.

## Local models

Point OpenCode at an OpenAI-compatible server (LM Studio, Ollama, vLLM, ...) in \`~/.config/opencode/opencode.json\`:

\`\`\`json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio",
      "options": { "baseURL": "http://127.0.0.1:1234/v1" },
      "models": { "qwen/qwen3-coder-30b": { "name": "Qwen3 Coder 30B" } }
    }
  }
}
\`\`\`

## Supported languages

- **Python** - Pyright
- **TypeScript/JavaScript** - typescript-language-server (uses the project's typescript, or the bundled one)
- **C/C++** - clangd
- **Rust** - rust-analyzer

## Environment variables (set by the wrapper)

- \`OPENCODE_OFFLINE_MODE\` / \`OPENCODE_OFFLINE_DEPS_PATH\` - enable offline mode and locate \`deps/\`
- \`OPENCODE_DISABLE_AUTOUPDATE\`, \`OPENCODE_DISABLE_LSP_DOWNLOAD\`, \`OPENCODE_DISABLE_MODELS_FETCH\` - no network access
- \`OPENCODE_MODELS_PATH\` - model definitions file (defaults to \`deps/models.json\`)
- \`BUN_TMPDIR\` - where embedded native libraries are extracted (defaults to \`~/.cache/opencode/native\`, so a noexec /tmp works)

Bundled language servers are enabled by default. Set \`"lsp": false\` in your config to disable them.

## Debugging

Inside a session, \`/curl\` writes the last LLM request to \`~/.opencode/debug/\` as a reusable curl script.
`,
)

console.log("\n=== Creating tarball ===")
await fs.rm(path.join("dist", TARBALL), { force: true })
await $`tar -czf ${TARBALL} opencode-offline-linux-x64`.cwd("dist")
const size = (await fs.stat(path.join("dist", TARBALL))).size / (1024 * 1024)
console.log(`Tarball: dist/${TARBALL} (${size.toFixed(2)} MB)`)
console.log(`Bundle directory: ${BUNDLE}`)
