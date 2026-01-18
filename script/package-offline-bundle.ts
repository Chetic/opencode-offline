#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"

const DEPS_DIR = "dist/offline-deps"
const BUNDLE_DIR = "dist/opencode-offline-linux-x64"
const TARBALL_NAME = "opencode-offline-linux-x64.tar.gz"

async function buildOpencode(): Promise<string> {
  console.log("\n=== Building opencode for Linux x64 ===")

  // Install dependencies in packages/opencode first
  console.log("Installing dependencies...")
  const installProc = Bun.spawn(["bun", "install"], {
    cwd: "packages/opencode",
    stdout: "inherit",
    stderr: "inherit",
  })
  await installProc.exited
  if (installProc.exitCode !== 0) {
    throw new Error("Failed to install dependencies")
  }

  // Use the existing build script
  const proc = Bun.spawn(["bun", "run", "./script/build.ts"], {
    cwd: "packages/opencode",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
    },
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error("Failed to build opencode")
  }

  // Find the linux-x64 binary
  const distDir = "packages/opencode/dist"
  const entries = await fs.readdir(distDir)
  const linuxX64Dir = entries.find(e => e.includes("linux") && e.includes("x64") && !e.includes("baseline") && !e.includes("musl"))

  if (!linuxX64Dir) {
    throw new Error("Could not find linux-x64 build output")
  }

  console.log(`Build complete: ${linuxX64Dir}`)
  return path.join(distDir, linuxX64Dir)
}

async function createBundle(buildDir: string): Promise<void> {
  console.log("\n=== Creating bundle structure ===")

  // Clean and create bundle directory
  await fs.rm(BUNDLE_DIR, { recursive: true, force: true })
  await fs.mkdir(path.join(BUNDLE_DIR, "bin"), { recursive: true })
  await fs.mkdir(path.join(BUNDLE_DIR, "deps"), { recursive: true })

  // Copy opencode binary
  console.log("Copying opencode binary...")
  const binaryPath = path.join(buildDir, "bin", "opencode")
  await fs.copyFile(binaryPath, path.join(BUNDLE_DIR, "bin", "opencode"))
  await fs.chmod(path.join(BUNDLE_DIR, "bin", "opencode"), 0o755)

  // Copy deps
  console.log("Copying dependencies...")
  await $`cp -r ${DEPS_DIR}/* ${path.join(BUNDLE_DIR, "deps")}/`

  // Copy OpenTUI native library
  console.log("Copying OpenTUI native library...")
  const opentuiSoPath = "node_modules/.bun/@opentui+core-linux-x64@0.1.74/node_modules/@opentui/core-linux-x64/libopentui.so"
  await fs.mkdir(path.join(BUNDLE_DIR, "deps", "opentui"), { recursive: true })
  await fs.copyFile(opentuiSoPath, path.join(BUNDLE_DIR, "deps", "opentui", "libopentui.so"))

  // Copy manifest to root and inject version info
  const manifestContent = await fs.readFile(path.join(DEPS_DIR, "manifest.json"), "utf-8")
  const manifest = JSON.parse(manifestContent)

  // Inject bundle version and commit SHA from environment
  const bundleVersion = process.env.BUNDLE_VERSION
  const commitSha = process.env.BUNDLE_COMMIT_SHA
  if (bundleVersion) {
    manifest.bundleVersion = bundleVersion
    console.log(`Injecting bundleVersion: ${bundleVersion}`)
  }
  if (commitSha) {
    manifest.commitSha = commitSha
    console.log(`Injecting commitSha: ${commitSha}`)
  }

  await Bun.write(path.join(BUNDLE_DIR, "manifest.json"), JSON.stringify(manifest, null, 2))

  console.log("Bundle structure created")
}

async function createWrapperScript(): Promise<void> {
  console.log("\n=== Creating wrapper script ===")

  const wrapperScript = `#!/bin/bash
# OpenCode Offline Wrapper Script
# Sets up environment variables for offline mode and runs opencode

SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

export OPENCODE_OFFLINE_MODE=true
export OPENCODE_OFFLINE_DEPS_PATH="\$SCRIPT_DIR/deps"
export OPENCODE_DISABLE_AUTOUPDATE=true
export OPENCODE_DISABLE_LSP_DOWNLOAD=true
export OPENCODE_DISABLE_MODELS_FETCH=true

exec "\$SCRIPT_DIR/bin/opencode" "\$@"
`

  await Bun.write(path.join(BUNDLE_DIR, "opencode-offline"), wrapperScript)
  await fs.chmod(path.join(BUNDLE_DIR, "opencode-offline"), 0o755)

  console.log("Wrapper script created")
}

