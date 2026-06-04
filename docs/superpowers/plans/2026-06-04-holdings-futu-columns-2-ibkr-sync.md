# IBKR-Sync Realized P&L Accumulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accumulate per-asset realized P&L from IBKR `get_account_trades` inside the ibkr-sync tool (deduped by `trade_id`, persisted in `state/positions-state.json`) and attach it as `realizedGain` on the matching snapshot position pushed to Wealthfolio.

**Architecture:** A pure "realized ledger" lives in `state.ts` as a new field on `SyncState` (`seenTradeIds` + `cumulativeRealizedByAsset`). `sync.ts` fetches trades (already in the raw dump under `raw.trades`), folds them into the ledger via the pure function, then looks up each snapshot row's asset key (stock symbol, or option OCC symbol) and stamps `realizedGain`. The grace-window state machine (`reconcile`) is untouched — the ledger rides alongside it on the same persisted object.

**Tech Stack:** TypeScript (ESM, `.js`-extension imports), Zod schemas, Vitest, `tsx` runner. Tool lives outside the pnpm workspace; tests run with `npx vitest run`, typecheck with `npx tsc --noEmit`, both from `tools/ibkr-sync/`.

---

## File Structure

- **Modify** `tools/ibkr-sync/src/state.ts` — add `RealizedLedger` shape to `SyncState` (`version` bump to 2 with v1 migration), `emptyLedger()`, and the pure `applyTradesToLedger(ledger, trades)` fold. Extend `loadState` to default the ledger when absent (old v1 files load clean).
- **Modify** `tools/ibkr-sync/src/ibkr.ts` — add `parseTradesForRealized(raw)` that parses the trades envelope/array and keeps STK + OPT (drops only CASH/FX), without disturbing the existing STK-only `parseTrades`.
- **Modify** `tools/ibkr-sync/src/mapping.ts` — add `tradeAssetKey(trade)`: stock → `trade.symbol`; option → 21-char OCC symbol derived from the trade. Add a small helper so the key matches the snapshot row's key.
- **Modify** `tools/ibkr-sync/src/wealthfolio.ts` — add `realizedGain?: number` to `HoldingsPositionInput` (camelCase JSON; asset currency). No other change.
- **Modify** `tools/ibkr-sync/src/sync.ts` — read `raw.trades`, fold into the ledger, compute `positionAssetKey(row)` per snapshot row, stamp `realizedGain` from `cumulativeRealizedByAsset`, persist the ledger via `saveState`. Show the ledger size in the dry-run output.
- **Modify** `tools/ibkr-sync/scripts/routine-prompt.txt` — add `get_account_trades` (period `DAYS_7`) to the fetch step and the `/tmp/ibkr-raw.json` shape; document the one-time wide-window backfill.
- **Modify** `tools/ibkr-sync/scripts/run-hourly.sh` — add `get_account_trades` to `--allowedTools`.
- **Modify** `tools/ibkr-sync/README.md` — document the realized ledger + backfill in Knobs/Operations.
- **Create** `tools/ibkr-sync/test/realized.test.ts` — pure-function tests for the ledger, asset-key mapping, parser, and a sync-assembly dry-run test.
- **Modify** `tools/ibkr-sync/fixtures/ibkr-trades.json` — add two CLOSE trades with non-zero `realized_pnl` (a STK close on `ACME` and an OPT close on `ACME 260702C00140000`) so realized accumulation has real numbers to test, and a duplicate `trade_id` re-run scenario is exercisable.

---

## Shared contract (use these EXACT names)

```ts
// state.ts
export interface RealizedLedger {
  seenTradeIds: string[];                          // dedup key set, serialized as array
  cumulativeRealizedByAsset: Record<string, number>; // assetKey -> running realized P&L
}
export interface SyncState {
  version: 2;                                      // was 1; v1 files migrate in loadState
  lastRunUtc?: string;
  live: Record<string, LivePosition>;
  closing: Record<string, ClosingPosition>;
  realized: RealizedLedger;                         // NEW
}
export function emptyLedger(): RealizedLedger;
export function applyTradesToLedger(ledger: RealizedLedger, trades: IbkrTrade[]): RealizedLedger;

// mapping.ts
export function tradeAssetKey(trade: IbkrTrade): string | null;   // stock symbol | OCC | null(CASH)
export function positionAssetKey(row: HoldingsPositionInput): string; // matches tradeAssetKey

// wealthfolio.ts (HoldingsPositionInput)
realizedGain?: number;   // asset currency
```

Asset-key rule (must be identical on both sides so realized lands on the right row):
- **Stock**: key = the snapshot row's `symbol` (a bare ticker, e.g. `"ACME"`), which for trades is `trade.symbol`.
- **Option**: key = the 21-char OCC symbol (e.g. `"ACME  260702C00140000"`), which is the snapshot option row's `symbol`. Trades only carry a short `symbol` (e.g. `"ACME"`) + `sec_type: "OPT"`, so per-asset option realized cannot be keyed precisely from a trade alone — see **Task 3 note**: option realized is summed under the short symbol with an `OPT:` prefix and is NOT matched to a specific OCC row in this phase (documented limitation; stocks are the precise case). This keeps the ledger honest (no silent mis-attribution) and is verified by tests.

---

### Task 1: Realized ledger in `state.ts` (pure fold + dedup)

