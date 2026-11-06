# Windows ARM64 offline build

This adds a native Windows ARM64 CLI target and makes the offline dependency
paths fail closed. It does not replace the existing Linux x64 bundle packager.

## Build prerequisites

- Windows on ARM64 and a native ARM64 Bun **1.4.4** runtime.
- A checkout of this fork, with this patch, and Git available for the build.
- Network access while installing the pinned build dependencies.

Bun 1.3.10 can compile the CLI but cannot open the OpenTUI renderer on native
Windows ARM64 because its `bun:ffi` implementation is disabled. Bun 1.4 enables
that support; 1.4.4 is the version tested here. See the [Bun 1.4 release
notes](https://bun.com/blog/bun-v1.4) and [the Windows ARM64 FFI
fix](https://github.com/oven-sh/bun/pull/33696).

Run these PowerShell commands from the repository root:

```powershell
bun --version
bun -e 'console.log(process.platform, process.arch)'
# Expected: 1.4.4, then win32 arm64
bun install --frozen-lockfile

# A local catalog avoids a models.dev request during compilation.
# Supply explicit local provider/model definitions in the runtime config.
Set-Content -LiteralPath './models-local.json' -Value '{}' -Encoding ascii
$env:MODELS_DEV_API_JSON = (Resolve-Path './models-local.json').Path
$env:OPENCODE_VERSION = '1.2.13'
$env:OPENCODE_CHANNEL = 'local'

Push-Location './packages/opencode'
try { bun run script/build.ts --single --skip-install }
finally { Pop-Location }
bun run --cwd packages/app build
```

The CLI output is
`packages/opencode/dist/opencode-windows-arm64/bin/opencode.exe`.
The local web assets are in `packages/app/dist`.
This process builds the application; it does not download language-model weights.

## Prepare a separate runtime

Use a dedicated directory for this fork. Set all four `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` variables to new directories
before the process starts. Do not point this older fork at a newer OpenCode
database or cache. Its cache initialization and database migrations have their
own version assumptions.

Also use separate `OPENCODE_TEST_HOME` and
`OPENCODE_TEST_MANAGED_CONFIG_DIR` directories if the deployment must avoid
loading the existing home or managed OpenCode settings. Use a fresh auth store.

Enable the following settings before launching the compiled CLI:

```powershell
$env:OPENCODE_OFFLINE_MODE = 'true'
$env:OPENCODE_OFFLINE_DEPS_PATH = '<absolute-runtime-directory>/deps'
$env:OPENCODE_DISABLE_AUTOUPDATE = 'true'
$env:OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true'
$env:OPENCODE_DISABLE_LSP_DOWNLOAD = 'true'
$env:OPENCODE_DISABLE_MODELS_FETCH = 'true'
$env:OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
$env:OPENCODE_DISABLE_EXTERNAL_SKILLS = 'true'
$env:OPENCODE_DISABLE_CLAUDE_CODE = 'true'
$env:OPENCODE_DISABLE_SHARE = 'true'
```

Prepare `deps/app` with the entire built web output, `deps/ripgrep/rg.exe` with a
compatible local ripgrep binary, and `deps/models.json` with the local catalog.
Ripgrep already on `PATH` is also supported. Required npm packages must already
be present in `deps/node_modules`; offline mode will not install missing ones.
Set `lsp: false` unless the required language servers have been staged locally.
The existing dependency download and packaging scripts still select Linux x64
binaries, so do not run them to prepare Windows dependencies.

Configure only the intended local provider, using an explicit literal-loopback
endpoint such as `http://127.0.0.1:11434/v1`, and the model IDs already installed
at that endpoint. Set `share: "disabled"`, `autoupdate: false`, `plugin: []`, and
disable unused web tools and remote MCP servers. This fork predates newer config
fields such as `subagent_depth`; validate copied configuration against its schema.

## Behavior and validation

In offline mode, missing web assets return HTTP 503 instead of proxying the
hosted UI. Missing ripgrep or npm dependencies fail without attempting a download.
The CLI and TUI worker guard JavaScript `fetch` and `preconnect`: only literal
loopback HTTP endpoints and embedded binary/Bun virtual-file resources are
permitted. Automatic redirects are rejected. Extra language grammars that use
remote URLs are not registered; OpenTUI's bundled parsers remain available.

The bundled web response includes a CSP restricting external asset and connection
loads. Notification and project favicons use local assets. The named MCP tools
`spark_files_replace_text` and `spark_files_create_file` always require a fresh
approval unless denied: an `Always` response grants only that call, and cached
approval cannot bypass the next request. This does not change the MCP tools'
file-validation or mutation implementations.

Observed validation on native Windows ARM64 with Bun 1.4.4:

- Fresh checkout and frozen dependency installation built both CLI and web assets.
- Native TUI startup and system-DLL FFI scalar, pointer, and double calls worked.
- An isolated local-provider session read synthetic files and completed an exact
  edit and a new-file creation only after approval. A later creation asked again;
  rejecting it left the file absent. `Always` behaved as a one-call approval.
- The local HTML response included the external-resource CSP.
- The source fetch guard passed 26 checks covering local HTTP, embedded binary
  data, misleading hostnames, UNC/file-path boundaries, and redirect blocking.

Run the guard check from `packages/opencode`:

```powershell
bun run test/offline/fetch-guard.ts
```

These are functional checks, not model-quality or performance benchmarks. The
inference check used a short-context test profile; it does not establish maximum
context size or full GPU offload. The Linux container offline suite was not rerun
for this Windows adaptation. Browser packet capture was not performed: CSP headers
and local HTML were checked, rather than claiming every browser feature was tested.

The guard is not an operating-system egress sandbox. Raw sockets, child processes,
and third-party worker realms can have separate network stacks. CSP does not stop
a user opening an external link in another tab, and browser speech recognition is
not verified to run offline. Keep runtime dependencies, provider configuration,
tool permissions, and any process-level network controls explicit.
