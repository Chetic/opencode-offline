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

# 2. Verify the web app was included
ls dist/opencode-offline-linux-x64/deps/app/index.html

# 3. Run the tests
docker compose -f test/offline/docker-compose.yml up --build
```

Exit code 0 means all tests passed.

## Network Isolation Modes

### Strict (default)

The `docker-compose.yml` uses an `internal: true` network, which blocks all outbound traffic. This is the default and mirrors an air-gapped environment.

### With LLM Endpoint

To test with a local LLM (e.g., Ollama), you need to allow the container to reach the host. Edit `docker-compose.yml`:

1. Remove `internal: true` from the network config (or add a second non-internal network)
2. Set the `LLM_ENDPOINT` environment variable:

```bash
LLM_ENDPOINT=http://host.docker.internal:11434 \
  docker compose -f test/offline/docker-compose.yml up --build
```

Note: Network isolation tests will fail in permissive mode (expected).

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
| Environment | Env vars, directory structure | Offline config is properly set, all expected dirs/files exist |
| Binaries | opencode, ripgrep | Core binaries are executable and functional |
| Network Isolation | curl to google, app.opencode.ai, models.dev | No outbound network access |
| Web UI | Server start, root 200, HTML content, SPA fallback | Bundled web app served locally |
| LSP Servers | typescript-language-server, pyright, clangd, rust-analyzer | LSP binaries present and executable |
| CLI Commands | --help | Basic CLI functionality |

## Troubleshooting

### Build fails: "Dependencies not found"

Run `bun run script/download-offline-deps.ts` first to download dependencies.

### Web UI tests fail: "Server failed to start"

The server has 15 seconds to start. If the container is very slow, increase the timeout in `test-offline.sh` (the `seq 1 30` loop with 0.5s sleep).

### Network isolation tests pass but shouldn't

Ensure `docker-compose.yml` has `internal: true` on the network. Without it, the container can reach the internet.

### clangd/rust-analyzer version check fails

These are native Linux x64 binaries. If built on a different architecture, they won't run. Ensure `download-offline-deps.ts` was run on an x64 system or cross-downloads the correct architecture.
