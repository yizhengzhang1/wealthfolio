# IBKR Sync — Workflow & Subagent Plan

> Read [CONTEXT.md](./CONTEXT.md) first. This doc is the execution plan.

## Phase Map

```
Phase 1: Infra & spike      (sequential, blocks everything)
   ├─ S1  Self-host running
   └─ S2  REST API smoke test (auth → create account → POST activity)

Phase 2: Build               (parallelizable after Phase 1)
   ├─ S3  IBKR adapter        ─┐
   ├─ S4  Wealthfolio client  ─┼─→ S6  Sync orchestrator
   └─ S5  Mapping + dedupe    ─┘

Phase 3: Operate             (sequential after Phase 2)
   ├─ S7  Hourly scheduler config
   └─ S8  E2E verification
```

Each `S#` is sized to be one focused subagent invocation. Inputs / outputs /
acceptance criteria below are the **contract** — any subagent should be able
to be spawned with only this doc + CONTEXT.md and complete its task.

---

## S1 — Self-host running

**Input:** repo at `/home/ubuntu/wealthfolio_ws/wealthfolio`, Docker available.

**Do:**
1. Copy `.env.web.example` → `.env`, fill in `WF_SECRET_KEY` (32-byte b64),
   `WF_AUTH_PASSWORD_HASH` (Argon2id of a chosen dev password),
   `WF_LISTEN_ADDR=0.0.0.0:8088`.
2. `docker compose -f compose.yml up -d`.
3. Hit `http://localhost:8088` and log in via browser.

**Output:** running server, dev password recorded in
`docs/ibkr-sync/.local-secrets.md` (gitignored).

**Acceptance:** browser shows login page, login succeeds, empty dashboard
loads.

**Subagent type:** `general-purpose` (needs Bash + browser-equivalent
curl checks).

---

## S2 — REST API smoke test

**Input:** S1 running, dev password known.

**Do:**
1. Find the login endpoint: grep `apps/server/src/api/` for password/JWT
   handler. Record exact path + payload shape.
2. `curl` login → get JWT.
3. `curl POST /api/v1/accounts` to create a dummy "IBKR-Test" account
   (`provider:"IBKR"`, `tracking_mode:"TRANSACTIONS"`, `currency:"USD"`).
4. `curl POST /api/v1/activities` with one synthetic BUY of AAPL,
   `idempotency_key:"smoke-1"`. Verify it appears in dashboard.
5. Re-POST same payload — verify dedupe (no duplicate row, HTTP behavior
   either 200 idempotent or 409).

**Output:** `docs/ibkr-sync/API-NOTES.md` with: exact endpoints, headers,
payload examples, dedupe behavior, error shapes.

**Acceptance:** all five steps succeed; notes file contains copy-pastable
curl snippets.

**Subagent type:** `general-purpose`.

---

## S3 — IBKR adapter

**Input:** CONTEXT.md field inventory; IBKR MCP tools accessible.

**Do:** write `tools/ibkr-sync/src/ibkr.ts` (or `.py`) exposing:
- `fetchPositions(): Promise<IbkrPosition[]>`
- `fetchRecentTrades(period: "DAYS_7" | "DAYS_30" | ...): Promise<IbkrTrade[]>`
- `fetchSummary(): Promise<IbkrSummary>` (for sanity check)

Calls go through the MCP tools — adapter is the only place that touches
`mcp__claude_ai_Interactive_Brokers_IBKR__*`. Filter out `sec_type:CASH` and
`sec_type:OPT` trades (MVP scope). Strongly-typed return shapes.

**Output:** adapter module + unit-style test that mocks the MCP call (fixture
JSON from a real run, scrubbed).

**Acceptance:** typecheck passes; given fixture inputs, returns expected
typed objects; CASH/OPT rows filtered.

**Subagent type:** `general-purpose`.

---

## S4 — Wealthfolio HTTP client

**Input:** S2 output (API-NOTES.md).

**Do:** write `tools/ibkr-sync/src/wealthfolio.ts` exposing:
- `login(baseUrl, password): Promise<{token, expiresAt}>`
- `findOrCreateAccount(token, {provider, providerAccountId, currency}): Promise<Account>`
- `createActivity(token, activity): Promise<void>` — handles `idempotency_key`
  conflict as success.
