# IBKR-Sync Realized-by-Underlying Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the ibkr-sync realized ledger to track currency per asset, add a `realizedByUnderlying()` transform that groups stock + option realized by underlying, and attach that list to the existing snapshot POST payload.

**Architecture:** `cumulativeRealizedByAsset` changes from `Record<string,number>` to `Record<string,{amount,currency}>`, requiring a v2→v3 state migration that clears the ledger so the next run rebuilds it currency-aware. A new pure function `realizedByUnderlying(ledger)` strips `OPT:` prefixes and groups by underlying, then `sync.ts` calls it and attaches the result as a new `realized` field on the existing `HoldingsSnapshotInput` POST — no new HTTP requests.

**Tech Stack:** TypeScript/Node (tools/ibkr-sync), Vitest, `npx tsc --noEmit` for type-safety.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `tools/ibkr-sync/src/state.ts` | Modified | Ledger entry shape → `{amount,currency}`; `applyTradesToLedger` reads `trade.currency`; `SyncState.version` 2→3; `loadState` v2→v3 migration; new `realizedByUnderlying()` export |
| `tools/ibkr-sync/src/wealthfolio.ts` | Modified | `HoldingsSnapshotInput` gains `realized?: RealizedUnderlying[]`; export `RealizedUnderlying` type |
| `tools/ibkr-sync/src/sync.ts` | Modified | Call `realizedByUnderlying(nextState.realized)`, attach to snapshot payload, add dry-run line |
| `tools/ibkr-sync/test/realized.test.ts` | Modified | Update assertions for new `{amount,currency}` ledger shape; add `realizedByUnderlying` unit tests; extend dry-run e2e to assert `realized` list |
| `tools/ibkr-sync/test/state.test.ts` | Modified | Update v2 round-trip fixture to `{amount,currency}` shape; add v2→v3 migration test |

---

### Task 1: Ledger entry shape → `{amount, currency}`

**Files:**
- `tools/ibkr-sync/src/state.ts` lines 49–90 (`RealizedLedger`, `applyTradesToLedger`, `emptyLedger`)
- `tools/ibkr-sync/test/realized.test.ts` lines 31–63 (`applyTradesToLedger` describe block), lines 95–102 (fixture test), lines 131–153 (`stampRealizedGain` tests)

**Context anchors (current code):**
- `state.ts:51` — `cumulativeRealizedByAsset: Record<string, number>` (the field to change)
- `state.ts:81` — `const byAsset: Record<string, number> = { ...ledger.cumulativeRealizedByAsset }` (accumulator to update)
- `state.ts:87` — `byAsset[key] = (byAsset[key] ?? 0) + t.realized_pnl` (sum to update to `{amount,currency}`)
- `state.ts:63` — `emptyLedger()` returns `{ seenTradeIds: [], cumulativeRealizedByAsset: {} }` (no change to empty)
- `sync.ts:112` — `ledger.cumulativeRealizedByAsset[positionAssetKey(row)]` in `stampRealizedGain` (must adapt to `.amount`)
- `realized.test.ts:38` — `expect(next.cumulativeRealizedByAsset).toEqual({ ACME: 750, '9999': -100 })` (update to `{amount,currency}`)
- `realized.test.ts:52` — `expect(second.cumulativeRealizedByAsset).toEqual({ ACME: 850 })` (update)
- `realized.test.ts:99–100` — `expect(...['ACME']).toBe(500)` and `['OPT:ACME']).toBe(200)` (update)
- `realized.test.ts:136` — `cumulativeRealizedByAsset: { ACME: 500, ZZZ: -100 }` in `stampRealizedGain` test (update)

