import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Server } from "../../src/server/server"
import { ReadTool } from "../../src/tool/read"
import { tmpdir } from "../fixture/fixture"

const fixture = path.join(import.meta.dir, "fixtures", "white-1x1.avif")
const avif = {
  type: "file" as const,
  mime: "image/avif",
  filename: "white.avif",
  url: `data:image/avif;base64,${readFileSync(fixture).toString("base64")}`,
}
const config = { agent: { build: { model: "openai/gpt-5.2" } } }

describe("image ingress", () => {
  test("normalizes API image parts before persisting and preserves other parts", async () => {
    await using tmp = await tmpdir({ git: true, config })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "before" }, avif, { type: "text", text: "after" }],
        })
        expect(result.parts.map((part) => part.type)).toEqual(["text", "file", "text"])
        expect(result.parts[1]).toMatchObject({ mime: "image/png", filename: "white.avif" })
        const stored = await Session.messages({ sessionID: session.id })
        expect(stored).toHaveLength(1)
        expect(stored[0].parts[1]).toMatchObject({ mime: "image/png" })
        await Session.remove(session.id)
      },
    })
  })

  test("returns a specific HTTP 400 before headers and does not persist invalid images", async () => {
    await using tmp = await tmpdir({ git: true, config })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.App()
        const url = `http://localhost/session/${session.id}/message?directory=${encodeURIComponent(tmp.path)}`
        const response = await app.request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ noReply: true, parts: [{ ...avif, url: "data:image/avif;base64,AAAA" }] }),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ name: "ImageInputError", data: { kind: "format" } })
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        const accepted = await app.request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ noReply: true, parts: [avif] }),
        })
        expect(accepted.status).toBe(200)
        expect((await accepted.json()).parts[0]).toMatchObject({ mime: "image/png" })
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
        await Session.remove(session.id)
      },
    })
  })

  test("read tool returns converted image bytes and rejects corrupted images", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "valid.avif"), readFileSync(fixture))
        await Bun.write(path.join(dir, "bad.avif"), "bad image")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadTool.init()
        const ctx = {
          sessionID: "test",
          messageID: "",
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const result = await tool.execute({ filePath: path.join(tmp.path, "valid.avif") }, ctx)
        expect(result.attachments?.[0]).toMatchObject({ mime: "image/png" })
        expect(result.attachments?.[0].url).toStartWith("data:image/png;base64,")
        await expect(tool.execute({ filePath: path.join(tmp.path, "bad.avif") }, ctx)).rejects.toThrow("supported")
      },
    })
  })
})
