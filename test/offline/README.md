# Offline Test Environment

Containerized test environment for validating the OpenCode offline bundle in a RHEL9/UBI9 container with no outbound network access.

## Prerequisites

- Docker (with Compose v2)
- The offline bundle built at `dist/opencode-offline-linux-x64/`

## Quick Start

```bash
# 1. Build the offline bundle (from repo root)
bun install
bun run script/download-offline-deps.ts
bun run script/package-offline-bundle.ts

# 2. Run the tests
docker compose -f test/offline/docker-compose.yml up --build
```

Exit code 0 means all tests passed.

## Network Isolation Modes

### Strict (default)

The `docker-compose.yml` uses an `internal: true` network, which blocks all outbound traffic. This is the default and mirrors an air-gapped environment.

### noexec /tmp

The compose file mounts `/tmp` as `noexec`, like many hardened RHEL hosts. The TUI smoke test fails if embedded native libraries are extracted to `/tmp` (the wrapper's `BUN_TMPDIR` prevents this).

### With LLM Endpoint

Section 7 runs a prompt against a local OpenAI-compatible server, dumps the captured request through the `/curl` route and replays it. It needs a network path to the LLM, so the network isolation checks are skipped in this mode. With Podman (or Docker) on the host running the LLM, the simplest way is host networking:

```bash
podman build -f test/offline/Dockerfile -t opencode-offline-test .
podman run --rm --network host --tmpfs /tmp:rw,noexec,nosuid \
  -e LLM_ENDPOINT=http://127.0.0.1:1234/v1 -e LLM_MODEL=google/gemma-4-26b-a4b \
  --entrypoint /bin/bash opencode-offline-test /opt/opencode/test-offline.sh
```

`LLM_ENDPOINT` is the base URL including `/v1` (LM Studio: port 1234, Ollama: `http://127.0.0.1:11434/v1`). Local models are slow to process OpenCode's system prompt; the prompt has a 5 minute timeout.

### Podman

Without a Docker daemon, run the strict suite directly:

```bash
podman build -f test/offline/Dockerfile -t opencode-offline-test .
podman run --rm --network none --tmpfs /tmp:rw,noexec,nosuid \
  --entrypoint /bin/bash opencode-offline-test /opt/opencode/test-offline.sh
```

## Interactive Exploration

Build the image and run interactively:

```bash
docker build -f test/offline/Dockerfile -t opencode-offline-test .
docker run -it --network none --entrypoint /bin/bash opencode-offline-test
```

Inside the container:

```bash
# Run the test suite
/opt/opencode/test-offline.sh

# Start the web UI
/opt/opencode/opencode-offline web

# Check versions
/opt/opencode/opencode-offline --version
/opt/opencode/deps/ripgrep/rg --version
```

## Test Coverage

| Section | Tests | What it validates |
|---------|-------|-------------------|
| Environment | Env vars, directory structure, no node | Offline config is set, all expected dirs/files exist |
| Binaries | opencode, ripgrep, version | Core binaries run; version identifies the offline bundle |
| Network Isolation | curl to google, app.opencode.ai, models.dev | No outbound network access |
| Web UI | Server start, HTML, script asset, SPA fallback, `/curl` route | Web app embedded in the binary is served locally |
| LSP Servers | shims, clangd, rust-analyzer, diagnostics | Language servers run without node and report real errors for Python, TypeScript and C |
| CLI Commands | --help, models, TUI start, noexec /tmp | Bundled model definitions load; the TUI loads its native library |
| Local LLM (optional) | prompt, `/curl` dump, replay | End-to-end prompt against a local model |

## Troubleshooting

### Build fails: "Dependencies not found"

Run `bun run script/download-offline-deps.ts` first to download dependencies.

### Web UI tests fail: "Server failed to start"

The server has about 2.5 minutes to start (`start_server` in `test-offline.sh`). Requests sent while the server is still starting can stall, which is why every probe has a timeout.

### TUI test fails with "failed to map segment from shared object"

Embedded native libraries were extracted to a noexec directory. Check that the wrapper sets `BUN_TMPDIR` and that the directory is on an exec-capable filesystem.

### LSP diagnostics tests fail with `{}`

The language servers did not start. Check that `deps/bin` shims are executable and that the config does not set `"lsp": false`.

### Network isolation tests pass but shouldn't

Ensure `docker-compose.yml` has `internal: true` on the network. Without it, the container can reach the internet.

### clangd/rust-analyzer version check fails

These are native Linux x64 binaries. If built on a different architecture, they won't run. Ensure `download-offline-deps.ts` was run on an x64 system or cross-downloads the correct architecture.