**Files:**
- Modify `tools/ibkr-sync/src/state.ts` (add types near L44-53; helpers after `emptyState` ~L51-53; import `IbkrTrade`).
- Create/extend `tools/ibkr-sync/test/realized.test.ts`.

The fold: for each trade whose `trade_id` is not already in `seenTradeIds`, add it to the seen set and add its `realized_pnl` to `cumulativeRealizedByAsset[key]` where `key = tradeAssetKey(trade)`. Trades with `key === null` (CASH/FX) are still marked seen (so they don't reaccumulate) but contribute nothing. Re-running the same batch must not double-count.

- [ ] **Step 1.1: Write failing test for empty ledger + single batch fold.**

  Create `tools/ibkr-sync/test/realized.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { applyTradesToLedger, emptyLedger } from '../src/state.js';
  import type { IbkrTrade } from '../src/ibkr.js';

  function trade(overrides: Partial<IbkrTrade> = {}): IbkrTrade {
    const base: IbkrTrade = {
      trade_id: 'tid-1',
      symbol: 'ACME',
      sec_type: 'STK',
      currency: 'USD',
      side: 'SELL',
      size: 100,
      price: 55,
      order_type: 'LIMIT',
      trade_time: '2026-05-30T10:00:00Z',
      commission: 0.5,
      net_amount: 5500,
      realized_pnl: 500,
      order_id: 1,
    };
    return { ...base, ...overrides };
  }

  describe('applyTradesToLedger', () => {
    it('accumulates realized_pnl per asset key from an empty ledger', () => {
      const next = applyTradesToLedger(emptyLedger(), [
        trade({ trade_id: 'a', symbol: 'ACME', realized_pnl: 500 }),
        trade({ trade_id: 'b', symbol: 'ACME', realized_pnl: 250 }),
        trade({ trade_id: 'c', symbol: '9999', currency: 'HKD', realized_pnl: -100 }),
      ]);
      expect(next.cumulativeRealizedByAsset).toEqual({ ACME: 750, '9999': -100 });
      expect(next.seenTradeIds.sort()).toEqual(['a', 'b', 'c']);
    });
  });
  ```

  Run it and watch it fail (the symbols don't exist yet):

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: failure — `Error: Failed to resolve import` / `applyTradesToLedger is not exported` (suite errors, 0 passed).

- [ ] **Step 1.2: Implement `RealizedLedger`, `emptyLedger`, `applyTradesToLedger`.**

  In `tools/ibkr-sync/src/state.ts`, add the trade import at the top (after the existing `node:fs`/`node:path` imports, ~L8):

  ```ts
  import type { IbkrTrade } from './ibkr.js';
  import { tradeAssetKey } from './mapping.js';
  ```

  Replace the `SyncState`/`emptyState` block (current L44-53) with the ledger-aware version:

  ```ts
  /** Cumulative realized P&L, accumulated from IBKR trades and deduped by
   *  trade_id. `cumulativeRealizedByAsset` is keyed by the same asset key the
   *  snapshot row uses (stock symbol, or `OPT:<symbol>` for options). */
  export interface RealizedLedger {
    seenTradeIds: string[];
    cumulativeRealizedByAsset: Record<string, number>;
  }

  export interface SyncState {
    version: 2;
    lastRunUtc?: string;
    live: Record<string, LivePosition>;
    closing: Record<string, ClosingPosition>;
    realized: RealizedLedger;
  }

  export function emptyLedger(): RealizedLedger {
    return { seenTradeIds: [], cumulativeRealizedByAsset: {} };
  }

  export function emptyState(): SyncState {
    return { version: 2, live: {}, closing: {}, realized: emptyLedger() };
  }

  /**
   * Fold a batch of IBKR trades into a realized ledger. Pure.
   *  - each unseen trade_id adds its realized_pnl to its asset key and is marked seen;
   *  - already-seen trade_ids are ignored (dedup across overlapping lookback windows);
   *  - trades with no asset key (CASH/FX) are marked seen but contribute nothing.
   */
  export function applyTradesToLedger(
    ledger: RealizedLedger,
    trades: IbkrTrade[],
  ): RealizedLedger {
    const seen = new Set(ledger.seenTradeIds);
    const byAsset: Record<string, number> = { ...ledger.cumulativeRealizedByAsset };
    for (const t of trades) {
      if (seen.has(t.trade_id)) continue;
      seen.add(t.trade_id);
      const key = tradeAssetKey(t);
      if (key === null) continue;
      byAsset[key] = (byAsset[key] ?? 0) + t.realized_pnl;
    }
    return { seenTradeIds: [...seen], cumulativeRealizedByAsset: byAsset };
  }
  ```

  > NOTE: `tradeAssetKey` is implemented in Task 2. To keep Task 1's test green standalone, add a minimal `tradeAssetKey` stub in `mapping.ts` NOW (Task 2 replaces its body and adds its own tests):
  >
  > ```ts
  > // mapping.ts — minimal version; expanded in Task 2.
  > export function tradeAssetKey(trade: IbkrTrade): string | null {
  >   if (trade.sec_type === 'CASH') return null;
  >   if (trade.sec_type === 'OPT') return `OPT:${trade.symbol}`;
  >   return trade.symbol;
  > }
  > ```
  >
  > Add `import type { IbkrTrade } from './ibkr.js';` to `mapping.ts` — it already imports from `./ibkr.js` (L7), so extend that line: it currently reads `import type { IbkrTrade, IbkrPosition } from './ibkr.js';`, which already includes `IbkrTrade`. No new import needed.

- [ ] **Step 1.3: Run the test, see it pass.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: `Test Files  1 passed (1)`, `Tests  1 passed (1)`.

- [ ] **Step 1.4: Write failing test for the dedup re-run (must NOT double-count).**

  Append to `describe('applyTradesToLedger', ...)` in `test/realized.test.ts`:

  ```ts
    it('does not double-count when the same trades are re-applied (overlapping windows)', () => {
      const batch = [
        trade({ trade_id: 'a', symbol: 'ACME', realized_pnl: 500 }),
        trade({ trade_id: 'b', symbol: 'ACME', realized_pnl: 250 }),
      ];
      const first = applyTradesToLedger(emptyLedger(), batch);
      // simulate a second run whose lookback window re-includes the same trades
      // plus one brand-new trade
      const second = applyTradesToLedger(first, [
        ...batch,
        trade({ trade_id: 'c', symbol: 'ACME', realized_pnl: 100 }),
      ]);
      expect(second.cumulativeRealizedByAsset).toEqual({ ACME: 850 });
      expect(second.seenTradeIds.sort()).toEqual(['a', 'b', 'c']);
    });

    it('marks CASH/FX trades seen but adds nothing', () => {
      const next = applyTradesToLedger(emptyLedger(), [
        trade({ trade_id: 'fx-1', sec_type: 'CASH', symbol: 'USD', realized_pnl: 0 }),
      ]);
      expect(next.cumulativeRealizedByAsset).toEqual({});
      expect(next.seenTradeIds).toEqual(['fx-1']);
    });
  ```

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: PASS (3 tests) — the implementation from Step 1.2 already handles dedup and CASH. (If it fails, the fold is wrong; fix the fold, not the test.)

- [ ] **Step 1.5: Commit.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio && git add tools/ibkr-sync/src/state.ts tools/ibkr-sync/src/mapping.ts tools/ibkr-sync/test/realized.test.ts && git commit -m "ibkr-sync: realized ledger fold in state.ts (dedup by trade_id)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 2: Asset-key mapping (`tradeAssetKey` / `positionAssetKey`)

**Files:**
- Modify `tools/ibkr-sync/src/mapping.ts` (replace the stub `tradeAssetKey` from Task 1; add `positionAssetKey` after `reinjectionToHoldingsPosition` ~L288).
- Modify `tools/ibkr-sync/test/realized.test.ts` (add asset-key tests).

The two keys must agree so the ledger lands on the right snapshot row:
- Stock trade → `trade.symbol`; stock snapshot row → `row.symbol` (a bare ticker). Equal by construction.
- Option trade → `OPT:<short symbol>` (trades lack the full OCC). Option snapshot row → its OCC `symbol`. These do NOT match, which is the documented Phase-B limitation: option realized accumulates under the short symbol but is not stamped onto an OCC row. Stocks are the precise, shipped case. Tests assert exactly this so the limitation is explicit, not accidental.

- [ ] **Step 2.1: Write failing tests for `tradeAssetKey` against the trades fixture.**

  Append a new `describe` block to `test/realized.test.ts`:

  ```ts
  import { tradeAssetKey, positionAssetKey } from '../src/mapping.js';
  import tradesFixture from '../fixtures/ibkr-trades.json' with { type: 'json' };
  import { parseTradesForRealized } from '../src/ibkr.js';
  import type { HoldingsPositionInput } from '../src/wealthfolio.js';

  describe('tradeAssetKey', () => {
    it('keys a STK trade by its bare symbol', () => {
      expect(tradeAssetKey(trade({ sec_type: 'STK', symbol: 'ACME' }))).toBe('ACME');
    });
    it('keys an OPT trade by OPT:<symbol> (trades lack the full OCC)', () => {
      expect(tradeAssetKey(trade({ sec_type: 'OPT', symbol: 'ACME' }))).toBe('OPT:ACME');
    });
    it('returns null for CASH/FX trades', () => {
      expect(tradeAssetKey(trade({ sec_type: 'CASH', symbol: 'USD' }))).toBeNull();
    });
    it('maps every fixture STK trade to a non-null key', () => {
      const stk = parseTradesForRealized(tradesFixture).filter((t) => t.sec_type === 'STK');
      expect(stk.length).toBeGreaterThan(0);
      for (const t of stk) expect(tradeAssetKey(t)).toBe(t.symbol);
    });
  });

  describe('positionAssetKey', () => {
    function row(o: Partial<HoldingsPositionInput> = {}): HoldingsPositionInput {
      return { symbol: 'ACME', quantity: '10', currency: 'USD', instrumentType: 'EQUITY', ...o };
    }
    it('keys an EQUITY row by its symbol (matches a STK trade key)', () => {
      expect(positionAssetKey(row({ symbol: 'ACME', instrumentType: 'EQUITY' }))).toBe('ACME');
    });
    it('keys an OPTION row by its OCC symbol', () => {
      const r = row({ symbol: 'ACME  260702C00140000', instrumentType: 'OPTION' });
      expect(positionAssetKey(r)).toBe('ACME  260702C00140000');
    });
  });
  ```

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: failure — `parseTradesForRealized` and `positionAssetKey` are not exported yet (suite error). (`parseTradesForRealized` is created in Task 4; create it now as a minimal export to unblock — see Step 2.2.)

- [ ] **Step 2.2: Implement `tradeAssetKey`, `positionAssetKey`, and the minimal `parseTradesForRealized`.**

  In `tools/ibkr-sync/src/mapping.ts`, replace the Task-1 stub `tradeAssetKey` with the final body (identical logic, kept here so the file is self-contained):

  ```ts
  /**
   * Asset key for a trade's realized P&L, matching `positionAssetKey`:
   *  - STK → the bare symbol (same as the snapshot row symbol);
   *  - OPT → `OPT:<symbol>`; trades carry only a short symbol, not the 21-char
   *    OCC, so option realized accumulates under this prefix and is NOT matched
   *    to a specific OCC snapshot row in this phase (see plan Task 3 note);
   *  - CASH/FX → null (no realized attribution).
   */
  export function tradeAssetKey(trade: IbkrTrade): string | null {
    if (trade.sec_type === 'CASH') return null;
    if (trade.sec_type === 'OPT') return `OPT:${trade.symbol}`;
    return trade.symbol;
  }

  /** Asset key for a snapshot row, matching `tradeAssetKey` for stocks. EQUITY
   *  rows key on their bare symbol; OPTION rows key on their OCC `symbol`
   *  (which trade keys cannot reproduce — option realized is not stamped here). */
  export function positionAssetKey(row: HoldingsPositionInput): string {
    return row.symbol;
  }
  ```

  In `tools/ibkr-sync/src/ibkr.ts`, add the realized parser right after `parseTrades` (after L131):

  ```ts
  /**
   * Parse `get_account_trades` for the realized ledger. Unlike `parseTrades`
   * (STK-only, legacy), this keeps STK + OPT and drops only CASH/FX, because
   * realized P&L accrues on option closes too. Accepts envelope or bare array.
   */
  export function parseTradesForRealized(raw: unknown): IbkrTrade[] {
    const trades = Array.isArray(raw)
      ? z.array(ibkrTradeSchema).parse(raw)
      : ibkrTradesResponseSchema.parse(raw).trades;
    return trades.filter((t) => t.sec_type !== 'CASH');
  }
  ```

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: `Tests  N passed` (all realized.test.ts tests green; N = current count, ≥9).

- [ ] **Step 2.3: Commit.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio && git add tools/ibkr-sync/src/mapping.ts tools/ibkr-sync/src/ibkr.ts tools/ibkr-sync/test/realized.test.ts && git commit -m "ibkr-sync: tradeAssetKey/positionAssetKey + parseTradesForRealized

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 3: Extend the trades fixture with realized closes

**Files:**
- Modify `tools/ibkr-sync/fixtures/ibkr-trades.json` (append two CLOSE trades with non-zero `realized_pnl`).

The existing fixture has all `realized_pnl: 0` (open trades). To test accumulation end-to-end we need at least one STK close with a real number on `ACME` (the symbol the positions fixture also holds, so the sync test can match it to a row).

- [ ] **Step 3.1: Add the close trades to the fixture.**

  In `tools/ibkr-sync/fixtures/ibkr-trades.json`, inside the `"trades"` array, after the last existing element (the `tid-006` object at the end), add a comma after its closing `}` and append:

  ```json
    {
      "trade_id": "tid-007",
      "symbol": "ACME",
      "company_name": "ACME CORP",
      "sec_type": "STK",
      "currency": "USD",
      "side": "SELL",
      "size": 50,
      "price": 60,
      "formatted_price": "60",
      "order_type": "LIMIT",
      "description": "60 Limit",
      "trade_time": "2026-05-30T15:00:00Z",
      "exchange": "TESTEX",
      "commission": 0.5,
      "net_amount": 3000,
      "realized_pnl": 500,
      "order_id": 1000000007
    },
    {
      "trade_id": "tid-008",
      "symbol": "ACME",
      "sec_type": "OPT",
      "currency": "USD",
      "side": "SELL",
      "size": 1,
      "price": 9,
      "formatted_price": "9",
      "order_type": "LIMIT",
      "description": "9 Limit",
      "trade_time": "2026-05-31T15:00:00Z",
      "exchange": "TESTEX",
      "commission": 1,
      "net_amount": 900,
      "realized_pnl": 200,
      "order_id": 1000000008
    }
  ```

- [ ] **Step 3.2: Verify the fixture still parses and the STK-only count assertion in `ibkr.test.ts` stays valid.**

  `ibkr.test.ts` asserts `parseTrades(fixture)` length equals the STK count in the fixture — adding `tid-007` (STK) keeps that derived assertion correct (it counts dynamically). Run the existing ibkr suite:

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/ibkr.test.ts
  ```

  Expected: `Tests  14 passed` (the count assertion is `tradesFixture.trades.filter(STK).length`, so it self-adjusts; no edit to ibkr.test.ts needed).

- [ ] **Step 3.3: Add a fixture-driven accumulation test.**

  Append to `test/realized.test.ts`:

  ```ts
  describe('applyTradesToLedger against the trades fixture', () => {
    it('accumulates the ACME STK close (500) and the ACME OPT close (200)', () => {
      const trades = parseTradesForRealized(tradesFixture);
      const ledger = applyTradesToLedger(emptyLedger(), trades);
      expect(ledger.cumulativeRealizedByAsset['ACME']).toBe(500);     // STK close
      expect(ledger.cumulativeRealizedByAsset['OPT:ACME']).toBe(200); // OPT close
    });
  });
  ```

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: all realized.test.ts tests pass (the new fixture test included).

- [ ] **Step 3.4: Commit.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio && git add tools/ibkr-sync/fixtures/ibkr-trades.json tools/ibkr-sync/test/realized.test.ts && git commit -m "ibkr-sync: add realized close trades to fixture + accumulation test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 4: Add `realizedGain` to `HoldingsPositionInput` + ledger persistence in state

**Files:**
- Modify `tools/ibkr-sync/src/wealthfolio.ts` (`HoldingsPositionInput`, L103-118).
- Modify `tools/ibkr-sync/src/state.ts` (`loadState` v1→v2 migration, L55-76).
- Modify `tools/ibkr-sync/test/realized.test.ts` (state migration test).

- [ ] **Step 4.1: Write failing test for v1-state migration (old file → empty ledger).**

  Append to `test/realized.test.ts`:

  ```ts
  import { loadState, saveState } from '../src/state.js';
  import { mkdtemp, writeFile } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  describe('loadState ledger migration', () => {
    it('loads an old v1 state file with no realized ledger as an empty ledger', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ibkr-realized-'));
      const path = join(dir, 'positions-state.json');
      // a pre-ledger file: version 1, live/closing only, NO `realized` key
      await writeFile(
        path,
        JSON.stringify({ version: 1, live: {}, closing: {} }) + '\n',
        'utf8',
      );
      const state = await loadState(path);
      expect(state.version).toBe(2);
      expect(state.realized).toEqual({ seenTradeIds: [], cumulativeRealizedByAsset: {} });
      expect(state.live).toEqual({});
      expect(state.closing).toEqual({});
    });

    it('round-trips a v2 state including the ledger', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ibkr-realized-'));
      const path = join(dir, 'positions-state.json');
      const state = emptyState();
      state.realized = { seenTradeIds: ['a'], cumulativeRealizedByAsset: { ACME: 500 } };
      await saveState(path, state);
      expect(await loadState(path)).toEqual(state);
    });
  });
  ```

  Add the import at the top of the file if not already present: `import { emptyState } from '../src/state.js';` (extend the existing `from '../src/state.js'` import line to include `emptyState`).

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: failure on the migration test — old `loadState` rejects `version: 1` content? No: current `loadState` (L58-65) returns the raw object when `version === 1`, so `state.version` would be `1` and `state.realized` would be `undefined`. Assertions `expect(state.version).toBe(2)` and `expect(state.realized).toEqual(...)` FAIL.

- [ ] **Step 4.2: Implement the v1→v2 migration in `loadState`.**

  Replace `loadState` (current L55-76) in `tools/ibkr-sync/src/state.ts`:

  ```ts
  export async function loadState(path: string): Promise<SyncState> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (
        raw &&
        typeof raw === 'object' &&
        (raw as { version?: number }).version != null &&
        (raw as SyncState).live &&
        (raw as SyncState).closing
      ) {
        const s = raw as Partial<SyncState> & { live: SyncState['live']; closing: SyncState['closing'] };
        const realized = s.realized ?? emptyLedger();
        // Backward-compat: v1 files have no `realized` ledger; default it and
        // stamp the current version so the next save writes v2.
        return {
          version: 2,
          lastRunUtc: s.lastRunUtc,
          live: s.live,
          closing: s.closing,
          realized: {
            seenTradeIds: realized.seenTradeIds ?? [],
            cumulativeRealizedByAsset: realized.cumulativeRealizedByAsset ?? {},
          },
        };
      }
      console.warn(`[ibkr-sync] state: unexpected shape at ${path}; starting empty`);
      return emptyState();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[ibkr-sync] state: unreadable ${path} (${code ?? String(err)}); starting empty`);
      }
      return emptyState();
    }
  }
  ```

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts test/state.test.ts
  ```

  Expected: both suites pass. NOTE: `state.test.ts`'s `round-trips a state object` test (L35-59) builds a `SyncState` literal with `version: 1` and no `realized`, then expects `loadState` to return it verbatim. The migration now returns `version: 2` + `realized: {}`, breaking that test. Fix it in Step 4.3.

- [ ] **Step 4.3: Update the pre-existing `state.test.ts` round-trip to v2.**

  In `tools/ibkr-sync/test/state.test.ts`, in the `round-trips a state object` test (L38-54), change the literal to a v2 shape with a ledger so it round-trips through the migrated loader. Replace the `const original: SyncState = { version: 1, ... closing: {}, };` block with:

  ```ts
      const original: SyncState = {
        version: 2,
        live: {
          '1': {
            contractId: 1,
            contractDescription: 'ACME',
            occSymbol: null,
            instrumentType: 'EQUITY',
            expiration: null,
            quantity: '10',
            avgCost: '90',
            currency: 'USD',
            lastSeenDate: '2026-06-04',
          },
        },
        closing: {},
        realized: { seenTradeIds: [], cumulativeRealizedByAsset: {} },
      };
  ```

  (The `falls back to empty on malformed JSON` and `returns empty state when the file is missing` tests already compare against `emptyState()`, which is now v2 — they pass unchanged.)

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/state.test.ts test/realized.test.ts
  ```

  Expected: both pass.

