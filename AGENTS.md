- To test opencode in `packages/opencode`, run `bun dev`.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.

## Fork Management: Keeping Up with Upstream

This repository is a fork of [OpenCode](https://github.com/anomalyco/opencode) that adds offline/air-gapped deployment support. We regularly sync with upstream to get new features and fixes.

### Philosophy: Minimize Upstream Touchpoints

The goal is to make upstream syncs as painless as possible by:
1. **Centralizing fork-specific logic** in dedicated modules (like `packages/opencode/src/offline/`)
2. **Minimizing changes to upstream files** - when we must modify upstream code, use small guards that delegate to our modules
3. **Preferring additive changes** over modifications - new files never conflict

### Writing Conflict-Avoidant Code

When adding fork-specific features:

**Prefer new files over modifying existing ones:**
```
packages/opencode/src/offline/     <- Fork-specific, never conflicts
packages/opencode/src/some-core/   <- Upstream code, may conflict
```

**When you must modify upstream files, keep changes minimal:**
```typescript
// Good: 2-line guard at top of function
const offlineResult = await Offline.tryResolve(args)
if (offlineResult) return offlineResult

// Bad: Large block of fork logic embedded in function
if (Offline.isEnabled()) {
  // ... 20 lines of fork-specific code ...
}
```

**Mark fork-specific lines for easy identification:**
```typescript
// offline-fork: use bundled binary in air-gapped mode
const result = await Offline.tryResolveBinary(name)
```

### Upstream Sync Workflow

1. Add upstream remote if not already configured:
   ```bash
   git remote add upstream https://github.com/anomalyco/opencode.git
   ```

2. Fetch and merge upstream changes:
   ```bash
   git fetch upstream
   git checkout -b sync/upstream-$(date +%Y%m%d) dev
   git merge upstream/dev
   ```

3. Resolve conflicts:
   - Accept upstream changes first
   - Re-add minimal fork guards (look for `// offline-fork:` comments in git diff)

4. Verify:
   ```bash
   bun test
   OPENCODE_OFFLINE_MODE=true bun dev  # Test offline mode still works
   ```

5. PR to `dev` branch
