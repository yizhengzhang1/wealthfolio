# Holdings — Futu-style metric columns (incl. realized P&L)

Date: 2026-06-04
Status: Approved design, pre-implementation

## Goal

Expand the holdings table to expose the full set of per-position metrics that
the Futu app shows, in a Futu-style layout: a **frozen "name/symbol" column** on
the left and a **horizontally scrollable metric area** on the right, each metric
cell stacking two values (top/bottom). Desktop and mobile share one column
definition.

Reference: `futu/1.jpg`, `futu/2.jpg`, `futu/3.jpg` — same holdings list, swiped
across three metric-column groups.

## Metric → field mapping (verified against backend)

| # | Column | Top | Bottom | Default visible | Backend field |
|---|--------|-----|--------|-----------------|---------------|
| 1 | Name/Symbol (**frozen**) | symbol | name / option subtitle | yes | — |
| 2 | Market value / Qty | `marketValue` | `quantity` | yes | exists |
| 3 | Price / Avg cost | `price` | `costBasis ÷ (quantity × multiplier)` | yes | derived |
| 4 | Day P&L | `dayChange` | — | yes | exists |
| 5 | Unrealized P&L | `unrealizedGain` | `%` | scroll | exists |
| 6 | Realized P&L | `realizedGain` | — | scroll | **NEW (must add)** |
| 7 | Holding P&L | `totalGain` (= unrealized + realized) | — | scroll | **semantics change** |
| 8 | Weight | `weight` | — | scroll | exists |

% is shown only on the Unrealized column, matching Futu.

### Data reality (why backend work is required)

Confirmed in code:

- `holdings_valuation_service.rs:256-258`
  ```rust
  holding.realized_gain = None;                          // always None today
  holding.total_gain = holding.unrealized_gain.clone();  // total == unrealized
  ```
- `Position` (`positions_model.rs`) has no cumulative realized-P&L field. The lot
  engine computes `cost_basis_removed` on a sale but discards it.
- The IBKR sync is **positions-only** (`tools/ibkr-sync/README.md:32`,
  `POST /snapshots/import`); no buy/sell activities reach Wealthfolio, so the lot
  engine has nothing to compute realized P&L from.
- IBKR data sources:
  - `get_account_positions` → `unrealized_pnl` only (no realized).
  - `get_account_summary` → no realized/pnl fields.
  - `get_account_trades` → **`realized_pnl` per trade** (BUY rows = 0). This is
    the only realized source. The current routine does **not** fetch trades
    (`scripts/routine-prompt.txt` lists positions/balances/summary/orders only;
    `parseTrades`/`ibkrTradeToActivity` exist but are legacy/test-only).

So realized P&L must be **accumulated from IBKR trades by the sync tool** and
pushed into the snapshot as a new per-position field. It can only accumulate from
the first tracked day onward (older history needs a one-time wide-window
backfill).

## Architecture — three layers

### Layer ① Frontend (Futu table)

- **Shared column descriptors** — new
  `apps/frontend/src/pages/holdings/utils/holdings-metrics.ts`: a single list
  describing each metric column (id, label, top accessor, bottom accessor,
  formatting, `showPct` flag, group-row behavior). Both surfaces consume it so
  desktop and mobile never drift.
- **Shared DataTable** — `packages/ui/src/components/ui/data-table/index.tsx`:
  add an opt-in `pinFirstColumn?: boolean`. When set, the first header cell and
  first body cell get `sticky left-0 z-…` with a solid background so they stay
  fixed while the metric area scrolls. No behavior change for existing callers.
- **Desktop** — `holdings-table.tsx`: rebuild `getColumns` from the shared
  descriptors into stacked cells per the table above; enable `pinFirstColumn`;
  keep horizontal scroll (`scrollable` already true) and the column show/hide
  menu. Remove the table's Total/Daily toggle (Day and Holding are now separate
  columns); the parent's `showTotalReturn` stays for the summary bar only.
- **Mobile** — `holdings-table-mobile.tsx`: replace the card-list body with a
  compact "frozen first column + horizontally swipeable metric columns" table
  driven by the same descriptors. Keep the existing chrome (search, filter sheet,
  account scope, group/strategy toggles, expand/collapse).
- **Group aggregation** — `utils/group-by-underlying.ts`: add
  `unrealizedGainBase` and `realizedGainBase` to `HoldingGroupRow` and
  `StrategyGroupRow` aggregation (`weight` is already summed). Avg-cost and qty
  stay blank on group rows; price shows the underlying price for an underlying
  group and is blank for a strategy group.

