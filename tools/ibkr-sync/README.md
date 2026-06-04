# tools/ibkr-sync

External-to-upstream sync tool. Pulls IBKR account state via the **IBKR MCP
server bound to Claude Code** and pushes to a self-hosted Wealthfolio
instance.

Lives outside the pnpm workspace (`pnpm-workspace.yaml` only includes
`apps/frontend` and `packages/*`) so it doesn't interfere with upstream
tooling.

## Layout

```
src/
  ibkr.ts            # IBKR data types + raw-JSON parsers/filters
  wealthfolio.ts     # Wealthfolio HTTP client (cookie auth, retry, dedupe)
  mapping.ts         # Pure IBKR→Wealthfolio mapping functions
  sync.ts            # Orchestrator: reads JSON file, parses, maps, POSTs
test/
  *.test.ts          # Vitest unit + integration tests
fixtures/
  ibkr-*.json        # Real IBKR MCP responses (kept for tests)
scripts/
  routine-prompt.txt # Headless Claude prompt — the per-run instructions
  run-hourly.sh      # Cron entry-point. Invokes `claude -p` with the prompt
  install-cron.sh    # Idempotent crontab installer
logs/                # Per-day sync logs (gitignored)
```

## How it actually runs

Scope: **positions-only snapshot sync**. Trade history is NOT synced — see
`docs/ibkr-sync/CONTEXT.md` for the rationale.

```
host crontab                                        every hour at :00
    │  0 * * * *  scripts/run-hourly.sh
    ▼
run-hourly.sh                                       sets PATH + HOME, runs:
    │  claude -p "$(cat routine-prompt.txt)"
    │      --allowedTools mcp__claude_ai_Interactive_Brokers_IBKR__get_account_{positions,balances,summary}, Bash, Read, Write
    │      --permission-mode acceptEdits
    ▼
headless Claude Code session
    1. Calls 3 IBKR MCP tools (positions, balances, summary)
    2. Writes /tmp/ibkr-raw.json
    3. Reads password from docs/ibkr-sync/secrets.local.md
    4. Bash: npx tsx src/sync.ts --from=/tmp/ibkr-raw.json
    │      a. Pre-create option assets via POST /assets with OptionSpec
    │         metadata (strike/expiry/right/multiplier from OCC symbol).
    │         The snapshot import path itself never builds option metadata.
    │      b. POST /snapshots/import → server is idempotent on
    │         (accountId, date, content).
    5. Prints one-line summary
    6. rm /tmp/ibkr-raw.json
```

### Wealthfolio backend notes (snapshot path)

- **Option contract multiplier — PATCHED.** `manual_snapshot_service.rs`
  previously hardcoded `contract_multiplier = 1`, under-counting options 100×.
  This fork patches it to `asset.contract_multiplier()`, which returns the
  OptionSpec multiplier (100) for options and 1 otherwise. Do NOT also multiply
  option quantities by 100 in `src/mapping.ts` — that would now double-count.
  (The patched image is built via `compose.override.yml`.)
- **Option metadata is NOT auto-derived on the snapshot path.**
  `get_or_create_minimal_asset` never calls `build_asset_metadata`, so strike/
  expiry/right come solely from `sync.ts` pre-creating the asset via
  `POST /assets` with an explicit `metadata.option`. `sync.ts` also passes the
  resulting asset UUID back as the snapshot position's `assetId`, binding the
  row to that asset directly (instead of relying on `instrument_key` string
  matching).
- **Stocks get no pushed quote.** Only options are priced via `importQuotes`;
  stock current prices depend entirely on Wealthfolio's own market-data
  provider (Yahoo, enabled by default but requires the server to have outbound
  internet and a provider-resolvable ticker).

Why local cron and not `/schedule`: `/schedule` (Anthropic remote routines)
runs in the cloud — it can't reach `localhost:8088` and can't read local
files like `secrets.local.md`. Local cron + headless `claude -p` keeps
everything on the host, while still leveraging the IBKR MCP binding
(headless mode uses the same OAuth keychain entry as interactive mode).

## Operations

| Task                        | Command                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| Run sync once, ad-hoc       | `scripts/run-hourly.sh`                                                |
| Install / refresh cron      | `scripts/install-cron.sh`                                              |
| Remove cron                 | `crontab -e` → delete the `managed-by:ibkr-sync` line, save            |
| Tail today's log            | `tail -f logs/sync-$(date -u +%Y%m%d).log`                             |
| Dry-run from fixture        | `WEALTHFOLIO_PASSWORD=… npx tsx src/sync.ts --from=fixtures/… --dry-run` |
| Force-resync (delete + run) | Delete activities/account in Wealthfolio UI, then `scripts/run-hourly.sh` |
| Unit + integration tests    | `npx vitest run` (integration tests skipped without `WF_INTEGRATION=1`) |
| Typecheck                   | `npx tsc --noEmit`                                                     |

## Knobs

The routine prompt (`scripts/routine-prompt.txt`) bakes in:
- IBKR trades lookback: **DAYS_7** (overlaps prior runs; dedup handles repeats)
- Wealthfolio account name: **IBKR**
- providerAccountId: **IBKR-MAIN**
- Wealthfolio URL: **http://localhost:8088**

Change any of these by editing the prompt file — no rebuild needed.

Env knobs:
- Closed/expired grace window: `IBKR_CLOSING_GRACE_DAYS` (sync tool, default 1)
  and `WF_EXPIRED_OPTION_GRACE_DAYS` (backend, default 1). Just-closed/expired
  positions linger in holdings for this many days, then disappear. State lives
  in `state/positions-state.json` (gitignored). See
  `docs/ibkr-sync/2026-06-04-expiry-grace-design.md`.
- Open orders are fetched only to print `orders=<n>` in the summary; not stored.

For DAYS_30 / longer backfill, run a one-off manually with a separate prompt
or directly invoke `sync.ts` after a manual MCP dump (see CONTEXT.md).

## See also

- `../../docs/ibkr-sync/CONTEXT.md` — project goals, decisions, field mapping
- `../../docs/ibkr-sync/PLAN.md` — original subagent workflow (historical)
- `../../docs/ibkr-sync/API-NOTES.md` — Wealthfolio API cookbook + gotchas
- `../../docs/ibkr-sync/ROUTINE-PROMPT.md` — earlier template for the prompt
  (the actual prompt now lives in `scripts/routine-prompt.txt`)
