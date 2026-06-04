# Realized P&L view (per-underlying, closed positions included)

Date: 2026-06-04
Status: Approved design, pre-implementation
Builds on: the Futu-columns feature (frontend + backend realized plumbing + ibkr-sync
realized ledger), all merged to main at `370e2ada`.

## Goal

A dedicated **Realized P&L** page that lists realized gain/loss **per underlying**,
including **fully-closed** positions (not just current holdings), sourced from the
ibkr-sync trade ledger — not from current positions. This is the surface the
holdings table cannot provide: the holdings "Realized" column only shows
currently-held rows (≈0 for an options-heavy, churn-heavy account), while this
view shows every underlying with realized trades this year.

## Why a separate view (the problem this solves)

Real-data investigation of the user's IBKR account (1258 YTD trades) established:

- The Futu-columns "Realized" **column** on the holdings table shows ≈0 for this
  user because (a) their realized is dominated by **options**, and option realized
  is keyed `OPT:<underlying>` and is not stamped onto OCC option rows (a data
  limitation — trades carry only the short symbol, no con_id/OCC), and (b) their
  large realized is on **closed** underlyings (e.g. Li Auto `2015`) not present in
  the holdings snapshot at all.
- So realized must be shown in its own view fed by the **ledger** (which keeps an
  entry for every underlying that ever had a realized trade, closed or not).

## Key data findings (verified against real IBKR data)

1. **All three close types are already captured** by the existing
   `applyTradesToLedger` sum model — no special handling needed:
   - Regular close (exchange-executed LIMIT/MARKET) → trade `realized_pnl`.
   - **Expired worthless** → IBKR emits a synthetic trade `order_type:"OTHER"`,
     `price:0`, with `realized_pnl` = the premium gain/loss (483 such trades in
     the sample, summing +12,749 in mixed local ccy).
   - **Exercised / assigned** → the option is removed at `realized_pnl:0` and a
     stock delivery trade is emitted; the P&L defers into the resulting stock
     cost basis and realizes when that stock is later sold (a normal STK trade).
     No double-count.
2. **`realized_pnl` is in the contract's LOCAL currency, not base.** The account
   is multi-currency: USD realized −16,923, **HKD realized −57,350** (Li Auto +
   HK options), CNH 0. The base-USD total is ≈ **−24,242 USD** (HKD×~0.1276),
   NOT the −74k that naively summing mixed currencies produces. → the ledger and
   the view MUST track currency and convert to base.
3. **Options can only be aggregated per underlying.** Trades carry only the short
   symbol (`SPX`) + `sec_type:OPT`, never the OCC/con_id. So option realized is
   `OPT:<underlying>`; per-specific-contract realized is impossible from this
   source.

## Scope (user decisions)

- **Granularity:** per **underlying** — combine the stock symbol and its options
  (e.g. `2015` stock + `OPT:2015` options → underlying `2015`). Each underlying is
  single-currency.
- **Time window:** **YTD** (the current ibkr-sync fetch). Older closes need a
  per-quarter backfill (documented, not automated here).
- **Location:** a **dedicated top-level page** `/realized` with a sidebar nav
  item, sibling to Income / Performance — NOT a holdings-page tab (realized is
  past/history, not current holdings).
- **Detail:** total realized per underlying only — no expiry-vs-traded breakdown.
- **Closed positions:** shown (the whole point). Source is the ledger, which
  retains entries for fully-exited underlyings.

## Architecture (Approach A — attach to snapshot + KV blob + read endpoint)

Chosen over (B) a dedicated table+endpoints (needs a Diesel migration) and (C)
pushing trades as activities for native lot-engine realized (largest change,
conflicts with the positions-only snapshot architecture, and still can't do
per-OCC options). A is the most surgical: reuse the one POST the sync already
makes, store a small JSON blob in the existing `app_settings` KV table (zero
migration), convert to base on read.

### Layer ① ibkr-sync (`tools/ibkr-sync`)

