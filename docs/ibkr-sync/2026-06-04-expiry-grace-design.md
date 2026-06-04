# IBKR Sync — Closed/Expired Position Grace Window (Feature 1)

> Design spec. 2026-06-04. Scope: show recently closed / expired positions in
> Wealthfolio holdings for a ~1-day grace window, then auto-remove. Trade-history
> sync (Feature 2) is **deferred**; live orders get a **log count only**.

## 1. Goal

Today the hourly IBKR→Wealthfolio sync skips any position with `position == 0`
(`src/mapping.ts:217`, `src/sync.ts:160,215`). When an option expires or a
position is closed, it vanishes from the holdings view immediately. We want
those just-closed / just-expired positions to **linger for ~1 day** so the user
can see what happened, then disappear automatically.

## 2. Backend reality (why the naive approach fails)

Verified against the Rust source (high confidence):

- **Snapshot import = full replacement** per `(accountId, date)`. Current
  holdings come **strictly from the latest snapshot date**; a position absent
  from the newest snapshot disappears.
  (`snapshot/manual_snapshot_service.rs`, `holdings_service.rs:583-608`,
  `storage-sqlite/.../snapshot/repository.rs:114-130,723-753`)
- **Zero-qty positions are dropped at import**:
  `if holding.quantity.is_zero() { continue; }`
  (`manual_snapshot_service.rs:97-100`) — they never reach the DB.
- **Zero-qty positions are hidden at display**: `.filter(|p| p.quantity != 0)`
  (`holdings_service.rs:156`).
- **Expired options are hidden at display AND zero-valued**:
  `is_expired_option()` skip (default `skip_expired_options = true`,
  `holdings_service.rs:70-105,223-239`); if one slips through it is valued to
  `$0` with `unrealized_gain = -cost_basis`
  (`holdings_valuation_service.rs:226-261,661-668`).
- **No TTL / staleness / "closed position" concept** anywhere.

Crucially, **IBKR `get_account_positions` reports a closed position with
`position:0, average_price:0, market_value:0`** — it no longer carries the
original quantity or cost (observed 2026-06-04: INTC Jul puts/calls flat, SPX
0603 puts expired). So faithful display of "you held N, P&L was X" requires the
sync tool to **remember the last non-zero snapshot of each position**.

## 3. Scope

In:

- Re-inject **both** classes of just-gone positions for a grace window:
  - **EXPIRED** options (expiration ≤ today) → shown `$0` with full
    premium loss (truthful).
  - **CLOSED-by-trading** positions (qty 0 but not expired) → shown as a `$0`,
    no-P&L "recently closed" marker (does **not** inflate net worth, does **not**
    fake a full loss).
- Report current open-order **count** in the summary line.

Out (separate future work):

- IBKR trade-history sync (Feature 2). Option trades from the MCP lack contract
  detail (only the underlying symbol), so they can't be modeled cleanly; deferred.
- Storing live orders in Wealthfolio (no entity exists for them).
- **Holdings P&L correctness** — user suspects the existing P&L calc is wrong;
  tracked as its own task (memory: `holdings-pnl-suspected-bug`). NOT addressed here.

## 4. Design

Three parts: a sync-tool **state file**, a **re-injection** step, and a minimal
**backend display patch**.

### 4.1 State file — `tools/ibkr-sync/state/positions-state.json` (gitignored)

Persists across runs (the hourly cron is the only writer).

```jsonc
{
  "version": 1,
  "lastRunUtc": "2026-06-04T02:37:00Z",     // informational
  "live": {                                  // last-known NON-ZERO positions
    "<contractId>": {
      "contractId": 875003852,
      "contractDescription": "INTC ...",
      "occSymbol": "INTC  260717P00100000",  // null for stocks
      "instrumentType": "OPTION",            // or "EQUITY"
      "expiration": "2026-07-17",            // null for stocks
      "quantity": "1",                       // signed, last non-zero
      "avgCost": "6.85",
      "currency": "USD",
      "lastSeenDate": "2026-06-04"
    }
  },
  "closing": {                               // in the grace window
    "<contractId>": {
      /* identity + quantity + avgCost copied from `live` at close time */
      "closedDate": "2026-06-04",            // first run that saw it gone
      "kind": "EXPIRED"                      // or "CLOSED"
    }
  }
}
```

### 4.2 Per-run algorithm (`src/state.ts` + wired into `src/sync.ts`)

Given the parsed IBKR positions and `today` (UTC):

1. Load state (init empty on first run / parse error → warn, continue).
2. `liveNow` = positions with `quantity != 0`. `presentIds` = all contract_ids
   in the response.
3. **Detect newly closed**: for each `contractId` in `state.live` not in
   `liveNow`:
   - Add to `state.closing` (if absent) with `closedDate = today`,
     `kind = (expiration && expiration <= today) ? "EXPIRED" : "CLOSED"`,
     copying its last-known `quantity`/`avgCost`.
   - Remove it from `state.live`.
4. **Refresh** `state.live` from `liveNow` (qty, avgCost, lastSeenDate, …).
5. **Expire grace**: drop any `state.closing` entry where
   `daysBetween(closedDate, today) > GRACE_DAYS` (`IBKR_CLOSING_GRACE_DAYS`,
   default 1 → shown on the close day and the next day, gone the day after).
   Also drop EXPIRED entries whose `expiration < today - GRACE_DAYS` (keeps the
   sync aligned with the backend display patch).
