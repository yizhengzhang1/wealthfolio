## Project Overview

Wealthfolio - Desktop investment tracker with local-first data. React + Vite
frontend, Tauri/Rust backend, SQLite storage. pnpm workspace (TS) + Cargo
workspace (Rust) in one repo.

Key directories:

- `apps/frontend/` — React app (pages, features, components, adapters, addons)
- `apps/tauri/` — Tauri desktop/mobile app (IPC commands in `src/commands/`)
- `apps/server/` — Axum HTTP server for web mode (handlers in `src/api/`)
- `crates/` — Rust crates: `core` (business logic/services), `storage-sqlite`
  (Diesel ORM, repositories, migrations), `market-data`, `connect`,
  `device-sync` (E2EE sync), `ai`, `spending`
- `packages/` — Shared TS packages: `@wealthfolio/ui`, `addon-sdk`,
  `addon-dev-tools`
- `docs/architecture/` — adapter, AI assistant, and market-data design docs

## Architecture: One Frontend, Two Backends

The same React app ships as a Tauri desktop app and as a web app served by an
Axum server. Backend selection is at **build time**, not runtime:

```
Frontend (React) → adapter API (apps/frontend/src/adapters/)
        BUILD_TARGET=tauri → adapters/tauri/ → Tauri IPC commands (apps/tauri/src/commands/)
        BUILD_TARGET=web   → adapters/web/   → HTTP → Axum API (apps/server/src/api/)
                                 ↓ (both)
                        crates/core services → crates/storage-sqlite (Diesel/SQLite)
```

- `apps/frontend/vite.config.ts` aliases the adapter import to `adapters/tauri/`
  or `adapters/web/` based on `BUILD_TARGET` (defaults to `tauri`).
- `adapters/shared/` holds backend-agnostic logic used by both; `tauri/` and
  `web/` must export the same surface — enforced by
  `adapters/adapter-command-parity.test.ts`.
- Adding a backend-touching feature means touching all layers: adapter
  (shared + tauri + web), Tauri command (wire in `mod.rs` + `lib.rs`), Axum
  endpoint, and the `crates/core` service both call into. Keep Tauri/Axum
  handlers thin — business logic lives in `crates/core`.
- DB migrations: `crates/storage-sqlite/migrations/` (Diesel).
- Forms: `react-hook-form` + `zod` schemas in `apps/frontend/src/lib/schemas.ts`.
  Theme tokens: `apps/frontend/src/globals.css`. Components from
  `@wealthfolio/ui` (`packages/ui/src/components/`).

## Quick Commands

- Dev desktop: `pnpm tauri dev`
- Dev web: `pnpm run dev:web` (Vite + Axum together)
- TS tests: `pnpm test` (Vitest; watch mode in a TTY)
- Single TS test: `pnpm --filter frontend exec vitest run <path-or-pattern>`
- Rust tests: `cargo test` | single crate: `cargo test -p wealthfolio-core <name>`
- E2E (Playwright vs web app, no mocks): `pnpm test:e2e` — but ALWAYS follow
  `e2e/README.md` / the `run-e2e-tests` skill; manual runs need
  `node scripts/prep-e2e.mjs` first for a fresh DB
- Type check: `pnpm type-check` | Rust: `cargo check`
- Lint: `pnpm lint` | All checks (format+lint+types): `pnpm check`

## Conventions

- TypeScript: strict mode; interfaces over types; no enums (use maps);
  functional components, named exports; lowercase-with-dashes directories.
- Rust: `Result`/`Option` with `?`, `thiserror` for domain errors;
  `unsafe_code = "forbid"` workspace-wide; clippy warnings on.
- If touching shared code, both desktop and web targets must compile.

## Network / Proxy (this machine)

Use the **phone hotspot** proxy `http://127.0.0.1:7892` for ALL downloads/builds.
The company wired proxy (`109.105.230.22:9090`) throttles some CDNs hard (Alpine
pkg mirror fell to ~12 KB/s). Hotspot is a plain tunnel — no MITM cert needed.

- `docker build`: add `--network=host` (RUN steps need it to reach the host-only
  hotspot proxy) + `--build-arg http_proxy=http://127.0.0.1:7892 --build-arg https_proxy=http://127.0.0.1:7892`.
- Runtime container egress (e.g. Yahoo quotes): run with `--network host` and
  `-e HTTPS_PROXY=http://127.0.0.1:7892` (clash binds 127.0.0.1 only).

## Git / Upstream

This is a personal fork. Maintain **only the fork** (`origin` =
`github.com/yizhengzhang1/wealthfolio`). **Never** push, merge, or open a PR
to the most-upstream `wealthfolio/wealthfolio` — not even for genuine upstream
bugs. All push/PR/merge targets are `origin`. Don't propose upstream
contributions unless I explicitly say "this one goes upstream".

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if
  any.

---

## Behavioral Guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial
tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer
rewrites due to overcomplication, and clarifying questions come before
implementation rather than after mistakes.