- [ ] **Step 1.1 — Write failing tests.** In `test/realized.test.ts`, update the three existing `applyTradesToLedger` assertions and the fixture test to expect the new shape. Also update the `stampRealizedGain` test ledger literal. Run `npx vitest run test/realized.test.ts` — expect failures on the shape assertions.

  Updated assertions in `applyTradesToLedger` describe (lines 38, 52–53, 57–60, 99–101):
  ```ts
  // line 38 — accumulates from empty ledger
  expect(next.cumulativeRealizedByAsset).toEqual({
    ACME: { amount: 750, currency: 'USD' },
    '9999': { amount: -100, currency: 'HKD' },
  });

  // line 52 — no double-count
  expect(second.cumulativeRealizedByAsset).toEqual({ ACME: { amount: 850, currency: 'USD' } });

  // line 57–60 — CASH/FX adds nothing (unchanged shape assertion)
  expect(next.cumulativeRealizedByAsset).toEqual({});

  // lines 99–101 — fixture test
  expect(ledger.cumulativeRealizedByAsset['ACME']).toEqual({ amount: 500, currency: 'USD' });
  expect(ledger.cumulativeRealizedByAsset['OPT:ACME']).toEqual({ amount: 200, currency: 'USD' });
  ```

  Updated `stampRealizedGain` test ledger (line 136):
  ```ts
  const ledger = {
    seenTradeIds: ['x'],
    cumulativeRealizedByAsset: {
      ACME: { amount: 500, currency: 'USD' },
      ZZZ: { amount: -100, currency: 'USD' },
    },
  };
  ```

  Run:
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```
  Expected: multiple failures on shape assertions.

- [ ] **Step 1.2 — Update `RealizedLedger` and `applyTradesToLedger` in `state.ts`.** Change the interface and accumulator logic.

  In `state.ts`, change `RealizedLedger` (line 51):
  ```ts
  cumulativeRealizedByAsset: Record<string, { amount: number; currency: string }>;
  ```

  Change `applyTradesToLedger` body (lines 81, 87):
  ```ts
  const byAsset: Record<string, { amount: number; currency: string }> = {
    ...ledger.cumulativeRealizedByAsset,
  };
  // ...
  const prev = byAsset[key];
  byAsset[key] = { amount: (prev?.amount ?? 0) + t.realized_pnl, currency: t.currency };
  ```

- [ ] **Step 1.3 — Fix `stampRealizedGain` in `sync.ts`** to read `.amount` from the new entry shape (line 112):
  ```ts
  const entry = ledger.cumulativeRealizedByAsset[positionAssetKey(row)];
  return entry === undefined ? row : { ...row, realizedGain: entry.amount };
  ```

- [ ] **Step 1.4 — Run tests + typecheck.**
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts && npx tsc --noEmit
  ```
  Expected: all realized.test.ts tests pass, tsc exit 0.