async function createReadme(): Promise<void> {
  console.log("\n=== Creating README ===")

  const readme = `# OpenCode Offline Bundle

This is a self-contained offline bundle of OpenCode for Linux x64 (RHEL9 compatible).

## Contents

- \`bin/opencode\` - Main OpenCode binary
- \`deps/\` - Pre-bundled dependencies
  - \`ripgrep/\` - Ripgrep binary for fast file searching
  - \`lsp/\` - Language server binaries (clangd, rust-analyzer)
  - \`node_modules/\` - npm packages (pyright, typescript, etc.)
- \`manifest.json\` - Version information for all bundled components
- \`opencode-offline\` - Wrapper script that sets up the environment

## Usage

### Option 1: Use the wrapper script (recommended)

\`\`\`bash
./opencode-offline
\`\`\`

### Option 2: Set environment variables manually

\`\`\`bash
export OPENCODE_OFFLINE_MODE=true
export OPENCODE_OFFLINE_DEPS_PATH=/path/to/deps
./bin/opencode
\`\`\`

## Supported Languages

This bundle includes LSP support for:
- **Python** - via Pyright
- **TypeScript/JavaScript** - via typescript-language-server
- **C/C++** - via clangd
- **Rust** - via rust-analyzer

## Environment Variables

- \`OPENCODE_OFFLINE_MODE\` - Set to \`true\` to enable offline mode
- \`OPENCODE_OFFLINE_DEPS_PATH\` - Path to the deps directory
- \`OPENCODE_DISABLE_AUTOUPDATE\` - Set to \`true\` to disable auto-updates
- \`OPENCODE_DISABLE_LSP_DOWNLOAD\` - Set to \`true\` to prevent LSP downloads
- \`OPENCODE_DISABLE_MODELS_FETCH\` - Set to \`true\` to prevent fetching models from models.dev

## Troubleshooting

### /tmp mounted with noexec
This bundle includes a pre-extracted OpenTUI native library in \`deps/opentui/\`.
When \`OPENCODE_OFFLINE_DEPS_PATH\` is set (done automatically by the wrapper script),
the application will load this library directly, bypassing the /tmp extraction
that would otherwise fail on systems with noexec /tmp.
`

  await Bun.write(path.join(BUNDLE_DIR, "README.md"), readme)

  console.log("README created")
}

async function createTarball(): Promise<void> {
  console.log("\n=== Creating tarball ===")

  const tarballPath = path.join("dist", TARBALL_NAME)

  // Remove existing tarball
  await fs.unlink(tarballPath).catch(() => {})

  // Create tarball
  const proc = Bun.spawn(
    ["tar", "-czf", TARBALL_NAME, "opencode-offline-linux-x64"],
    {
      cwd: "dist",
      stdout: "inherit",
      stderr: "inherit",
    }
  )
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error("Failed to create tarball")
  }

  // Get tarball size
  const stats = await fs.stat(tarballPath)
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)

  console.log(`Tarball created: ${tarballPath} (${sizeMB} MB)`)
}

async function main() {
  console.log("=== OpenCode Offline Bundle Packager ===")

  // Check if deps exist
  const depsExist = await fs.stat(DEPS_DIR).catch(() => null)
  if (!depsExist) {
    console.error(`Error: Dependencies not found at ${DEPS_DIR}`)
    console.error("Please run 'bun run script/download-offline-deps.ts' first")
    process.exit(1)
  }

  const buildDir = await buildOpencode()
  await createBundle(buildDir)
  await createWrapperScript()
  await createReadme()
  await createTarball()

  console.log("\n=== Packaging complete ===")
  console.log(`Bundle directory: ${BUNDLE_DIR}`)
  console.log(`Tarball: dist/${TARBALL_NAME}`)
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
