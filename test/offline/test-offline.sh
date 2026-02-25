#!/bin/bash
# OpenCode Offline Test Suite
# Validates the offline bundle works correctly in an air-gapped environment.
# Exit codes: 0 = all tests passed, 1 = one or more failures

set -euo pipefail

PASS=0
FAIL=0
OPENCODE_BIN="/opt/opencode/opencode-offline"
DEPS_DIR="/opt/opencode/deps"

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

# Check deps directory structure
check "deps/ripgrep/ exists" test -d "$DEPS_DIR/ripgrep"
check "deps/lsp/ exists" test -d "$DEPS_DIR/lsp"
check "deps/node_modules/ exists" test -d "$DEPS_DIR/node_modules"
check "deps/app/ exists" test -d "$DEPS_DIR/app"
check "deps/models.json exists" test -f "$DEPS_DIR/models.json"
check "deps/app/index.html exists" test -f "$DEPS_DIR/app/index.html"

# --- Section 2: Binaries ---
echo ""
echo "--- 2. Binaries ---"

check "opencode binary exists" test -x /opt/opencode/bin/opencode
check "opencode --version runs" "$OPENCODE_BIN" --version
check "bundled ripgrep exists" test -x "$DEPS_DIR/ripgrep/rg"
check "bundled ripgrep runs" "$DEPS_DIR/ripgrep/rg" --version

# --- Section 3: Network Isolation ---
echo ""
echo "--- 3. Network Isolation ---"

check_fail "curl google.com fails (offline)" curl --connect-timeout 3 -s https://www.google.com
check_fail "curl app.opencode.ai fails (offline)" curl --connect-timeout 3 -s https://app.opencode.ai
check_fail "curl models.dev fails (offline)" curl --connect-timeout 3 -s https://models.dev

# --- Section 4: Web UI ---
echo ""
echo "--- 4. Web UI ---"

# Start opencode server in background
"$OPENCODE_BIN" serve --hostname 127.0.0.1 --port 4096 &
SERVER_PID=$!

# Wait for server to be ready
SERVER_READY=false
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/ 2>/dev/null | grep -q "200"; then
    SERVER_READY=true
    break
  fi
  sleep 0.5
done

if [ "$SERVER_READY" = "true" ]; then
  pass "Server started and accepting requests"

  # Check root returns 200
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/)
  [ "$HTTP_CODE" = "200" ] && pass "Root returns HTTP 200" || fail "Root returns HTTP $HTTP_CODE (expected 200)"

  # Check response contains HTML
  BODY=$(curl -s http://127.0.0.1:4096/)
  echo "$BODY" | grep -q "<!DOCTYPE html\|<html\|<head" && pass "Root response contains HTML" || fail "Root response does not contain HTML"

  # Check SPA fallback for deep route
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/some/deep/route)
  [ "$HTTP_CODE" = "200" ] && pass "SPA fallback returns HTTP 200 for deep route" || fail "SPA fallback returns HTTP $HTTP_CODE (expected 200)"

  FALLBACK_BODY=$(curl -s http://127.0.0.1:4096/some/deep/route)
  echo "$FALLBACK_BODY" | grep -q "<!DOCTYPE html\|<html\|<head" && pass "SPA fallback returns HTML" || fail "SPA fallback does not return HTML"
else
  fail "Server failed to start within 15 seconds"
  fail "Root returns HTTP 200 (server not running)"
  fail "Root response contains HTML (server not running)"
  fail "SPA fallback returns HTTP 200 (server not running)"
  fail "SPA fallback returns HTML (server not running)"
fi

# Clean up server
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

# --- Section 5: LSP Servers ---
echo ""
echo "--- 5. LSP Servers ---"

# typescript-language-server (npm-based, run via node_modules/.bin)
TS_LSP="$DEPS_DIR/node_modules/.bin/typescript-language-server"
check "typescript-language-server exists" test -f "$TS_LSP"

# pyright (npm-based)
PYRIGHT="$DEPS_DIR/node_modules/.bin/pyright"
check "pyright exists" test -f "$PYRIGHT"

# clangd (native binary)
CLANGD="$DEPS_DIR/lsp/clangd/bin/clangd"
check "clangd exists" test -x "$CLANGD"
check "clangd --version runs" "$CLANGD" --version

# rust-analyzer (native binary)
RUST_ANALYZER="$DEPS_DIR/lsp/rust-analyzer/bin/rust-analyzer"
check "rust-analyzer exists" test -x "$RUST_ANALYZER"
check "rust-analyzer --version runs" "$RUST_ANALYZER" --version

# --- Section 6: CLI Commands ---
echo ""
echo "--- 6. CLI Commands ---"

check "opencode --help runs" "$OPENCODE_BIN" --help

# ============================================================
echo ""
echo "=============================="
echo " Results: $PASS passed, $FAIL failed"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  echo "SOME TESTS FAILED"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