### Layer ② Backend (Rust — realized plumbing)

- `SnapshotPositionInput` (`manual_snapshot_service.rs`) and `Position`
  (`positions_model.rs`): add `realized_gain: Decimal` in the asset's currency,
  `#[serde(default)]` = 0 so existing snapshots deserialize unchanged.
- Snapshot import: carry `input.realized_gain` → `Position.realized_gain`.
- `holdings_service.rs` (holding construction ~L267): set
  `realized_gain: Some(MonetaryValue { local: snapshot_pos.realized_gain, base: 0 })`.
  The multi-account merge already sums `realized_gain` (L718) — keep.
- `holdings_valuation_service.rs`: stop forcing `realized_gain = None`. Convert
  realized local→base with the same fx factor used for unrealized; set
  `realized_gain_pct`; set **`total_gain = unrealized_gain + realized_gain`** and
  recompute `total_gain_pct`. Apply at all three valuation branches (security,
  cash already zero, options).
- Scope: realized flows only through the **snapshot/broker-fed** path.
  Activity-only accounts keep `realized_gain = None` (lot-engine realized is a
  separate future feature, out of scope here).

### Layer ③ ibkr-sync (TS — realized accumulation)

- `scripts/routine-prompt.txt`: add `get_account_trades` (lookback window,
  overlapping prior runs) to the allowed tools and the fetch step.
- `src/state.ts`: extend the persisted state (`state/positions-state.json`) with
  a realized ledger — a set of seen `trade_id`s plus a running
  `cumulativeRealized` per asset key. Dedup by `trade_id` so overlapping windows
  never double-count.
- `src/sync.ts`: fetch trades, for each unseen `trade_id` add its `realized_pnl`
  to `cumulativeRealized[assetKey]`, mark it seen, then attach
  `cumulativeRealized[assetKey]` as `realizedGain` on the matching snapshot
  position.
- `src/mapping.ts`: map trade `symbol`/`sec_type` to the same `assetId` the
  snapshot uses (including option OCC symbols), so realized lands on the right
  row.
- One-time backfill: a manual wide-window run (e.g. 365 days, bounded by IBKR
  API depth) seeds `cumulativeRealized` before the hourly job takes over.

## Data flow

```
IBKR get_account_trades ─(realized_pnl/trade)─► sync: dedup+accumulate per asset
        │                                              │
        ▼                                              ▼
state/positions-state.json (ledger)        snapshot position.realizedGain
                                                       │
                                            POST /snapshots/import
                                                       ▼
                            Position.realized_gain (persisted)
                                                       ▼
                            Holding.realized_gain  ; total = unrealized + realized
                                                       ▼
                    Futu table column 6 (已实现) + column 7 (持仓 = 未实现+已实现)
```

## Phasing

- **Phase A — backend realized plumbing.** Field on input/Position/Holding;
  valuation math (`total = unrealized + realized`, base, pct). Unit-testable by
  injecting `realized_gain` on a snapshot input.
- **Phase B — ibkr-sync accumulation.** Fetch trades, ledger, attach to snapshot.
  Feeds real data into Phase A.
- **Phase C — frontend Futu table.** Shared descriptors, `pinFirstColumn`,
  desktop rebuild, mobile rebuild, group aggregation. Can run in parallel with
  A/B since `Holding.realizedGain` already exists in the TS type (reads 0/None
  until A/B land).

## Risks / open items (default decisions; flag during implementation)

1. **IBKR `realized_pnl` semantics** — assumed: per-closing-trade realized,
   summed over the position's life = lifetime realized. Must verify against real
   data whether IBKR resets it (e.g. YTD). Top risk; validate in Phase B before
   trusting the number.
2. **History start** — cumulative realized only from first tracked day; a one-off
   wide-window backfill seeds it. Pre-history realized may still be incomplete if
   IBKR's lookback is shorter than the position's life.
3. **Desktop "swipe column groups"** — implemented as frozen first column +
   horizontal scroll (not snap-to-group). 
4. **Option average cost** = `costBasis ÷ (quantity × 100)` (per-share premium),
   consistent with the recent contract-multiplier cost-basis fix.
5. **Currency** — realized stored in asset currency, converted to base by the fx
   factor like other monetaries; respects the existing base/local display toggle.

## Out of scope

- Realized P&L for activity-entered (non-snapshot) accounts via the lot engine.
- Greeks / option analytics (a later phase).
- Changing the summary bar's existing Total/Daily behavior.
