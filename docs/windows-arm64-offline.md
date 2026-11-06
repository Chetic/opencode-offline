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

## Paste images on Windows

Use **Alt+V**, or click **Alt+V paste image** in the normal prompt footer, after
copying an image bitmap, an image file in Explorer, or a local image path. Windows
defaults include both `ctrl+v` and `alt+v`; a terminal host can intercept Ctrl+V
before OpenCode receives it. No global terminal settings need to be changed.
Ordinary clipboard text is still inserted as text. Empty clipboard input produces
a short hint instead of silently doing nothing.

The Windows clipboard reader supports `CF_HDROP` file lists (up to 16 files) as
well as bitmaps. Local image paths accept matching single or double quotes,
including spaces and Unicode names. Windows PowerShell runs hidden in STA mode
with UTF-8 output, a timeout and a bounded output buffer. File content reads are
bounded by the existing 64 MiB image-input limit and use the existing image codec
for validation and normalization before attachment.

Image files must be resident on a local fixed drive. UNC/device paths, mapped
network drives, remote URLs, symlinks/junctions and online-only Cloud Files are
rejected before content reads. Download an online-only image in Explorer first;
the attachment helper does not request hydration. Failed attachments show a
readable error. Terminal file-drop transport depends on the terminal host; when
it only inserts a path, copying that path and using Alt+V is the explicit route.

## Behavior and validation

In offline mode, missing web assets return HTTP 503 instead of proxying the
hosted UI. Missing ripgrep or npm dependencies fail without attempting a download.
The CLI and TUI worker guard JavaScript `fetch` and `preconnect`: only literal
loopback HTTP endpoints, inline data, process-registered Blob URLs, and embedded
Bun virtual-file resources are permitted. Unknown or revoked Blob URLs and
automatic redirects are rejected. Extra language grammars that use
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
- The source and compiled fetch guards passed 35 checks covering local HTTP,
  inline data, registered/revoked Blob URLs, misleading hostnames, UNC/file-path
  boundaries, and redirect blocking.

Image input is normalized before message persistence and before streaming response
headers are committed. Local AVIF decoding is bundled as WASM; PNG/JPEG output is
passed to the selected model. The same validation covers prompt attachments,
file reads, and image results from tools and MCP. Invalid base64, damaged images,
MIME mismatches, and oversized inputs produce a readable HTTP 400; the terminal
includes failed-draft restoration logic. Animated AVIF uses its first frame.

The image update passed 47 targeted source tests, compiled API checks with mixed
valid/invalid concurrent requests, and real local-model AVIF/PNG inference. The
tests use synthetic data and two public libavif fixtures; their source and BSD
notice are included beside the fixtures. These checks do not establish image
support for every model or replace an operating-system network sandbox.

The subsequent Windows clipboard/path update passed the opencode typecheck and
all **41 image tests with 106 assertions**, including 33 focused clipboard,
path and keybinding tests. The **35 source fetch-guard checks** also passed with
zero redirect-destination requests. Native PowerShell UTF-8 serialization of a
synthetic Unicode path and the metadata-to-AVIF-to-PNG path were checked without
reading or changing the system clipboard. Both native CLI and web assets were
rebuilt with Bun 1.4.4. These tests do not claim a physically automated drag-and-drop
test or broad terminal-host compatibility.
Separate controlled native clipboard checks passed for an Explorer-style AVIF
file list with Unicode/spaces, a PNG bitmap, and a quoted text path; the prior
clipboard data was restored. They used public/synthetic fixtures and did not
test physical drag events or delivery of Alt+V by every terminal host.

Run the guard check from `packages/opencode`:

```powershell
bun run test/offline/fetch-guard.ts
```

These are functional checks, not model-quality or performance benchmarks. The
earlier file-permission inference check used a short-context profile; the separate
image checks used an existing 131,072-token backend. Neither establishes maximum
context size or full GPU offload. Draft restoration was reviewed in source;
backend rejection and subsequent-request recovery were exercised, while the TUI
restoration branch was not separately tested through the UI.
The Linux container offline suite was not rerun
for this Windows adaptation. Browser packet capture was not performed: CSP headers
and local HTML were checked, rather than claiming every browser feature was tested.

The guard is not an operating-system egress sandbox. Raw sockets, child processes,
and third-party worker realms can have separate network stacks. CSP does not stop
a user opening an external link in another tab, and browser speech recognition is
not verified to run offline. Keep runtime dependencies, provider configuration,
tool permissions, and any process-level network controls explicit.