- [ ] **Step 4.4: Add `realizedGain` to `HoldingsPositionInput`.**

  In `tools/ibkr-sync/src/wealthfolio.ts`, inside `HoldingsPositionInput` (currently ends with `assetId?: string;` at L117), add before the closing brace:

  ```ts
    /** Cumulative realized P&L in the asset's currency. Camelcase JSON →
     *  backend `realized_gain` (#[serde(default)] = 0). */
    realizedGain?: number;
  ```

  Typecheck (no test needed — it's a type-only addition consumed in Task 5):

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx tsc --noEmit
  ```

  Expected: no output (exit 0).

- [ ] **Step 4.5: Commit.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio && git add tools/ibkr-sync/src/wealthfolio.ts tools/ibkr-sync/src/state.ts tools/ibkr-sync/test/realized.test.ts tools/ibkr-sync/test/state.test.ts && git commit -m "ibkr-sync: persist realized ledger (v1->v2 migration) + realizedGain input field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 5: Wire the ledger into `sync.ts` (fetch trades, accumulate, stamp `realizedGain`)

**Files:**
- Modify `tools/ibkr-sync/src/sync.ts` (imports L23-48; trade fold + stamping after reconcile ~L108-135; dry-run output ~L146-158; persist `nextState.realized` — already saved via `saveState(args.statePath, nextState)` at L302).
- Modify `tools/ibkr-sync/test/realized.test.ts` (sync-assembly test via an exported pure helper).

`sync.ts`'s `run()` is a monolithic I/O function (reads file, POSTs). To unit-test the assembly without HTTP, extract a pure `stampRealizedGain(rows, ledger)` helper and test THAT; `run()` calls it. This mirrors the file's existing pure/impure split (mapping is pure, `run` is the orchestrator).

- [ ] **Step 5.1: Write failing test for `stampRealizedGain`.**

  Append to `test/realized.test.ts`:

  ```ts
  import { stampRealizedGain } from '../src/sync.js';

  describe('stampRealizedGain', () => {
    it('stamps realizedGain on rows whose asset key is in the ledger', () => {
      const ledger = { seenTradeIds: ['x'], cumulativeRealizedByAsset: { ACME: 500, ZZZ: -100 } };
      const rows: HoldingsPositionInput[] = [
        { symbol: 'ACME', quantity: '10', currency: 'USD', instrumentType: 'EQUITY' },
        { symbol: 'NOPE', quantity: '5', currency: 'USD', instrumentType: 'EQUITY' },
      ];
      const out = stampRealizedGain(rows, ledger);
      expect(out[0].realizedGain).toBe(500);
      expect(out[1].realizedGain).toBeUndefined(); // no ledger entry -> left absent
    });

    it('does not mutate the input rows', () => {
      const ledger = { seenTradeIds: [], cumulativeRealizedByAsset: { ACME: 500 } };
      const rows: HoldingsPositionInput[] = [
        { symbol: 'ACME', quantity: '10', currency: 'USD', instrumentType: 'EQUITY' },
      ];
      stampRealizedGain(rows, ledger);
      expect(rows[0].realizedGain).toBeUndefined();
    });
  });
  ```

  > IMPORTANT: `sync.ts` ends with a top-level `run().then(...)` that calls `process.exit`. Importing it from a test executes that. Guard it (Step 5.2) so the test can import the module without running the orchestrator.

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: failure — `stampRealizedGain` is not exported (and/or the module's `run()` side-effect runs).

- [ ] **Step 5.2: Implement `stampRealizedGain`, guard the entrypoint, and call it in `run()`.**

  In `tools/ibkr-sync/src/sync.ts`:

  Extend the `./ibkr.js` import (L23-29) to add `parseTradesForRealized`:

  ```ts
  import {
    parsePositions,
    parseBalances,
    parseSummary,
    parseOrdersCount,
    parseTradesForRealized,
    type IbkrPosition,
  } from './ibkr.js';
  ```

  Extend the `./mapping.js` import (L30-36) to add `positionAssetKey`:

  ```ts
    parseOcc,
    positionAssetKey,
  } from './mapping.js';
  ```

  Extend the `./state.js` import (L37-41) to add `applyTradesToLedger` and `RealizedLedger`:

  ```ts
  import {
    loadState,
    saveState,
    reconcile,
    applyTradesToLedger,
    type RealizedLedger,
  } from './state.js';
  ```

  Add the pure helper near the other top-level functions (after `todayUtc()` ~L95):

  ```ts
  /**
   * Stamp `realizedGain` onto each snapshot row whose asset key has a ledger
   * entry. Pure: returns new row objects, never mutates the input. Rows with no
   * ledger entry are returned unchanged (realizedGain stays absent → backend
   * defaults it to 0).
   */
  export function stampRealizedGain(
    rows: HoldingsPositionInput[],
    ledger: RealizedLedger,
  ): HoldingsPositionInput[] {
    return rows.map((row) => {
      const realized = ledger.cumulativeRealizedByAsset[positionAssetKey(row)];
      return realized === undefined ? row : { ...row, realizedGain: realized };
    });
  }
  ```

  Inside `run()`, after the reconcile block sets `nextState.lastRunUtc` (after L113), fold trades into the ledger:

  ```ts
    // Accumulate realized P&L from IBKR trades into the persisted ledger.
    // Deduped by trade_id across overlapping lookback windows.
    const trades = raw.trades ? parseTradesForRealized(raw.trades) : [];
    nextState.realized = applyTradesToLedger(prevState.realized, trades);
  ```

  Then, where `allPositions` is assembled (L135), stamp realized on the final list. Replace L135:

  ```ts
    const allPositions: HoldingsPositionInput[] = stampRealizedGain(
      [...mapped, ...reinjectedRows],
      nextState.realized,
    );
  ```

  Guard the entrypoint: replace the trailing `run().then(...)` block (L316-322) with a guard so importing the module in a test does not execute `run()`:

  ```ts
  // Only run when executed directly (not when imported by tests).
  if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    run().then(
      (code) => process.exit(code),
      (err) => {
        console.error('[ibkr-sync] fatal:', err instanceof Error ? err.stack : err);
        process.exit(2);
      },
    );
  }
  ```

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts && npx tsc --noEmit
  ```

  Expected: realized.test.ts passes (stamp tests green); `tsc --noEmit` exits 0.