- [ ] **Step 1.5 — Commit.**
  ```
  git add tools/ibkr-sync/src/state.ts tools/ibkr-sync/src/sync.ts tools/ibkr-sync/test/realized.test.ts
  git commit -m "feat(ibkr-sync): ledger entry shape -> {amount,currency} per asset key

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 2: Version 2→3 migration

**Files:**
- `tools/ibkr-sync/src/state.ts` lines 54–68, 92–113 (`SyncState`, `emptyState`, `loadState`)
- `tools/ibkr-sync/test/state.test.ts` lines 35–68 (round-trip test + v1 migration test)
- `tools/ibkr-sync/test/realized.test.ts` lines 104–128 (`loadState ledger migration` describe)

**Context anchors:**
- `state.ts:55` — `version: 2` in `SyncState` type
- `state.ts:67` — `{ version: 2, live: {}, closing: {}, realized: emptyLedger() }` in `emptyState()`
- `state.ts:96–103` — `loadState` branch `version === 1 || version === 2` → coerces to version 2; the new migration must handle `version < 3` instead and clear the ledger when upgrading from v2
- `state.ts:159` — `const next: SyncState = { version: 2, live: {}, closing: { ...prev.closing }, realized: prev.realized }` in `reconcile` (update to version 3)
- `state.test.ts:38` — `version: 2` in round-trip fixture (update to 3)
- `state.test.ts:54` — `realized: { seenTradeIds: [], cumulativeRealizedByAsset: {} }` (unchanged, but version changes)
- `realized.test.ts:116` — `expect(state.version).toBe(2)` in v1 migration test (update to 3)
- `realized.test.ts:125` — `state.realized = { seenTradeIds: ['a'], cumulativeRealizedByAsset: { ACME: 500 } }` v2 round-trip test (now invalid shape; update + add v2→v3 migration test)

- [ ] **Step 2.1 — Write failing tests.** Update version references and add a v2→v3 migration test in `test/realized.test.ts` (new test in the `loadState ledger migration` describe):
  ```ts
  it('v2→v3 migration clears seenTradeIds and cumulativeRealizedByAsset, keeps live/closing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-realized-'));
    const path = join(dir, 'state.json');
    // a v2 file with populated numeric ledger + a live position
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        live: { '1': { contractId: 1, contractDescription: 'ACME', occSymbol: null,
                        instrumentType: 'EQUITY', expiration: null, quantity: '10',
                        avgCost: '90', currency: 'USD', lastSeenDate: '2026-06-04' } },
        closing: {},
        realized: { seenTradeIds: ['old-1', 'old-2'], cumulativeRealizedByAsset: { ACME: 500 } },
      }) + '\n',
      'utf8',
    );
    const state = await loadState(path);
    expect(state.version).toBe(3);
    expect(state.realized.seenTradeIds).toEqual([]);
    expect(state.realized.cumulativeRealizedByAsset).toEqual({});
    // live/closing are preserved across migration
    expect(state.live['1'].contractDescription).toBe('ACME');
    expect(state.closing).toEqual({});
  });
  ```

  Also update the v1 migration test (`realized.test.ts:116`): change `toBe(2)` → `toBe(3)`.

  Update the v2 round-trip test (`realized.test.ts:121–128`): since v2 files now trigger migration (clear ledger), change this test to a v3 round-trip:
  ```ts
  it('round-trips a v3 state including the currency-aware ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-realized-'));
    const path = join(dir, 'positions-state.json');
    const state = emptyState(); // emptyState() will return version:3 after Step 2.2
    state.realized = {
      seenTradeIds: ['a'],
      cumulativeRealizedByAsset: { ACME: { amount: 500, currency: 'USD' } },
    };
    await saveState(path, state);
    expect(await loadState(path)).toEqual(state);
  });
  ```

  Update `state.test.ts` round-trip fixture at line 38: change `version: 2` → `version: 3`. Run tests — expect version assertion failures.

  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/state.test.ts test/realized.test.ts
  ```

- [ ] **Step 2.2 — Update `SyncState`, `emptyState`, `reconcile`, `loadState` in `state.ts`.**

  Change `SyncState` (line 55):
  ```ts
  export interface SyncState {
    version: 3;
    // ...
  }
  ```

  Change `emptyState()` (line 67):
  ```ts
  return { version: 3, live: {}, closing: {}, realized: emptyLedger() };
  ```

  Change `reconcile` inner `next` literal (line 159):
  ```ts
  const next: SyncState = { version: 3, live: {}, closing: { ...prev.closing }, realized: prev.realized };
  ```

  Change `loadState` migration branch (lines 96–103) to handle versions 1 and 2 (migrate to 3 clearing the ledger when version < 3, but preserving live/closing), and accept version 3 as a valid pass-through:
  ```ts
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as { version: number }).version !== undefined &&
    (raw as SyncState).live &&
    (raw as SyncState).closing
  ) {
    const s = raw as Omit<SyncState, 'version'> & { version: number };
    if (s.version === 3) {
      return { ...s, version: 3, realized: s.realized ?? emptyLedger() } as SyncState;
    }
    // v1 or v2: migrate to v3, clearing the realized ledger so the next run
    // rebuilds it with currency-aware entries from scratch.
    console.warn(
      `[ibkr-sync] state: migrating v${s.version}→v3 at ${path}; realized ledger cleared for currency-aware rebuild`,
    );
    return {
      version: 3,
      live: s.live,
      closing: s.closing,
      realized: emptyLedger(),
    } as SyncState;
  }
  ```