6. **Build re-injection rows** from `state.closing`:
   - `EXPIRED` → `{ symbol: occSymbol, quantity: lastQty, avgCost: lastAvgCost,
     currency, instrumentType: "OPTION" }`. Ensure the option asset exists
     (`findOrCreateAsset`, idempotent) and set `assetId`. Backend (grace-patched)
     shows it, values `$0`, surfaces the full premium loss.
   - `CLOSED` → `{ symbol, quantity: lastQty, avgCost: "0", currency,
     instrumentType }`. `avgCost 0` ⇒ synthesized quote `0` ⇒ `market_value 0`,
     `cost_basis 0`, `unrealized 0`. Informational row, no net-worth impact, no
     fake loss. (No backend change needed — not expired, qty non-zero passes
     both filters.)
7. **Merge & push**: `positions = liveMapped + reinjectionRows`; existing
   snapshot + option-asset + option-quote flow unchanged. Save state back.

### 4.3 Backend display patch (built into the `patched-local` override image)

Only the **expired-option skip** is relaxed; valuation stays as-is (so expired
options still show `$0`).

- `crates/core/src/portfolio/holdings/holdings_service.rs`: at the skip site
  (~223-239), replace the strict `is_expired_option()` check with a
  grace-aware one — skip only if `expiration < today - WF_EXPIRED_OPTION_GRACE_DAYS`
  (env, default `1`; `0` = original behavior). Leave the valuation-path
  `is_expired_option()` (226-261) untouched so grace-window options are still
  valued to `$0` with full loss.
- Rebuilt via the existing `compose.override.yml` (`build context: .`, full
  source compile). Consistent with the existing `manual_snapshot_service.rs`
  contract-multiplier patch.

### 4.4 Orders (log count only)

- `scripts/routine-prompt.txt`: also call
  `mcp__…IBKR__get_account_orders` and write its response under `"orders"` in
  `/tmp/ibkr-raw.json`.
- `src/sync.ts`: read `raw.orders`, count, append `orders=<n>` to the summary
  line. Not stored in Wealthfolio.

## 5. Valuation semantics (what the user sees during grace)

| Class            | qty shown        | value | P&L shown                | net-worth impact |
| ---------------- | ---------------- | ----- | ------------------------ | ---------------- |
| EXPIRED option   | last non-zero    | `$0`  | full premium loss (true) | none (`$0`)      |
| CLOSED option    | last non-zero    | `$0`  | none                     | none (`$0`)      |
| CLOSED stock¹    | last non-zero    | `$0`* | none                     | minor wobble¹    |

¹ Closed **stocks** use `MARKET` quote mode, so Wealthfolio's Yahoo provider may
reprice them above `$0` during the grace day (minor net-worth wobble). The user's
closed positions are overwhelmingly options, so this is accepted; documented, not
fixed here.

## 6. Edge cases & caveats

- **Warm-up**: positions that closed/expired *before* the state file existed
  (e.g. the SPX 0603 puts that expired 2026-06-03) have no last-known data and
  cannot be re-injected on the first cycles. Going forward, every position is
  captured while still open. Acceptable.
- **Hourly idempotency**: multiple runs/day rewrite the same date's snapshot
  (full replacement) — re-injection is deterministic from state, so repeated runs
  converge. `closedDate` is set once (first observation of closure).
- **Grace boundary**: `GRACE_DAYS` default 1 → visible on close day + next day.
  Both the sync re-injection window and the backend expired-display window read
  their own env (`IBKR_CLOSING_GRACE_DAYS`, `WF_EXPIRED_OPTION_GRACE_DAYS`); keep
  them equal (both 1) for aligned behavior.
- **Multi-currency**: re-injection preserves each position's `currency`; no FX
  conversion introduced.
- **State corruption**: unreadable/invalid state → log a warning, treat as empty,
  proceed with live positions only (sync never fails because of state).

## 7. Files touched

Sync tool (`tools/ibkr-sync/`):

- `src/state.ts` *(new)* — load/save + the close-detection / grace state machine
  (pure, unit-tested).
- `src/sync.ts` — wire state in after parsing; build + merge re-injection rows;
  add `orders` count to the summary.
- `src/ibkr.ts` — add a tiny `parseOrders` (count only) if needed.
- `scripts/routine-prompt.txt` — add the `get_account_orders` call + `orders` key.
- `.gitignore` — add `state/`.

Backend (built into override image):

- `crates/core/src/portfolio/holdings/holdings_service.rs` — grace-aware expired
  skip + a focused Rust unit test (existing tests at 1412-1443 as a template).

## 8. Testing (TDD)

- `test/state.test.ts` *(new)*: new-close detection (EXPIRED vs CLOSED
  classification), grace expiry boundary (0/1/2 days), warm-up (no prior data),
  state round-trip, corruption fallback.
- Extend `test/` for sync wiring: re-injection rows merged, EXPIRED carries
  avgCost (loss), CLOSED forces avgCost 0, `orders` count surfaced.
- Backend: Rust unit test asserting an option expired within
  `WF_EXPIRED_OPTION_GRACE_DAYS` is NOT skipped, and one beyond it IS.
- Manual: run `scripts/run-hourly.sh` against the rebuilt image; verify a
  just-expired option shows `$0` today and is gone after the grace window.

## 9. Out of scope / follow-ups

- Feature 2 (trade history) — deferred; MCP option trades lack contract detail.
- Holdings P&L correctness — separate task (`holdings-pnl-suspected-bug`).
