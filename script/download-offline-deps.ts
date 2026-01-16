#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"

const DEPS_DIR = "dist/offline-deps"
const RIPGREP_VERSION = "14.1.1"

interface Manifest {
  version: string
  created: string
  platform: string
  arch: string
  components: {
    ripgrep: string
    clangd: string
    rustAnalyzer: string
    npmPackages: Record<string, string>
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`Downloading ${url}...`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  const buffer = await response.arrayBuffer()
  await Bun.write(dest, buffer)
  console.log(`Downloaded to ${dest}`)
}

async function extractTarGz(archivePath: string, destDir: string, stripComponents = 0): Promise<void> {
  const args = ["tar", "-xzf", archivePath, "-C", destDir]
  if (stripComponents > 0) {
    args.push(`--strip-components=${stripComponents}`)
  }
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`Failed to extract ${archivePath}`)
  }
}

async function extractZip(archivePath: string, destDir: string): Promise<void> {
  const proc = Bun.spawn(["unzip", "-o", "-q", archivePath, "-d", destDir], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    const stderr = await Bun.readableStreamToText(proc.stderr)
    throw new Error(`Failed to extract ${archivePath}: ${stderr}`)
  }
}

async function downloadRipgrep(): Promise<string> {
  console.log("\n=== Downloading ripgrep ===")
  const platform = "x86_64-unknown-linux-musl"
  const filename = `ripgrep-${RIPGREP_VERSION}-${platform}.tar.gz`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${filename}`

  const ripgrepDir = path.join(DEPS_DIR, "ripgrep")
  await fs.mkdir(ripgrepDir, { recursive: true })

  const archivePath = path.join(DEPS_DIR, filename)
  await downloadFile(url, archivePath)

  // Extract ripgrep binary
  await extractTarGz(archivePath, ripgrepDir, 1)
  await fs.unlink(archivePath)

  // Make binary executable
  await fs.chmod(path.join(ripgrepDir, "rg"), 0o755)

  console.log("Ripgrep downloaded successfully")
  return RIPGREP_VERSION
}

async function downloadClangd(): Promise<string> {
  console.log("\n=== Downloading clangd ===")

  // Fetch latest release info
  const releaseResponse = await fetch("https://api.github.com/repos/clangd/clangd/releases/latest")
  if (!releaseResponse.ok) {
    throw new Error("Failed to fetch clangd release info")
  }
  const release = await releaseResponse.json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
  const tag = release.tag_name

  // Find Linux asset
  const asset = release.assets.find(a => a.name.includes("linux") && a.name.includes(tag) && a.name.endsWith(".zip"))
  if (!asset) {
    throw new Error("Could not find clangd Linux asset")
  }

  const clangdDir = path.join(DEPS_DIR, "lsp", "clangd")
  await fs.mkdir(clangdDir, { recursive: true })

  const archivePath = path.join(DEPS_DIR, asset.name)
  await downloadFile(asset.browser_download_url, archivePath)

  // Extract clangd
  await extractZip(archivePath, path.join(DEPS_DIR, "lsp"))
  await fs.unlink(archivePath)

  // The extracted directory is clangd_<version>, rename to clangd
  const extractedDir = path.join(DEPS_DIR, "lsp", `clangd_${tag}`)
  const finalDir = path.join(DEPS_DIR, "lsp", "clangd")

  // Remove existing clangd dir if it exists (we created it above)
  await fs.rm(finalDir, { recursive: true, force: true })
  await fs.rename(extractedDir, finalDir)

  // Make binary executable
  await fs.chmod(path.join(finalDir, "bin", "clangd"), 0o755)

  console.log(`Clangd ${tag} downloaded successfully`)
  return tag
}

async function downloadRustAnalyzer(): Promise<string> {
  console.log("\n=== Downloading rust-analyzer ===")

  // Fetch latest release info
  const releaseResponse = await fetch("https://api.github.com/repos/rust-lang/rust-analyzer/releases/latest")
  if (!releaseResponse.ok) {
    throw new Error("Failed to fetch rust-analyzer release info")
  }
  const release = await releaseResponse.json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
  const tag = release.tag_name

  // Find Linux x64 asset
  const asset = release.assets.find(a => a.name === "rust-analyzer-x86_64-unknown-linux-gnu.gz")
  if (!asset) {
    throw new Error("Could not find rust-analyzer Linux asset")
  }

  const raDir = path.join(DEPS_DIR, "lsp", "rust-analyzer", "bin")
  await fs.mkdir(raDir, { recursive: true })

  const archivePath = path.join(DEPS_DIR, "rust-analyzer.gz")
  await downloadFile(asset.browser_download_url, archivePath)

  // Extract rust-analyzer (it's a gzipped binary)
  const proc = Bun.spawn(["gunzip", "-c", archivePath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const binaryData = await Bun.readableStreamToArrayBuffer(proc.stdout)
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error("Failed to extract rust-analyzer")
  }

  const binaryPath = path.join(raDir, "rust-analyzer")
  await Bun.write(binaryPath, binaryData)
  await fs.chmod(binaryPath, 0o755)

  await fs.unlink(archivePath)

  console.log(`rust-analyzer ${tag} downloaded successfully`)
  return tag
}

async function installNpmPackages(): Promise<Record<string, string>> {
  console.log("\n=== Installing npm packages ===")

  const nodeModulesDir = path.join(DEPS_DIR, "node_modules")
  await fs.mkdir(nodeModulesDir, { recursive: true })

  const packages = [
    "pyright",
    "typescript",
    "typescript-language-server",
    "opencode-anthropic-auth@0.0.9",
    "@gitlab/opencode-gitlab-auth@1.3.0",
    "@aws-sdk/credential-providers",
    "@opencode-ai/plugin",
  ]

  // Create a temporary package.json for installation
  const pkgJsonPath = path.join(DEPS_DIR, "package.json")
  await Bun.write(pkgJsonPath, JSON.stringify({ dependencies: {} }, null, 2))

  // Install packages
  const installCmd = ["bun", "add", "--cwd", DEPS_DIR, ...packages]
  console.log(`Running: ${installCmd.join(" ")}`)

  const proc = Bun.spawn(installCmd, {
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error("Failed to install npm packages")
  }

  // Read installed versions
  const versions: Record<string, string> = {}
  const pkgJson = await Bun.file(pkgJsonPath).json()

  for (const [pkg, version] of Object.entries(pkgJson.dependencies || {})) {
    versions[pkg] = version as string
  }

  console.log("npm packages installed successfully")
  return versions
}

async function createManifest(
  ripgrepVersion: string,
  clangdVersion: string,
  rustAnalyzerVersion: string,
  npmVersions: Record<string, string>
): Promise<void> {
  console.log("\n=== Creating manifest ===")

  const manifest: Manifest = {
    version: "1.0.0",
    created: new Date().toISOString(),
    platform: "linux",
    arch: "x64",
    components: {
      ripgrep: ripgrepVersion,
      clangd: clangdVersion,
      rustAnalyzer: rustAnalyzerVersion,
      npmPackages: npmVersions,
    },
  }

  await Bun.write(
    path.join(DEPS_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  )

  console.log("Manifest created")
}

async function main() {
  console.log("=== OpenCode Offline Dependencies Downloader ===")
  console.log(`Target directory: ${DEPS_DIR}`)

  // Clean and create deps directory
  await fs.rm(DEPS_DIR, { recursive: true, force: true })
  await fs.mkdir(DEPS_DIR, { recursive: true })

  // Download all dependencies
  const ripgrepVersion = await downloadRipgrep()
  const clangdVersion = await downloadClangd()
  const rustAnalyzerVersion = await downloadRustAnalyzer()
  const npmVersions = await installNpmPackages()

  // Create manifest
  await createManifest(ripgrepVersion, clangdVersion, rustAnalyzerVersion, npmVersions)

  console.log("\n=== Download complete ===")
  console.log(`Dependencies saved to: ${DEPS_DIR}`)
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