- [ ] **Step 2.3 — Run tests + typecheck.**
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/state.test.ts test/realized.test.ts && npx tsc --noEmit
  ```
  Expected: all tests pass, tsc exit 0.

- [ ] **Step 2.4 — Commit.**
  ```
  git add tools/ibkr-sync/src/state.ts tools/ibkr-sync/test/state.test.ts tools/ibkr-sync/test/realized.test.ts
  git commit -m "feat(ibkr-sync): bump SyncState version 2->3, migrate v2 ledger to currency-aware shape

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 3: `realizedByUnderlying(ledger)` pure function

**Files:**
- `tools/ibkr-sync/src/state.ts` — add `RealizedUnderlying` type and `realizedByUnderlying` export (after `applyTradesToLedger`, before `loadState`)
- `tools/ibkr-sync/test/realized.test.ts` — add new describe block for `realizedByUnderlying`

**Design decision:** `realizedByUnderlying` lives in `state.ts` (not `mapping.ts`) because it operates on the `RealizedLedger` type and its logic is cohesive with ledger management. `mapping.ts` is for IBKR-row → Wealthfolio-row transforms; grouping ledger entries by underlying is a ledger concern.

- [ ] **Step 3.1 — Write failing tests.** Add a new describe block to `test/realized.test.ts` (after existing describes, before `stampRealizedGain`):

  ```ts
  import { realizedByUnderlying } from '../src/state.js';

  describe('realizedByUnderlying', () => {
    function ledger(entries: Record<string, { amount: number; currency: string }>) {
      return { seenTradeIds: [], cumulativeRealizedByAsset: entries };
    }

    it('strips OPT: prefix and returns underlying with amount and currency', () => {
      const result = realizedByUnderlying(ledger({ 'OPT:SPX': { amount: 1000, currency: 'USD' } }));
      expect(result).toEqual([{ underlying: 'SPX', currency: 'USD', realizedLocal: 1000 }]);
    });

    it('combines stock and option realized for the same underlying', () => {
      const result = realizedByUnderlying(ledger({
        'ACME': { amount: 500, currency: 'USD' },
        'OPT:ACME': { amount: 200, currency: 'USD' },
      }));
      expect(result).toEqual([{ underlying: 'ACME', currency: 'USD', realizedLocal: 700 }]);
    });

    it('handles multiple underlyings', () => {
      const result = realizedByUnderlying(ledger({
        'ACME': { amount: 500, currency: 'USD' },
        'OPT:ACME': { amount: 200, currency: 'USD' },
        '9999': { amount: -100, currency: 'HKD' },
      }));
      // sorted by |realizedLocal| desc: ACME 700, 9999 100
      const acme = result.find((r) => r.underlying === 'ACME');
      const hk = result.find((r) => r.underlying === '9999');
      expect(acme).toEqual({ underlying: 'ACME', currency: 'USD', realizedLocal: 700 });
      expect(hk).toEqual({ underlying: '9999', currency: 'HKD', realizedLocal: -100 });
      expect(result.length).toBe(2);
    });

    it('OPT-only underlying (no matching STK key) still groups correctly', () => {
      const result = realizedByUnderlying(ledger({ 'OPT:SPX': { amount: -300, currency: 'USD' } }));
      expect(result).toEqual([{ underlying: 'SPX', currency: 'USD', realizedLocal: -300 }]);
    });

    it('returns empty array for an empty ledger', () => {
      expect(realizedByUnderlying(ledger({}))).toEqual([]);
    });

    it('logs a warning and keeps separate entries for a mixed-currency underlying', () => {
      // Edge case: same underlying symbol keyed under two currencies
      // (e.g., OPT:ACME in USD and ACME in HKD — pathological but handled)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = realizedByUnderlying(ledger({
        'ACME': { amount: 500, currency: 'USD' },
        'OPT:ACME': { amount: 200, currency: 'HKD' },
      }));
      expect(result.length).toBe(2);
      expect(result.some((r) => r.currency === 'USD')).toBe(true);
      expect(result.some((r) => r.currency === 'HKD')).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ACME'));
      warnSpy.mockRestore();
    });
  });
  ```

  Run:
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```
  Expected: the `realizedByUnderlying` describe block fails (import not found).

- [ ] **Step 3.2 — Implement `RealizedUnderlying` and `realizedByUnderlying` in `state.ts`.**

  Add after `applyTradesToLedger` (before `loadState`, around line 91):
  ```ts
  export interface RealizedUnderlying {
    underlying: string;
    currency: string;
    realizedLocal: number;
  }

  /**
   * Collapse the per-asset ledger into per-underlying totals.
   * OPT:<symbol> and <symbol> entries are merged into one underlying row.
   * Each underlying is expected to be single-currency; if not, separate entries
   * are kept and a warning is logged.
   */
  export function realizedByUnderlying(ledger: RealizedLedger): RealizedUnderlying[] {
    // Accumulate: underlying -> currency -> amount
    const map = new Map<string, Map<string, number>>();
    for (const [key, entry] of Object.entries(ledger.cumulativeRealizedByAsset)) {
      const underlying = key.startsWith('OPT:') ? key.slice(4) : key;
      let byCurrencyMap = map.get(underlying);
      if (!byCurrencyMap) {
        byCurrencyMap = new Map();
        map.set(underlying, byCurrencyMap);
      }
      byCurrencyMap.set(entry.currency, (byCurrencyMap.get(entry.currency) ?? 0) + entry.amount);
    }
    const result: RealizedUnderlying[] = [];
    for (const [underlying, byCurrency] of map.entries()) {
      if (byCurrency.size > 1) {
        console.warn(
          `[ibkr-sync] realized: underlying ${underlying} has entries in multiple currencies (${[...byCurrency.keys()].join(', ')}); keeping separate`,
        );
        for (const [currency, amount] of byCurrency.entries()) {
          result.push({ underlying, currency, realizedLocal: amount });
        }
      } else {
        const [[currency, amount]] = [...byCurrency.entries()];
        result.push({ underlying, currency, realizedLocal: amount });
      }
    }
    return result;
  }
  ```

- [ ] **Step 3.3 — Run tests + typecheck.**
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts && npx tsc --noEmit
  ```
  Expected: all tests pass, tsc exit 0.

