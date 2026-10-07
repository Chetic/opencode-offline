#!/bin/bash
# OpenCode Offline Test Suite
# Validates the offline bundle works correctly in an air-gapped environment.
# Exit codes: 0 = all tests passed, 1 = one or more failures
#
# Optional: set LLM_ENDPOINT (OpenAI-compatible base URL, e.g. http://host:1234/v1) and
# LLM_MODEL to also run a prompt end-to-end against a local model. That mode needs a
# network path to the LLM, so the network isolation checks are skipped.

set -uo pipefail

PASS=0
FAIL=0
ROOT="/opt/opencode"
OPENCODE_BIN="$ROOT/opencode-offline"
DEPS_DIR="$ROOT/deps"
WORK="$(mktemp -d "$HOME/offline-test.XXXXXX")"
LLM_ENDPOINT="${LLM_ENDPOINT:-}"
LLM_MODEL="${LLM_MODEL:-}"

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

check() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$desc"
  else
    fail "$desc"
  fi
}

check_fail() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "$desc (expected failure but succeeded)"
  else
    pass "$desc"
  fi
}

# Runs `opencode debug lsp diagnostics` on a file containing an error and
# checks that the language server reported it.
check_diagnostics() {
  local desc="$1" dir="$2" file="$3" pattern="$4"
  local out
  out=$(cd "$dir" && timeout 120 "$OPENCODE_BIN" debug lsp diagnostics "$file" 2>&1)
  if echo "$out" | grep -qi -- "$pattern"; then
    pass "$desc"
  else
    fail "$desc"
    echo "$out" | tail -15 | sed 's/^/      /'
  fi
}

start_server() {
  "$OPENCODE_BIN" serve --hostname 127.0.0.1 --port 4096 >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  # Requests that arrive while the server is still starting can stall, so each probe has a timeout.
  for _ in $(seq 1 60); do
    if curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/ 2>/dev/null | grep -q "200"; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

stop_server() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}

# ============================================================
echo ""
echo "=============================="
echo " OpenCode Offline Test Suite"
echo "=============================="

# --- Section 1: Environment ---
echo ""
echo "--- 1. Environment ---"

[ "$OPENCODE_OFFLINE_MODE" = "true" ] && pass "OPENCODE_OFFLINE_MODE is set" || fail "OPENCODE_OFFLINE_MODE is not set"
[ -n "$OPENCODE_OFFLINE_DEPS_PATH" ] && pass "OPENCODE_OFFLINE_DEPS_PATH is set" || fail "OPENCODE_OFFLINE_DEPS_PATH is not set"
[ "$OPENCODE_DISABLE_AUTOUPDATE" = "true" ] && pass "OPENCODE_DISABLE_AUTOUPDATE is set" || fail "OPENCODE_DISABLE_AUTOUPDATE is not set"
[ "$OPENCODE_DISABLE_LSP_DOWNLOAD" = "true" ] && pass "OPENCODE_DISABLE_LSP_DOWNLOAD is set" || fail "OPENCODE_DISABLE_LSP_DOWNLOAD is not set"
[ "$OPENCODE_DISABLE_MODELS_FETCH" = "true" ] && pass "OPENCODE_DISABLE_MODELS_FETCH is set" || fail "OPENCODE_DISABLE_MODELS_FETCH is not set"

check "deps/ripgrep/ exists" test -d "$DEPS_DIR/ripgrep"
check "deps/lsp/ exists" test -d "$DEPS_DIR/lsp"
check "deps/node_modules/ exists" test -d "$DEPS_DIR/node_modules"
check "deps/bin/ exists" test -d "$DEPS_DIR/bin"
check "deps/models.json exists" test -f "$DEPS_DIR/models.json"
check "manifest.json exists" test -f "$ROOT/manifest.json"
check_fail "node is not installed (shims must not need it)" which node

# --- Section 2: Binaries ---
echo ""
echo "--- 2. Binaries ---"

check "opencode binary exists" test -x "$ROOT/bin/opencode"
check "opencode --version runs" "$OPENCODE_BIN" --version
"$OPENCODE_BIN" --version 2>/dev/null | grep -q "offline" && pass "version identifies the offline bundle" || fail "version does not identify the offline bundle"
check "bundled ripgrep exists" test -x "$DEPS_DIR/ripgrep/rg"
check "bundled ripgrep runs" "$DEPS_DIR/ripgrep/rg" --version