- **Ledger gains currency.** `RealizedLedger.cumulativeRealizedByAsset` becomes
  `Record<string, { amount: number; currency: string }>` (was `Record<string,
  number>`). `applyTradesToLedger` reads `trade.currency` when accumulating.
  Bump the state `version` 2→3. v2 entries are bare numbers with no currency;
  rather than guess one, the v2→v3 migration in `loadState` **clears both
  `seenTradeIds` and `cumulativeRealizedByAsset`** so the next run rebuilds the
  currency-aware ledger from a fresh trade fetch. Safe because the realized ledger
  only just shipped (no irreplaceable history); the first post-migration run
  should use a backfill window to re-seed (see limitation #4).
- **Per-underlying transform.** Add `realizedByUnderlying(ledger)` →
  `[{ underlying, currency, realizedLocal }]`: strip the `OPT:` prefix from option
  keys, group by the resulting underlying, sum `amount` per underlying (each
  underlying is single-currency; if a mixed-currency underlying ever appears,
  keep them as separate entries keyed by `underlying+currency` and log a warning).
- **Attach to the snapshot POST.** Add the list to the snapshot import payload as
  a new `realized` field (see Layer ②). One extra field on the existing POST — no
  new request.

### Layer ② Backend (Rust — `wealthfolio-server` / `wealthfolio-core`)

- **Import payload.** `HoldingsSnapshotInput` gains
  `realized: Vec<RealizedEntryInput>` (`#[serde(default)]`), where
  `RealizedEntryInput { underlying: String, currency: String, realized_local:
  Decimal }` (camelCase JSON: `underlying`, `currency`, `realizedLocal`).
  `realizedLocal` is a bare JSON **number** (rust_decimal `serde-float`), matching
  the `realizedGain` contract from the Futu-columns work — the sync sends a number.
- **Store.** In the snapshot import handler, after persisting positions, write the
  list as a JSON blob to the existing `app_settings` KV table under key
  `realized_pnl:{account_id}` (upsert/replace). Zero schema migration — mirrors
  how the spending module uses `app_settings`. Empty list → clear the key.
- **Read endpoint.** New `GET /api/v1/realized-pnl?accountId=…` (account-scope
  aware like `/income`): load the blob(s) for the resolved account ids, convert
  each entry's `realizedLocal` → base with the same FX path `holdings_service`
  uses, and return `{ entries: [{ underlying, currency, realized: { local, base }
  }], total: { base } }` sorted by `|base|` desc. For multi-account scope, merge
  by underlying (summing base; local only meaningful per-currency, so keep the
  first currency or omit local when an underlying spans currencies — single
  account is the norm).
- Dual-surface parity: the server route is the one ibkr-sync + the web frontend
  use; a Tauri command is out of scope (desktop isn't the user's surface) but
  noted for future parity.

### Layer ③ Frontend (`apps/frontend`)

- **New page** `RealizedPnlPage` at route `/realized` (`routes.tsx`) + a sidebar
  nav item "Realized P&L" in `pages/layouts/navigation/app-navigation.tsx`
  (sibling to Income/Performance).
- **Modeled on `income-page.tsx`:** a `useQuery` keyed by
  `[QueryKeys.REALIZED_PNL, accountFilter]` → `getRealizedPnl(accountFilter)`
  adapter → the GET endpoint; a base-currency total card; a per-underlying ranked
  list (underlying symbol/avatar, local amount, base amount) sorted by `|base|`;
  `AccountScopeSelector`; balance-privacy + `AmountDisplay`.
- No FX in the frontend — the endpoint returns pre-converted `{ local, base }`
  (the frontend has no arbitrary-pair FX hook; conversion is server-side, matching
  the holdings pattern).

## Data flow

```
IBKR trades ─(realized_pnl, currency)→ ledger {amount,currency} per asset key
   │ (sync) realizedByUnderlying(): strip OPT:, group → [{underlying,currency,realizedLocal}]
   ▼
snapshot POST  { positions:[…], realized:[…] }
   ▼
import handler → app_settings["realized_pnl:{account}"] = JSON blob
   ▼
GET /realized-pnl?accountId  → fx-convert local→base, sort, total
   ▼
RealizedPnlPage  (/realized, nav item)  → total card + per-underlying list
```

## Known limitations / open items

1. **Options only to underlying level** — trades carry no OCC/con_id; per-contract
   realized is impossible from this source. (Surfaced in the view as per-underlying.)
2. **YTD window** — only realized from closes in the fetched window. Older closes
   need a one-off per-quarter backfill (documented in the ibkr-sync README).
3. **YTD-reset semantics — VALIDATED:** IBKR `realized_pnl` is a per-trade delta
   (proven: last-by-time ≠ cumulative for SPX/TSLA), so summing is correct.
4. **v2→v3 ledger migration clears the realized ledger** (clears `seenTradeIds` +
   `cumulativeRealizedByAsset`) to rebuild currency-aware; first post-migration run
   should use a backfill window to re-seed.
5. Multi-account / multi-currency-per-underlying are edge cases handled
   conservatively (merge by underlying base; per-currency kept separate if needed).

## Out of scope

- Per-contract (OCC) option realized; close-reason breakdown (expiry vs traded);
  all-time history beyond a manual per-quarter backfill; a Tauri desktop command
  for the read endpoint; realized for non-ibkr-sync (manual) accounts.