- [ ] **Step 3.4 — Commit.**
  ```
  git add tools/ibkr-sync/src/state.ts tools/ibkr-sync/test/realized.test.ts
  git commit -m "feat(ibkr-sync): add realizedByUnderlying() — strip OPT: prefix, group by underlying

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 4: Attach realized list to snapshot POST

**Files:**
- `tools/ibkr-sync/src/wealthfolio.ts` lines 123–130 (`HoldingsSnapshotInput`)
- `tools/ibkr-sync/src/sync.ts` — import `realizedByUnderlying`; build and attach to snapshot object; add dry-run line
- `tools/ibkr-sync/test/realized.test.ts` — extend dry-run e2e test to assert the `realized` list is passed

**Context anchors:**
- `wealthfolio.ts:123–130` — `HoldingsSnapshotInput` interface (add `realized?` field)
- `sync.ts:44` — imports from `state.js` (add `realizedByUnderlying` to the import)
- `sync.ts:138` — `nextState.realized = applyTradesToLedger(prevState.realized, trades)` (compute `realizedByUnderlying` from `nextState.realized` after this line)
- `sync.ts:174–194` — dry-run block (add a realized-by-underlying summary line)
- `sync.ts:297–301` — `client.importHoldingsSnapshot(account.id, { date, positions, cashBalances })` (add `realized` field)
- `realized.test.ts:158–190` — `sync run() dry-run carries realizedGain` describe (extend to also assert `realized` list)

- [ ] **Step 4.1 — Write failing test.** In `test/realized.test.ts`, extend the dry-run e2e test to also verify a realized-by-underlying log line is emitted. The fixture has ACME STK realized 500 (`tid-007`) and ACME OPT realized 200 (`tid-008`) → combined `[{underlying:'ACME', currency:'USD', realizedLocal:700}]`.

  Add to the `sync run() dry-run carries realizedGain` it block (after the existing `expect(out).toContain('500')` assertion):
  ```ts
  // realized-by-underlying dry-run line
  expect(out).toMatch(/realized-by-underlying.*ACME.*700/);
  ```

  Run:
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts
  ```
  Expected: the new assertion fails (no such line yet).