- `importHoldingsSnapshot(token, accountId, snapshot): Promise<void>` (for the
  positions path; only if we don't use TRANSACTIONS-only mode).

Auto re-login on 401. Retry on 5xx with backoff (3 attempts).

**Output:** client module + unit test with `nock`/equivalent against fixture.

**Acceptance:** typecheck; idempotency tested.

**Subagent type:** `general-purpose`.

---

## S5 — Mapping + dedupe

**Input:** S3 + S4 modules.

**Do:** write `tools/ibkr-sync/src/mapping.ts` — pure functions:
- `ibkrTradeToActivity(trade, accountId): WealthfolioActivity`
- `ibkrPositionToHoldingRow(pos, accountId): SnapshotRow`

Use mapping table from CONTEXT.md verbatim. `idempotency_key = "ibkr:" + trade_id`.

**Output:** module + table-driven unit tests covering BUY, SELL,
multi-currency, edge cases (zero size, negative price → skip + log).

**Acceptance:** 100% branch coverage on `ibkrTradeToActivity`.

**Subagent type:** `general-purpose`.

---

## S6 — Sync orchestrator

**Input:** S3–S5.

**Do:** write `tools/ibkr-sync/src/sync.ts` — main entry:
1. Load config (env): `WEALTHFOLIO_URL`, `WEALTHFOLIO_PASSWORD`,
   `IBKR_TRADE_LOOKBACK` (default `DAYS_7`), `LOG_LEVEL`.
2. login → findOrCreateAccount → fetch trades → map → POST each → log.
3. (Optional) fetch positions → snapshot import.
4. Summary log: `N trades fetched, M new, K dedup, errors=[…]`.
5. Exit code: 0 success, 1 any non-recoverable error.

**Output:** runnable script, README in `tools/ibkr-sync/README.md`.

**Acceptance:** end-to-end dry-run against the local self-host works once
manually; second run results in 0 new (all dedup'd).

**Subagent type:** `general-purpose`.

---

## S7 — Hourly scheduler

**Input:** S6 working manually.

**Do:** wire `tools/ibkr-sync/src/sync.ts` to run hourly.

Options to evaluate (pick one, document why):
- **Claude Code `/schedule`** — pros: integrated with our session; cons:
  requires Claude Code running.
- **Cron on the host** — pros: always-on; cons: needs MCP equivalents
  reachable without Claude Code (likely **rules this out** since IBKR creds
  live inside the Claude Code MCP binding).
- **Claude Code `/loop` for interactive use** — for testing only.

Default expectation: `/schedule` (decision recorded in
`docs/ibkr-sync/SCHEDULER.md`).

**Output:** scheduler config + ops doc.

**Acceptance:** observe two consecutive auto-runs, second one is fully
deduplicated.

**Subagent type:** `claude` (needs CronCreate / RemoteTrigger).

---

## S8 — E2E verification

**Input:** S7 running.

**Do:**
1. Make a small real trade in IBKR (or wait for one).
2. After next scheduled run, verify the trade shows up in the Wealthfolio
   browser UI.
3. Compare Wealthfolio account net value vs IBKR `get_account_summary`
   `net_liquidation` — flag if drift > 1%.

**Output:** verification notes in `docs/ibkr-sync/VERIFICATION.md`.

**Acceptance:** trade visible in UI within one cycle; reconciliation drift
documented.

**Subagent type:** `general-purpose`.

---

## Dependencies

```
S1 → S2 → {S3, S4, S5} → S6 → S7 → S8
```

S3, S4, S5 are **mutually independent** after S2 finishes — fan out to three
subagents in parallel.

## Configuration Knobs (final list)

| Env var                  | Default       | Notes                                |
| ------------------------ | ------------- | ------------------------------------ |
| `WEALTHFOLIO_URL`        | required      | e.g. `http://localhost:8088`         |
| `WEALTHFOLIO_PASSWORD`   | required      | sourced from local secrets file      |
| `IBKR_TRADE_LOOKBACK`    | `DAYS_7`      | one of IBKR `period` enum values     |
| `SYNC_INTERVAL_MINUTES`  | `60`          | scheduler-only                       |
| `INCLUDE_OPTIONS`        | `false`       | deferred to post-MVP                 |
| `LOG_LEVEL`              | `info`        | `debug` for trace                    |
