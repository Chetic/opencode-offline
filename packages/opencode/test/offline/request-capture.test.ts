// offline-fork: request capture behind the TUI /curl command
import { describe, expect, test } from "bun:test"
import { RequestCapture } from "../../src/offline/request-capture"

describe("RequestCapture", () => {
  test("captures requests tagged with a session id", () => {
    RequestCapture.capture("http://127.0.0.1:1234/v1/chat/completions", {
      method: "POST",
      headers: { "x-opencode-session-id": "ses_capture", Authorization: "Bearer key" },
      body: JSON.stringify({ model: "qwen" }),
    })
    const request = RequestCapture.get("ses_capture")
    expect(request?.url).toBe("http://127.0.0.1:1234/v1/chat/completions")
    expect(request?.method).toBe("POST")
    expect(request?.headers["authorization"]).toBe("Bearer key")
    expect(request?.body).toBe('{"model":"qwen"}')
  })

  test("reads headers from Request objects", () => {
    RequestCapture.capture(
      new Request("http://127.0.0.1:1234/v1/models", { headers: { "x-opencode-session-id": "ses_request" } }),
    )
    expect(RequestCapture.get("ses_request")?.method).toBe("GET")
  })

  test("ignores requests without a session id", () => {
    RequestCapture.capture("http://127.0.0.1:1234/v1/models", { headers: { "x-other": "ses_none" } })
    expect(RequestCapture.get("ses_none")).toBeUndefined()
  })

  test("renders a curl script reading the body from $1", () => {
    const script = RequestCapture.script({
      sessionID: "ses_curl",
      timestamp: 1,
      url: "http://127.0.0.1:1234/v1/chat/completions",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10", "x-quote": "it's" },
      body: "{}",
    })
    expect(script).toStartWith("#!/bin/sh")
    expect(script).toContain("curl -X POST 'http://127.0.0.1:1234/v1/chat/completions'")
    expect(script).toContain("-H 'content-type: application/json'")
    expect(script).toContain(`-H 'x-quote: it'\\''s'`)
    expect(script).not.toContain("content-length")
    expect(script).toContain(`-d @"$1"`)
  })
})