- [ ] **Step 4.2 — Add `RealizedUnderlying` to `HoldingsSnapshotInput` in `wealthfolio.ts`.**

  Import `RealizedUnderlying` is not needed here (it's a local type); add an inline-compatible field. Since `wealthfolio.ts` is the HTTP type layer, define the type locally or import from state. The cleanest approach: re-export `RealizedUnderlying` from `state.ts` and import it in `wealthfolio.ts`. Alternatively, inline the shape — but since `sync.ts` already imports from both, just import `RealizedUnderlying` from `state.js`.

  In `wealthfolio.ts`, add after the existing imports:
  ```ts
  import type { RealizedUnderlying } from './state.js';
  export type { RealizedUnderlying };
  ```

  Add to `HoldingsSnapshotInput` (after `cashBalances`, line ~129):
  ```ts
  /** Per-underlying realized P&L from the ibkr-sync trade ledger.
   *  `realizedLocal` is a bare number in the underlying's local currency. */
  realized?: RealizedUnderlying[];
  ```

- [ ] **Step 4.3 — Wire up in `sync.ts`.**

  Add `realizedByUnderlying` to the import from `state.js` (line 44):
  ```ts
  import {
    loadState,
    saveState,
    reconcile,
    applyTradesToLedger,
    realizedByUnderlying,
    type RealizedLedger,
  } from './state.js';
  ```

  After `nextState.realized = applyTradesToLedger(...)` (line 138), compute the per-underlying list:
  ```ts
  const realizedList = realizedByUnderlying(nextState.realized);
  ```

  In the dry-run block (after the existing realized ledger log lines, around line 192), add:
  ```ts
  if (realizedList.length > 0) {
    console.log(
      `[ibkr-sync] realized-by-underlying: ${realizedList.map((r) => `${r.underlying} ${r.realizedLocal} ${r.currency}`).join(', ')}`,
    );
  }
  ```

  In the live path, attach to the snapshot call (line 297):
  ```ts
  const result = await client.importHoldingsSnapshot(account.id, {
    date: today,
    positions: allPositions,
    cashBalances,
    realized: realizedList.length > 0 ? realizedList : undefined,
  });
  ```

- [ ] **Step 4.4 — Run tests + typecheck.**
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run test/realized.test.ts && npx tsc --noEmit
  ```
  Expected: all tests pass, tsc exit 0.

- [ ] **Step 4.5 — Commit.**
  ```
  git add tools/ibkr-sync/src/wealthfolio.ts tools/ibkr-sync/src/sync.ts tools/ibkr-sync/test/realized.test.ts
  git commit -m "feat(ibkr-sync): attach realizedByUnderlying list to snapshot POST payload

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 5: Full test suite green + typecheck

**Files:** all (read-only verification)

- [ ] **Step 5.1 — Run full suite.**
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx vitest run
  ```
  Expected output (all files green, 0 failures):
  ```
   ✓ test/mapping.test.ts (25 tests)
   ✓ test/state.test.ts (12 tests)   ← +1 from the new v2→v3 migration test
   ✓ test/ibkr.test.ts (14 tests)
   ✓ test/wealthfolio.test.ts (8 tests | 1 skipped)
   ✓ test/realized.test.ts (22+ tests)  ← +7+ from realizedByUnderlying + updated assertions

   Test Files  5 passed (5)
        Tests  XX passed | 1 skipped
  ```

- [ ] **Step 5.2 — Run typecheck.**
  ```
  cd /home/samsung/ws/wealthfolio_ws/wealthfolio/tools/ibkr-sync && npx tsc --noEmit
  ```
  Expected: exit 0, no output.

- [ ] **Step 5.3 — If any failure,** diagnose and fix (do not skip). Rerun until both commands succeed.
