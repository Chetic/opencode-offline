// offline-fork: offline dependency resolution and the Npm guards that use it
import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { Offline } from "@opencode-ai/core/offline"
import { tmpdir } from "./fixture/tmpdir"

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

async function deps(dir: string) {
  const root = path.join(dir, "deps")
  await fs.mkdir(path.join(root, "bin"), { recursive: true })
  await Bun.write(path.join(root, "bin", "pyright-langserver"), "#!/bin/sh\n")
  await Bun.write(path.join(root, "bin", "typescript-language-server"), "#!/bin/sh\n")
  await Bun.write(path.join(root, "node_modules", "typescript", "lib", "tsserver.js"), "")
  await Bun.write(
    path.join(root, "node_modules", "offline-provider", "package.json"),
    JSON.stringify({ name: "offline-provider", version: "1.0.0", main: "index.js" }),
  )
  await Bun.write(path.join(root, "node_modules", "offline-provider", "index.js"), "export const offline = true\n")
  return root
}

function enable(root: string) {
  process.env["OPENCODE_OFFLINE_MODE"] = "true"
  process.env["OPENCODE_OFFLINE_DEPS_PATH"] = root
}

afterEach(() => {
  delete process.env["OPENCODE_OFFLINE_MODE"]
  delete process.env["OPENCODE_OFFLINE_DEPS_PATH"]
})

describe("Offline", () => {
  test("resolves nothing when offline mode is disabled", async () => {
    await using tmp = await tmpdir()
    const root = await deps(tmp.path)
    process.env["OPENCODE_OFFLINE_DEPS_PATH"] = root
    expect(Offline.deps()).toBeUndefined()
    expect(Offline.bin("pyright-langserver")).toBeUndefined()
    expect(Offline.tsserver()).toBeUndefined()
  })

  test("resolves bundled files that exist", async () => {
    await using tmp = await tmpdir()
    const root = await deps(tmp.path)
    enable(root)
    expect(Offline.deps()).toBe(root)
    expect(Offline.bin("pyright-langserver")).toBe(path.join(root, "bin", "pyright-langserver"))
    expect(Offline.bin("clangd")).toBeUndefined()
    expect(Offline.pkg("offline-provider")).toBe(path.join(root, "node_modules", "offline-provider"))
    expect(Offline.tsserver()).toBe(path.join(root, "node_modules", "typescript", "lib", "tsserver.js"))
  })
})

describe("Npm in offline mode", () => {
  test("which returns the bundled shim without installing", async () => {
    await using tmp = await tmpdir()
    const root = await deps(tmp.path)
    enable(root)
    const result = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return {
        ts: yield* npm.which("typescript-language-server"),
        pyright: yield* npm.which("pyright", "pyright-langserver"),
      }
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)
    expect(result.ts).toBe(path.join(root, "bin", "typescript-language-server"))
    expect(result.pyright).toBe(path.join(root, "bin", "pyright-langserver"))
  })

  test("add resolves bundled packages without installing", async () => {
    await using tmp = await tmpdir()
    const root = await deps(tmp.path)
    enable(root)
    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add("offline-provider@1.0.0")
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)
    expect(entry.directory).toBe(path.join(root, "node_modules", "offline-provider"))
    expect(entry.entrypoint).toContain("offline-provider/index.js")
    expect(await Bun.file(path.join(tmp.path, "cache", "packages")).exists()).toBe(false)
  })

  test("install is skipped", async () => {
    await using tmp = await tmpdir()
    enable(await deps(tmp.path))
    const dir = path.join(tmp.path, "project")
    await fs.mkdir(dir)
    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      yield* npm.install(dir, { add: [{ name: "@opencode-ai/plugin" }] })
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)
    expect(await fs.readdir(dir)).toEqual([])
  })
})