# --- Section 3: Network Isolation ---
echo ""
echo "--- 3. Network Isolation ---"

if [ -n "$LLM_ENDPOINT" ]; then
  echo "  SKIP: LLM_ENDPOINT is set, network isolation is not enforced"
else
  check_fail "curl google.com fails (offline)" curl --connect-timeout 3 -s https://www.google.com
  check_fail "curl app.opencode.ai fails (offline)" curl --connect-timeout 3 -s https://app.opencode.ai
  check_fail "curl models.dev fails (offline)" curl --connect-timeout 3 -s https://models.dev
fi

# --- Section 4: Web UI ---
echo ""
echo "--- 4. Web UI (embedded in binary) ---"

if start_server; then
  pass "Server started and accepting requests"

  HTTP_CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/)
  [ "$HTTP_CODE" = "200" ] && pass "Root returns HTTP 200" || fail "Root returns HTTP $HTTP_CODE (expected 200)"

  BODY=$(curl -s -m 10 http://127.0.0.1:4096/)
  echo "$BODY" | grep -q "<!DOCTYPE html\|<html\|<head" && pass "Root response contains HTML" || fail "Root response does not contain HTML"

  ASSET=$(echo "$BODY" | grep -o 'src="/[^"]*\.js"' | head -1 | sed 's/src="//;s/"//')
  if [ -n "$ASSET" ]; then
    HTTP_CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:4096$ASSET")
    [ "$HTTP_CODE" = "200" ] && pass "Web UI script asset served locally" || fail "Web UI script asset returns HTTP $HTTP_CODE"
  else
    fail "Web UI HTML references no script asset"
  fi

  HTTP_CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/some/deep/route)
  [ "$HTTP_CODE" = "200" ] && pass "SPA fallback returns HTTP 200 for deep route" || fail "SPA fallback returns HTTP $HTTP_CODE (expected 200)"

  FALLBACK_BODY=$(curl -s -m 10 http://127.0.0.1:4096/some/deep/route)
  echo "$FALLBACK_BODY" | grep -q "<!DOCTYPE html\|<html\|<head" && pass "SPA fallback returns HTML" || fail "SPA fallback does not return HTML"

  DUMP=$(curl -s -m 30 -X POST -H "Content-Type: application/json" -d '{"sessionID":"ses_none"}' http://127.0.0.1:4096/offline/dump-request)
  echo "$DUMP" | grep -q '"success":false' && pass "/curl dump route responds" || fail "/curl dump route: $DUMP"
else
  fail "Server failed to start within 2.5 minutes"
  tail -20 "$WORK/server.log" | sed 's/^/      /'
fi
stop_server

# --- Section 5: LSP Servers ---
echo ""
echo "--- 5. LSP Servers ---"

check "typescript-language-server shim exists" test -x "$DEPS_DIR/bin/typescript-language-server"
check "typescript-language-server runs without node" "$DEPS_DIR/bin/typescript-language-server" --version
check "pyright-langserver shim exists" test -x "$DEPS_DIR/bin/pyright-langserver"
check "pyright runs without node" "$DEPS_DIR/bin/pyright" --version
check "bundled tsserver.js exists" test -f "$DEPS_DIR/node_modules/typescript/lib/tsserver.js"
check "clangd exists" test -x "$DEPS_DIR/lsp/clangd/bin/clangd"
check "clangd --version runs" "$DEPS_DIR/lsp/clangd/bin/clangd" --version
check "rust-analyzer exists" test -x "$DEPS_DIR/lsp/rust-analyzer/bin/rust-analyzer"
check "rust-analyzer --version runs" "$DEPS_DIR/lsp/rust-analyzer/bin/rust-analyzer" --version

PROJECT="$WORK/project"
mkdir -p "$PROJECT"
(cd "$PROJECT" && git -c init.defaultBranch=main init -q)
printf 'def greet(name: str) -> str:\n    return name\n\ngreet(42)\n' >"$PROJECT/main.py"
printf 'const count: number = "not a number"\nexport { count }\n' >"$PROJECT/main.ts"
printf 'int main(void) {\n  return missing_symbol;\n}\n' >"$PROJECT/main.c"
touch "$PROJECT/compile_flags.txt"

check_diagnostics "pyright reports a type error" "$PROJECT" main.py "greet\|\"int\"\|literal"
check_diagnostics "typescript reports a type error" "$PROJECT" main.ts "not assignable"
check_diagnostics "clangd reports an error" "$PROJECT" main.c "missing_symbol"

# --- Section 6: CLI Commands ---
echo ""
echo "--- 6. CLI Commands ---"

check "opencode --help runs" "$OPENCODE_BIN" --help
# A provider's catalog only shows once it has credentials; a dummy key is enough offline.
MODELS=$(cd "$PROJECT" && ANTHROPIC_API_KEY=dummy timeout 60 "$OPENCODE_BIN" models anthropic 2>&1)
echo "$MODELS" | grep -q "^anthropic/claude" && pass "models are listed from the bundled models.json" || fail "models not listed: $(echo "$MODELS" | tail -3)"

# The TUI loads native libraries (OpenTUI) embedded in the binary. This runs it in a
# pseudo-terminal for a few seconds; it must still be running when the timeout hits.
if command -v script >/dev/null 2>&1; then
  (cd "$PROJECT" && TERM=xterm-256color timeout 8 script -qec "$OPENCODE_BIN" /dev/null >"$WORK/tui.log" 2>&1)
  CODE=$?
  [ "$CODE" = "124" ] && pass "TUI starts and keeps running" || {
    fail "TUI exited with code $CODE"
    tail -c 2000 "$WORK/tui.log" | sed 's/^/      /'
  }
else
  echo "  SKIP: 'script' not available for the TUI smoke test"
fi

if mount | grep " /tmp " | grep -q noexec; then
  pass "suite ran with noexec /tmp"
else
  echo "  NOTE: /tmp is not mounted noexec"
fi

# --- Section 7: Local LLM (optional) ---
echo ""
echo "--- 7. Local LLM ---"

if [ -n "$LLM_ENDPOINT" ] && [ -n "$LLM_MODEL" ]; then
  mkdir -p "$HOME/.config/opencode"
  cat >"$HOME/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local LLM",
      "options": { "baseURL": "$LLM_ENDPOINT" },
      "models": { "$LLM_MODEL": { "name": "$LLM_MODEL" } }
    }
  }
}
EOF
  if start_server; then
    OUT=$(cd "$PROJECT" && timeout 300 "$OPENCODE_BIN" run --attach http://127.0.0.1:4096 --format json \
      -m "local/$LLM_MODEL" "Reply with exactly the word OFFLINE_OK and nothing else." 2>&1)
    echo "$OUT" | grep -q "OFFLINE_OK" && pass "local model answered a prompt" || {
      fail "local model did not answer"
      echo "$OUT" | tail -10 | sed 's/^/      /'
    }
    SESSION=$(echo "$OUT" | grep -o '"sessionID":"ses_[^"]*"' | head -1 | cut -d'"' -f4)
    DUMP=$(curl -s -m 30 -X POST -H "Content-Type: application/json" -d "{\"sessionID\":\"$SESSION\"}" http://127.0.0.1:4096/offline/dump-request)
    echo "$DUMP" | grep -q '"success":true' && pass "/curl dumped the captured LLM request" || fail "/curl dump failed: $DUMP"
    SCRIPT="$HOME/.opencode/debug/llm-request.sh"
    JSON=$(echo "$DUMP" | grep -o '"jsonPath":"[^"]*"' | cut -d'"' -f4)
    if [ -x "$SCRIPT" ] && [ -f "$JSON" ]; then
      "$SCRIPT" "$JSON" 2>/dev/null | grep -q "choices\|data:" && pass "dumped curl script replays the request" || fail "dumped curl script did not replay"
    else
      fail "dump files missing"
    fi
  else
    fail "server failed to start for LLM test"
  fi
  stop_server
else
  echo "  SKIP: set LLM_ENDPOINT and LLM_MODEL to test a local model"
fi

rm -rf "$WORK"

# ============================================================
echo ""
echo "=============================="
echo " Results: $PASS passed, $FAIL failed"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  echo "SOME TESTS FAILED"
  exit 1
fi
echo "ALL TESTS PASSED"
exit 0