- [ ] **Step 5.3: Add the dry-run ledger line for operator visibility.**

  In `tools/ibkr-sync/src/sync.ts`, in the dry-run block, after the existing `console.log` that prints loaded counts (after L147), add:

  ```ts
      const realizedKeys = Object.keys(nextState.realized.cumulativeRealizedByAsset);
      console.log(
        `[ibkr-sync] realized ledger: ${realizedKeys.length} assets, ${nextState.realized.seenTradeIds.length} trades seen`,
      );
      for (const m of allPositions) {
        if (m.realizedGain !== undefined) {
          console.log(`[dry-run] realized ${m.symbol.padEnd(24)} ${m.realizedGain} ${m.currency}`);
        }
      }
  ```

  Place this block immediately after the existing `console.log(\`[ibkr-sync] loaded (dry-run): ...\`);` line and before the `for (const m of allPositions)` avg-cost loop already there. (Two separate loops is fine — one prints positions, one prints realized.)

- [ ] **Step 5.4: Write an end-to-end dry-run test driving `run()` via a temp raw file + env.**

  This proves the assembled payload carries `realizedGain` from a real raw dump. `run()` reads `process.argv` and env; we set them, point `--from` at a temp file built from the fixtures, use `--dry-run` (no HTTP), and capture stdout.

  Append to `test/realized.test.ts`:

  ```ts
  import { run } from '../src/sync.js';
  import positionsFixture from '../fixtures/ibkr-positions.json' with { type: 'json' };

  describe('sync run() dry-run carries realizedGain', () => {
    it('stamps ACME realized (500) onto the ACME stock row in the dry-run output', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ibkr-sync-run-'));
      const rawPath = join(dir, 'raw.json');
      const statePath = join(dir, 'state.json');
      await writeFile(
        rawPath,
        JSON.stringify({ positions: positionsFixture, trades: tradesFixture }),
        'utf8',
      );

      const prevArgv = process.argv;
      const prevPwd = process.env.WEALTHFOLIO_PASSWORD;
      process.env.WEALTHFOLIO_PASSWORD = 'x';
      process.argv = ['node', 'sync.ts', `--from=${rawPath}`, `--state=${statePath}`, '--dry-run'];

      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
        lines.push(a.join(' '));
      });
      try {
        const code = await run();
        expect(code).toBe(0);
      } finally {
        spy.mockRestore();
        process.argv = prevArgv;
        process.env.WEALTHFOLIO_PASSWORD = prevPwd;
      }
      const out = lines.join('\n');
      expect(out).toContain('realized ACME');
      expect(out).toContain('500');
    });
  });
  ```

  Add `vi` to the vitest import at the top of `test/realized.test.ts`: change `import { describe, expect, it } from 'vitest';` to `import { describe, expect, it, vi } from 'vitest';`.

  > NOTE: `run()` must be exported. Add `export` to its declaration in `sync.ts`: change `async function run(): Promise<number> {` (L97) to `export async function run(): Promise<number> {`.

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: the dry-run test passes — output contains `realized ACME` and `500`.

