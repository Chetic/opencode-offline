// Exercises the actual deployment guard with two owned, temporary loopback servers.

process.env.OPENCODE_OFFLINE_MODE = "true"
const guard = await import("../../src/offline/network.ts")

const checks: Record<string, unknown>[] = []
const hits: string[] = []
let sinkHits = 0
const sink = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    sinkHits += 1
    return new Response("redirect destination must not be contacted")
  },
})
const source = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const route = new URL(request.url).pathname
    hits.push(route)
    if (route === "/redirect-local") return Response.redirect(`http://127.0.0.1:${sink.port}/sink`)
    if (route === "/redirect-external") return Response.redirect("https://example.invalid/guard-test")
    return Response.json({ marker: "LOCAL_ONLY", method: request.method, route })
  },
})
const base = `http://127.0.0.1:${source.port}`
const report: Record<string, unknown> = {
  status: "running",
  runtime: { bun: Bun.version, platform: process.platform, architecture: process.arch },
  method: "Actual source module and owned random loopback HTTP servers; no model, GPU, database or existing service used.",
  checks,
}

try {
  const response = await fetch(base + "/api", { method: "POST", body: "synthetic" })
  const data = await response.json()
  checks.push({ case: "local_api_post", pass: response.ok && data.marker === "LOCAL_ONLY" && data.method === "POST" })
  const requested = await fetch(new Request(base + "/request", { method: "POST", body: "request-object" }))
  checks.push({ case: "local_request_object", pass: requested.ok && (await requested.json()).marker === "LOCAL_ONLY" })
  for (const mime of ["application/octet-stream", "application/wasm"]) {
    const embedded = await fetch(`data:${mime};base64,QUdFTlRfTE9DQUw=`)
    checks.push({ case: "embedded_binary_data", mime, pass: embedded.ok && (await embedded.text()) === "AGENT_LOCAL" })
  }
  const virtual = process.platform === "win32" ? "file:///B:/~BUN/root/embedded/parser.wasm" : "file:///$bunfs/root/embedded/parser.wasm"
  guard.assertOfflineURL(virtual)
  checks.push({ case: "bun_virtual_file_url_class", pass: true, scope: "Guard path classification only; compiled Bun asset loading is application acceptance." })
  const blocked = [
    "https://example.invalid/never-request",
    "http://example.invalid/never-request",
    "http://127.0.0.1.evil.invalid/never-request",
    "http://127.0.0.1@evil.invalid/never-request",
    "http://localhost/never-request",
    "http://127.0.0.2/never-request",
    "http://[::ffff:127.0.0.1]/never-request",
    "http://192.168.1.1/never-request",
    "file:///etc/passwd",
    "file:///C:/Windows/System32/not-a-bundled-asset.wasm",
    "file://example.invalid/share/parser.wasm",
    "file:////example.invalid/share/parser.wasm",
    "file:///B:/~BUN/root/../../outside.wasm",
    "file:///B:/~BUN/root/%2foutside.wasm",
    "data:text/plain,synthetic",
    "ftp://127.0.0.1/never-request",
  ]
  for (const url of blocked) {
    let message = ""
    try { await fetch(url) } catch (error) { message = error instanceof Error ? error.message : String(error) }
    checks.push({ case: "blocked_url", url, pass: message.startsWith("Offline mode blocks this network request"), error: message })
  }
  let requestError = ""
  try { await fetch(new Request("https://example.invalid/request-object")) } catch (error) {
    requestError = error instanceof Error ? error.message : String(error)
  }
  checks.push({ case: "external_request_object", pass: requestError.startsWith("Offline mode blocks this network request") })
  for (const route of ["/redirect-local", "/redirect-external"]) {
    let error = ""
    try { await fetch(base + route) } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
    checks.push({ case: "automatic_redirect_blocked", route, pass: Boolean(error) && sinkHits === 0, error })
  }
  const manual = await fetch(base + "/redirect-external", { redirect: "manual" })
  checks.push({ case: "manual_redirect_not_followed", pass: manual.status === 302 && manual.headers.get("Location") === "https://example.invalid/guard-test" && sinkHits === 0 })
  if (fetch.preconnect) {
    let error = ""
    try { fetch.preconnect("https://example.invalid/") } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
    checks.push({ case: "external_preconnect_blocked", pass: error.startsWith("Offline mode blocks this network request") })
  }
  report.status = checks.every((check) => check.pass === true) ? "pass" : "fail"
} catch (error) {
  report.status = "fail"
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  source.stop(true)
  sink.stop(true)
  report.local_requests = hits
  report.redirect_destination_requests = sinkHits
  report.cleanup = { owned_servers_stopped: true, existing_services_or_databases_touched: false }
  report.limits = "Fetch/preconnect behavior only, not OS packet capture, raw sockets, third-party worker realms or child-process egress. External cases were rejected by the guard before native fetch/preconnect."
  report.verified_at_utc = new Date().toISOString()
}
console.log(JSON.stringify({ status: report.status, checks: checks.length, failed: checks.filter((c) => c.pass !== true), redirect_destination_requests: sinkHits, runtime: report.runtime }, null, 2))
process.exitCode = report.status === "pass" ? 0 : 1
