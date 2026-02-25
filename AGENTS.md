- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

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

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

### Offline Integration Tests

When making changes to offline-related code, run the containerized offline test suite to verify the bundle still works in an air-gapped environment:

```bash
bun install
bun run script/download-offline-deps.ts
bun run script/package-offline-bundle.ts
docker compose -f test/offline/docker-compose.yml up --build
```

This builds the full offline bundle, runs it in a RHEL9 container with no outbound network, and validates: environment setup, binary execution, network isolation, web UI serving (bundled SolidJS app), LSP server presence, and CLI commands.

These tests run automatically in CI (`.github/workflows/offline-test.yml`) on changes to:
- `packages/opencode/src/offline/**`
- `packages/opencode/src/server/server.ts`
- `script/download-offline-deps.ts`, `script/package-offline-bundle.ts`
- `test/offline/**`

See `test/offline/README.md` for details on network isolation modes, interactive exploration, and troubleshooting.