- [ ] **Step 5.5: Full suite + typecheck green.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run && npx tsc --noEmit
  ```

  Expected: `Test Files  5 passed (5)` (the 4 original + realized.test.ts), all tests passing except the 1 pre-existing skipped integration test; `tsc --noEmit` exits 0.

- [ ] **Step 5.6: Commit.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio && git add tools/ibkr-sync/src/sync.ts tools/ibkr-sync/test/realized.test.ts && git commit -m "ibkr-sync: wire realized ledger into sync.ts, stamp realizedGain on snapshot rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 6: Routine prompt + allowedTools + backfill docs

**Files:**
- Modify `tools/ibkr-sync/scripts/routine-prompt.txt` (Step 1 tool list L5-9; Step 2 JSON shape L11-19).
- Modify `tools/ibkr-sync/scripts/run-hourly.sh` (`--allowedTools`, L56).
- Modify `tools/ibkr-sync/README.md` (Knobs/Operations).

There is no automated test for these (they're operator config consumed by a headless Claude session). Verification is by inspection + the JSON-shape consistency that `sync.ts` already enforces (`raw.trades` is read in Task 5).

- [ ] **Step 6.1: Add `get_account_trades` to the routine prompt fetch step.**

  In `tools/ibkr-sync/scripts/routine-prompt.txt`, replace Step 1's four-tool list (L5-9) with five, adding trades with the `DAYS_7` period:

  ```
  Step 1. Call these IBKR MCP tools and remember their raw JSON responses:
    - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_positions  (no args)
    - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_balances   (no args)
    - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_summary    (no args)
    - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_orders     (no args)
    - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_trades     (period: "DAYS_7")
  ```

  Then replace the Step 2 JSON shape (L13-19) to include `trades`:

  ```
    {
      "positions": <full positions response>,
      "balances":  <full balances response>,
      "summary":   <full summary response>,
      "orders":    <full orders response>,
      "trades":    <full trades response>
    }
  ```

- [ ] **Step 6.2: Add `get_account_trades` to `run-hourly.sh` allowedTools.**

  In `tools/ibkr-sync/scripts/run-hourly.sh` (L56), append the trades tool to the comma-separated `--allowedTools` list:

  ```
    --allowedTools "Bash,Read,Write,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_positions,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_balances,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_summary,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_orders,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_trades" \
  ```

- [ ] **Step 6.3: Document the realized ledger + one-time backfill in the README.**

  In `tools/ibkr-sync/README.md`, under the `## Knobs` section's "The routine prompt ... bakes in" bullet list (after the existing `IBKR trades lookback: DAYS_7` line ~L100), the lookback is now actually used for realized — update that bullet and add a backfill note. Replace the `- IBKR trades lookback: **DAYS_7** ...` bullet with:

  ```
  - IBKR trades lookback: **DAYS_7** — fetched via `get_account_trades` and
    folded into the realized-P&L ledger (`state/positions-state.json` →
    `realized.cumulativeRealizedByAsset`). Overlapping prior runs are deduped by
    `trade_id`, so the window can safely re-include trades.
  ```

  Then add a new subsection after the `## Knobs` block (before `## See also`):

  ```
  ## Realized P&L ledger + one-time backfill

  Realized P&L is **accumulated forward** from the first run that fetched
  trades. The ledger lives in `state/positions-state.json`:

      "realized": {
        "seenTradeIds": ["tid-007", ...],
        "cumulativeRealizedByAsset": { "ACME": 500, "OPT:ACME": 200 }
      }

  Each hourly run fetches the last 7 days of trades and adds any unseen
  `trade_id`'s `realized_pnl` to its asset key. Dedup is by `trade_id`, so
  overlapping windows never double-count. STK realized is keyed by the bare
  symbol and stamped onto the matching snapshot row as `realizedGain`; OPT
  realized accrues under `OPT:<symbol>` but is NOT yet stamped onto a specific
  OCC option row (trades carry only the short symbol).

  Because accumulation starts at the first tracked run, history before then is
  missing. To seed it once, do a wide-window backfill BEFORE relying on the
  number:

  1. Stop the cron (or just run off-hours).
  2. In a Claude Code session with the IBKR MCP binding, call
     `get_account_trades` with `period: "YEAR_TO_DATE"` (the widest single
     window IBKR exposes besides per-quarter `LAST_QUARTER` /
     `TWO_QUARTERS_AGO` / … — there is NO 365-day option; for >1y use the
     per-quarter periods and merge). Write the response under `"trades"` in
     `/tmp/ibkr-raw.json` alongside the usual positions/balances/summary.
  3. Run `npx tsx src/sync.ts --from=/tmp/ibkr-raw.json --dry-run` and confirm
     the `[ibkr-sync] realized ledger:` line shows the expected assets/amounts.
  4. Re-run without `--dry-run` to persist the seeded ledger, then resume cron.
     Subsequent DAYS_7 runs only add newly-seen trades.

  CAUTION: IBKR's `realized_pnl` semantics (lifetime vs YTD reset) must be
  validated against real data first — see the design spec's top open item.
  ```

