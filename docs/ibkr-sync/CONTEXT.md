# IBKR → Wealthfolio Sync — Project Context

> Fork-specific overlay. Upstream architecture docs in `/AGENTS.md` and
> `/.claude/CLAUDE.md` are authoritative for everything else.

## Goal

Periodically (default every hour, configurable) pull the user's IBKR account
positions and trades from the **Interactive Brokers MCP server bound to Claude
Code**, and push them into a **self-hosted Wealthfolio web instance** so the
user can view live broker state in the browser.

Claude Code is the scheduler and the only thing that has IBKR credentials
(via MCP). Wealthfolio is a sink — it just receives data over its REST API.

## Non-Goals

- Modifying Wealthfolio's upstream source. Add no `crates/connect` provider for
  IBKR. (Reason: the IBKR MCP only lives inside Claude Code; the Wealthfolio
  backend has no way to call it. A native provider would need a parallel
  credential path and re-implement what we already have via MCP.)
- Order placement / writes back to IBKR. Read-only.
- Full transaction history backfill from IBKR Flex Query (out of MCP scope).

## Scope (MVP)

In:

- **Positions snapshot** — `get_account_positions` → import as Wealthfolio
  holdings snapshot.
- **Recent trades** — `get_account_trades` (BUY/SELL on STK) → write as
  Wealthfolio `Activity` rows, idempotent.

Deferred:

- Dividends, deposits, withdrawals, interest, fees — IBKR MCP doesn't surface
  per-event records. Requires Flex Query integration (separate project).
- Options (`sec_type:OPT`) — `contract_description` parsing needed.
- FX conversions (`sec_type:CASH`) — Wealthfolio has no native FX activity
  type; filter out in MVP.
- Corporate actions (`order_type:OTHER`, price 0) — handle case-by-case later.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Claude Code (scheduled via /schedule or cron)                 │
│                                                                │
│  tools/ibkr-sync/sync.ts (or .py)                              │
│   1. IBKR MCP   → positions, trades                            │
│   2. transform  → Wealthfolio Activity / Holdings snapshot     │
│   3. HTTP POST  → Wealthfolio REST API                         │
└────────────────────────────────────────────────────────────────┘
                          │
                          ▼ HTTP /api/v1/*
┌────────────────────────────────────────────────────────────────┐
│  Wealthfolio self-host (docker compose, :8088)                 │
│                                                                │
│  Axum (apps/server) → crates/core → SQLite                     │
│  Browser UI → :8088                                            │
└────────────────────────────────────────────────────────────────┘
```

The sync script lives **outside** the Wealthfolio source tree
(`tools/ibkr-sync/` at repo root or even in a separate location) so it doesn't
collide with upstream files at merge time.

## Wealthfolio REST API Surface We Touch

Base: `http://<host>:8088/api/v1/`
Auth: Bearer JWT obtained from password login (Argon2id). Header:
`Authorization: Bearer <token>`.

| Purpose             | Endpoint                                     | File                                          |
| ------------------- | -------------------------------------------- | --------------------------------------------- |
| List/create account | `GET/POST /accounts`                         | `apps/server/src/api/accounts.rs`             |
| Create activity     | `POST /activities`                           | `apps/server/src/api/activities.rs`           |
| Batch import CSV    | `POST /activities/import` (multipart)        | `apps/server/src/api/activities.rs`           |
| Holdings snapshot   | `POST /snapshots/import`                     | `apps/server/src/api/holdings/mod.rs`         |
| Login (get JWT)     | (see auth handler in `apps/server/src/api/`) | TBD — verify endpoint name during sync impl |

Key model fields (see `crates/core/src/activities/activities_model.rs:99`):

- `idempotency_key` — **use IBKR `trade_id` here** to dedupe across runs.
- `source_system: "IBKR"`, `source_record_id: trade_id`
- `provider: "IBKR"`, `provider_account_id: <ibkr account>` on the account
- `tracking_mode: "TRANSACTIONS"` so Wealthfolio recomputes holdings from
  activities (don't mix snapshots + activities on the same account).

Activity type enum
(`crates/core/src/activities/activities_constants.rs`):

```
BUY, SELL, SPLIT
DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, FEE, TAX, CREDIT
DIVIDEND, INTEREST
ADJUSTMENT, UNKNOWN
```

## IBKR MCP — Data Inventory

All tools have prefix `mcp__claude_ai_Interactive_Brokers_IBKR__`. Single
authenticated account, no `account_id` parameter on any tool.

### get_account_positions (read-only)

Fields per row:
`contract_id, contract_description, position, market_price, market_value,
currency, average_price, unrealized_pnl, asset_class?`

Example (STK): `{contract_id:1001, contract_description:"ACME",
position:6.2, average_price:90, currency:"USD", asset_class:"STK"}`

### get_account_trades (read-only)

Optional `period`: `TODAY | DAYS_7 | DAYS_30 | DAYS_60 | DAYS_90 |
MONTH_TO_DATE | YEAR_TO_DATE | ...`. Default `TODAY`.

Fields per row:
`trade_id, symbol, company_name?, sec_type (STK|OPT|CASH), currency, side
(BUY|SELL), size, price, order_type, trade_time (ISO-8601 UTC), commission,
net_amount, realized_pnl, order_id`

### get_account_summary / get_account_balances

Aggregated metrics + per-currency balances. Useful for sanity-checking
post-sync (totals should match).

## Field Mapping (IBKR trade → Wealthfolio Activity)

| Wealthfolio        | IBKR                                            | Notes                                   |
| ------------------ | ----------------------------------------------- | --------------------------------------- |
| `activity_type`    | `side` (BUY/SELL)                               | Skip rows where `sec_type != STK` (MVP) |
| `quantity`         | `size`                                          |                                         |
| `unit_price`       | `price`                                         |                                         |
| `fee`              | `commission`                                    |                                         |
| `currency`         | `currency`                                      |                                         |
| `activity_date`    | `trade_time`                                    | UTC ISO-8601, Wealthfolio expects same  |
| `asset_id`         | resolve from `symbol`                           | Wealthfolio may need symbol lookup      |
| `idempotency_key`  | `trade_id`                                      | Primary dedupe key                      |
| `source_record_id` | `trade_id`                                      |                                         |
| `source_system`    | `"IBKR"`                                        |                                         |
| `account_id`       | mapped from a single configured Wealthfolio acc | One IBKR account → one Wealthfolio acc  |

## Open Questions (resolve during impl)

1. **Auth endpoint name and payload** — `/auth/login`? `/sessions`? Need to
   read `apps/server/src/api/auth*.rs` (or grep `password_hash`).
2. **`asset_id` resolution** — does `POST /activities` accept a raw `symbol`
   and resolve internally, or do we need to create the asset first? Test with
   one BUY first.
3. **Holdings snapshot format** — `POST /snapshots/import` expects what shape?
   Read handler + the existing CSV import path for reference.
4. **Account creation idempotency** — second run must not create a duplicate
   IBKR account. Use `provider_account_id` lookup before POST.
5. **Currency mismatch** — IBKR account is multi-currency (USD/HKD/CNH
   observed). Wealthfolio account has a single base `currency`. Decide: one
   Wealthfolio account per IBKR currency, or one account with mixed-currency
   activities.

## References

- Upstream architecture: `/AGENTS.md`, `/.claude/CLAUDE.md`
- Self-host setup: `/docs/self-host/README.md`, `/compose.yml`,
  `/.env.web.example`
- Activity model: `/crates/core/src/activities/activities_model.rs`
- Server API: `/apps/server/src/api/`
- Existing broker sync (Trading212, reference only): `/crates/connect/`