- [ ] **Step 6.4: Sanity-check the prompt JSON shape parses by re-running the dry-run test (already covers `raw.trades`).**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```

  Expected: still green (the run() dry-run test consumes `raw.trades`, matching the new prompt shape).

- [ ] **Step 6.5: Commit.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio && git add tools/ibkr-sync/scripts/routine-prompt.txt tools/ibkr-sync/scripts/run-hourly.sh tools/ibkr-sync/README.md && git commit -m "ibkr-sync: fetch get_account_trades; document realized ledger + backfill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 7.1: Run the full test suite.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run
  ```

  Expected: `Test Files  5 passed (5)`, all tests passing, 1 pre-existing skipped (the `WF_INTEGRATION`-gated test in `wealthfolio.test.ts`).

- [ ] **Step 7.2: Typecheck.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx tsc --noEmit
  ```

  Expected: no output, exit 0. (`noUnusedLocals`/`noUnusedParameters` are on — ensure every new import is used; `RealizedLedger` is used in `stampRealizedGain`'s signature.)

- [ ] **Step 7.3: Confirm no stray state-file churn.**

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio && git status --short tools/ibkr-sync/state/
  ```

  Expected: empty (the real `state/positions-state.json` is gitignored; tests only write to temp dirs). If anything shows, it's an accidental commit of live state — do not stage it.
