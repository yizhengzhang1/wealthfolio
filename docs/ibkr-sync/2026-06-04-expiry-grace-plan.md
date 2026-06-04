# IBKR Closed/Expired Position Grace Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep just-closed / just-expired IBKR positions visible in Wealthfolio holdings for a ~1-day grace window, then auto-remove; report open-order count in the sync log.

**Architecture:** A new sync-tool state file remembers each position's last non-zero snapshot. Each run reconciles observed positions against state, classifies newly-gone positions as EXPIRED or CLOSED, and re-injects them into the pushed snapshot for `graceDays` (default 1). A one-line backend patch relaxes the expired-option *display* filter by the same grace window (valuation still zeroes them). Orders are fetched only to count.

**Tech Stack:** TypeScript (Node 24, tsx, vitest, zod) for `tools/ibkr-sync/`; Rust (chrono) for the Wealthfolio core patch, rebuilt via the existing `compose.override.yml` image.

**Spec:** `docs/ibkr-sync/2026-06-04-expiry-grace-design.md`

**Conventions:** All TS imports use the `.js` extension (ESM/`moduleResolution: Bundler`). `noUnusedLocals`/`noUnusedParameters` are on — no dead bindings. Run all commands from `tools/ibkr-sync/`.

---

## File Structure

Sync tool (`tools/ibkr-sync/`):
- `src/state.ts` *(new)* — state types, load/save, date helpers, `reconcile()` reducer.
- `src/mapping.ts` *(modify)* — `ibkrPositionToObserved()`, `parseOcc()` (extracted), `reinjectionToHoldingsPosition()`.
- `src/ibkr.ts` *(modify)* — `parseOrdersCount()`.
- `src/sync.ts` *(modify)* — wire state in; merge re-injections; orders + closing counts in summary; `--state` arg.
- `scripts/routine-prompt.txt` *(modify)* — fetch `get_account_orders`, add `orders` key.
- `scripts/run-hourly.sh` *(modify)* — add `get_account_orders` to `--allowedTools`.
- `.gitignore` *(modify)* — ignore `state/`.
- `test/state.test.ts` *(new)*, `test/mapping.test.ts` *(modify)*, `test/ibkr.test.ts` *(modify)*.

Backend:
- `crates/core/src/portfolio/holdings/holdings_service.rs` *(modify)* — grace-aware expired-skip + unit test.

---

## Task 1: State module — types, load/save, date helpers

**Files:**
- Create: `tools/ibkr-sync/src/state.ts`
- Test: `tools/ibkr-sync/test/state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tools/ibkr-sync/test/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addDays,
  daysBetween,
  emptyState,
  loadState,
  saveState,
  type SyncState,
} from '../src/state.js';

describe('state date helpers', () => {
  it('daysBetween counts whole UTC days', () => {
    expect(daysBetween('2026-06-03', '2026-06-04')).toBe(1);
    expect(daysBetween('2026-06-04', '2026-06-04')).toBe(0);
    expect(daysBetween('2026-06-04', '2026-06-02')).toBe(-2);
  });

  it('addDays shifts a UTC date string', () => {
    expect(addDays('2026-06-04', -1)).toBe('2026-06-03');
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
  });
});

describe('state load/save', () => {
  it('returns empty state when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-state-'));
    const state = await loadState(join(dir, 'nope.json'));
    expect(state).toEqual(emptyState());
  });

  it('round-trips a state object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-state-'));
    const path = join(dir, 'positions-state.json');
    const original: SyncState = {
      version: 1,
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
    };
    await saveState(path, original);
    expect(await loadState(path)).toEqual(original);
    // human-readable on disk
    expect(await readFile(path, 'utf8')).toContain('\n');
  });

  it('falls back to empty on malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-state-'));
    const path = join(dir, 'bad.json');
    await saveState(path, emptyState());
    await (await import('node:fs/promises')).writeFile(path, '{ not json', 'utf8');
    expect(await loadState(path)).toEqual(emptyState());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL — `Cannot find module '../src/state.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/ibkr-sync/src/state.ts`:

```ts
/**
 * Local sync state: remembers each position's last non-zero snapshot so that
 * positions which just closed (qty 0) or expired can be re-injected into the
 * pushed holdings snapshot for a short grace window. The hourly cron is the
 * only writer. See docs/ibkr-sync/2026-06-04-expiry-grace-design.md.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type InstrumentKind = 'EQUITY' | 'OPTION';
export type ClosingKind = 'EXPIRED' | 'CLOSED';

/** One IBKR position as observed this run (quantity may be "0"). */
export interface ObservedPosition {
  contractId: number;
  contractDescription: string;
  occSymbol: string | null; // 21-char OCC for options, null for stocks
  instrumentType: InstrumentKind;
  expiration: string | null; // YYYY-MM-DD, options only
  quantity: string; // signed; "0" for closed rows
  avgCost: string;
  currency: string;
}

/** Last-known NON-ZERO snapshot of a position. */
export interface LivePosition {
  contractId: number;
  contractDescription: string;
  occSymbol: string | null;
  instrumentType: InstrumentKind;
  expiration: string | null;
  quantity: string; // signed, non-zero
  avgCost: string;
  currency: string;
  lastSeenDate: string; // YYYY-MM-DD
}

/** A position inside the grace window after closing/expiring. */
export interface ClosingPosition extends LivePosition {
  closedDate: string; // YYYY-MM-DD, first run that saw it gone
  kind: ClosingKind;
}

export interface SyncState {
  version: 1;
  lastRunUtc?: string;
  live: Record<string, LivePosition>;
  closing: Record<string, ClosingPosition>;
}

export function emptyState(): SyncState {
  return { version: 1, live: {}, closing: {} };
}

export async function loadState(path: string): Promise<SyncState> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      (raw as SyncState).version === 1 &&
      (raw as SyncState).live &&
      (raw as SyncState).closing
    ) {
      return raw as SyncState;
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

export async function saveState(path: string, state: SyncState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Whole UTC days from `from` to `to` (negative if `to` precedes `from`). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Shift a YYYY-MM-DD UTC date by `n` days. */
export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/ibkr-sync/src/state.ts tools/ibkr-sync/test/state.test.ts
git commit -m "feat(ibkr-sync): add sync state module (types, load/save, date helpers)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `reconcile()` — close detection + grace state machine

**Files:**
- Modify: `tools/ibkr-sync/src/state.ts`
- Test: `tools/ibkr-sync/test/state.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tools/ibkr-sync/test/state.test.ts`:

```ts
import { reconcile, type ObservedPosition } from '../src/state.js';

function obs(overrides: Partial<ObservedPosition> = {}): ObservedPosition {
  return {
    contractId: 1,
    contractDescription: 'ACME',
    occSymbol: null,
    instrumentType: 'EQUITY',
    expiration: null,
    quantity: '10',
    avgCost: '90',
    currency: 'USD',
    ...overrides,
  };
}

describe('reconcile', () => {
  const TODAY = '2026-06-04';

  it('records a new non-zero position as live, nothing closing', () => {
    const { next, reinjections } = reconcile(emptyState(), [obs()], TODAY, 1);
    expect(next.live['1'].quantity).toBe('10');
    expect(next.live['1'].lastSeenDate).toBe(TODAY);
    expect(reinjections).toEqual([]);
  });

  it('classifies a vanished option as EXPIRED when expiration has passed', () => {
    const prev = reconcile(
      emptyState(),
      [obs({ contractId: 7, occSymbol: 'SPXW  260603P07500000', instrumentType: 'OPTION', expiration: '2026-06-03', quantity: '1', avgCost: '1.8' })],
      '2026-06-03',
      1,
    ).next;
    // next day it is gone from IBKR entirely
    const { next, reinjections } = reconcile(prev, [], TODAY, 1);
    expect(next.live['7']).toBeUndefined();
    expect(next.closing['7'].kind).toBe('EXPIRED');
    expect(next.closing['7'].quantity).toBe('1');
    expect(next.closing['7'].avgCost).toBe('1.8');
    expect(reinjections.map((r) => r.contractId)).toEqual([7]);
  });

  it('classifies a flat-but-not-expired option as CLOSED', () => {
    const prev = reconcile(
      emptyState(),
      [obs({ contractId: 8, occSymbol: 'INTC  260717P00100000', instrumentType: 'OPTION', expiration: '2026-07-17', quantity: '1', avgCost: '6.85' })],
      TODAY,
      1,
    ).next;
    // IBKR now reports it with quantity 0 (avg 0)
    const { next } = reconcile(prev, [obs({ contractId: 8, occSymbol: 'INTC  260717P00100000', instrumentType: 'OPTION', expiration: '2026-07-17', quantity: '0', avgCost: '0' })], TODAY, 1);
    expect(next.closing['8'].kind).toBe('CLOSED');
    expect(next.closing['8'].quantity).toBe('1'); // last non-zero retained
  });

  it('keeps a closing entry within grace, drops it after', () => {
    let state = reconcile(emptyState(), [obs({ contractId: 9, quantity: '5' })], '2026-06-04', 1).next;
    state = reconcile(state, [], '2026-06-04', 1).next; // closed today
    expect(state.closing['9']).toBeDefined();
    const day1 = reconcile(state, [], '2026-06-05', 1);
    expect(day1.next.closing['9']).toBeDefined(); // age 1 <= grace 1
    const day2 = reconcile(day1.next, [], '2026-06-06', 1);
    expect(day2.next.closing['9']).toBeUndefined(); // age 2 > grace 1
    expect(day2.reinjections).toEqual([]);
  });

  it('revives a closing position if it reappears non-zero', () => {
    let state = reconcile(emptyState(), [obs({ contractId: 11, quantity: '2' })], TODAY, 1).next;
    state = reconcile(state, [], TODAY, 1).next; // closed
    expect(state.closing['11']).toBeDefined();
    const back = reconcile(state, [obs({ contractId: 11, quantity: '3' })], TODAY, 1);
    expect(back.next.closing['11']).toBeUndefined();
    expect(back.next.live['11'].quantity).toBe('3');
  });

  it('warm-up: a position first seen already at qty 0 is ignored', () => {
    const { next, reinjections } = reconcile(emptyState(), [obs({ contractId: 12, quantity: '0', avgCost: '0' })], TODAY, 1);
    expect(next.live['12']).toBeUndefined();
    expect(next.closing['12']).toBeUndefined();
    expect(reinjections).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state.test.ts -t reconcile`
Expected: FAIL — `reconcile is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/ibkr-sync/src/state.ts`:

```ts
export interface ReconcileResult {
  next: SyncState;
  reinjections: ClosingPosition[];
}

function isNonZero(quantity: string): boolean {
  return Number(quantity) !== 0;
}

/**
 * Reconcile observed positions against prior state.
 *  - positions that left the non-zero set become `closing` (EXPIRED if their
 *    expiration is on/before `today`, else CLOSED), carrying their last-known
 *    non-zero quantity/avgCost;
 *  - reappearing positions are revived into `live`;
 *  - closing entries past the grace window (by close date, or by expiry for
 *    options) are dropped.
 * Pure: no I/O, no clock — `today` and `graceDays` are passed in.
 */
export function reconcile(
  prev: SyncState,
  observed: ObservedPosition[],
  today: string,
  graceDays: number,
): ReconcileResult {
  const next: SyncState = { version: 1, live: {}, closing: { ...prev.closing } };

  const liveNow = observed.filter((p) => isNonZero(p.quantity));
  const liveNowIds = new Set(liveNow.map((p) => String(p.contractId)));

  // 1. newly closed: present in prior live, absent from current non-zero set.
  for (const [id, lp] of Object.entries(prev.live)) {
    if (!liveNowIds.has(id) && !next.closing[id]) {
      const expired = lp.expiration != null && lp.expiration <= today;
      next.closing[id] = { ...lp, closedDate: today, kind: expired ? 'EXPIRED' : 'CLOSED' };
    }
  }

  // 2. refresh live from this run; revive any that reappeared.
  for (const p of liveNow) {
    const id = String(p.contractId);
    next.live[id] = {
      contractId: p.contractId,
      contractDescription: p.contractDescription,
      occSymbol: p.occSymbol,
      instrumentType: p.instrumentType,
      expiration: p.expiration,
      quantity: p.quantity,
      avgCost: p.avgCost,
      currency: p.currency,
      lastSeenDate: today,
    };
    delete next.closing[id];
  }

  // 3. prune the grace window.
  for (const [id, c] of Object.entries(next.closing)) {
    const beyondClose = daysBetween(c.closedDate, today) > graceDays;
    const beyondExpiry = c.expiration != null && c.expiration < addDays(today, -graceDays);
    if (beyondClose || beyondExpiry) delete next.closing[id];
  }

  return { next, reinjections: Object.values(next.closing) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS (all state tests).

- [ ] **Step 5: Commit**

```bash
git add tools/ibkr-sync/src/state.ts tools/ibkr-sync/test/state.test.ts
git commit -m "feat(ibkr-sync): reconcile() close-detection + grace state machine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Map IBKR position → ObservedPosition; extract `parseOcc`

**Files:**
- Modify: `tools/ibkr-sync/src/mapping.ts`
- Test: `tools/ibkr-sync/test/mapping.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tools/ibkr-sync/test/mapping.test.ts`:

```ts
import { ibkrPositionToObserved, parseOcc } from '../src/mapping.js';

describe('ibkrPositionToObserved', () => {
  it('maps a stock position', () => {
    const o = ibkrPositionToObserved(makePosition({ contract_description: 'IBKR', position: 6.2, average_price: 69 }));
    expect(o).toEqual({
      contractId: 1,
      contractDescription: 'IBKR',
      occSymbol: null,
      instrumentType: 'EQUITY',
      expiration: null,
      quantity: '6.2',
      avgCost: '69',
      currency: 'USD',
    });
  });

  it('maps an option position and pulls expiration from the OCC symbol', () => {
    const o = ibkrPositionToObserved(
      makePosition({
        contract_id: 877985483,
        contract_description: 'SPX    JUN2026 7450 P [SPXW  260604P07450000 100]',
        position: 1,
        average_price: 1.8164,
      }),
    );
    expect(o.instrumentType).toBe('OPTION');
    expect(o.occSymbol).toBe('SPXW  260604P07450000');
    expect(o.expiration).toBe('2026-06-04');
    expect(o.quantity).toBe('1');
  });

  it('preserves quantity 0 for closed rows', () => {
    const o = ibkrPositionToObserved(makePosition({ position: 0, average_price: 0 }));
    expect(o.quantity).toBe('0');
  });
});

describe('parseOcc', () => {
  it('parses a raw 21-char OCC symbol', () => {
    expect(parseOcc('SPXW  260604P07450000')).toEqual({
      occSymbol: 'SPXW  260604P07450000',
      underlying: 'SPXW',
      expiration: '2026-06-04',
      right: 'PUT',
      strike: '7450',
      multiplier: 100,
    });
  });

  it('returns null for a malformed symbol', () => {
    expect(parseOcc('NOTANOCC')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mapping.test.ts -t ObservedPosition`
Expected: FAIL — `ibkrPositionToObserved is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `tools/ibkr-sync/src/mapping.ts`, add the `ObservedPosition` import to the existing `wealthfolio.js` / `state.js` import block:

```ts
import type { ObservedPosition } from './state.js';
```

Refactor `parseOptionPosition` to reuse a new exported `parseOcc`. Replace the body of `parseOptionPosition` (lines ~164-193) with:

```ts
/**
 * Parse a raw 21-char OCC symbol (e.g. "SPXW  260604P07450000") into a spec.
 * `multiplier` is the OCC standard 100 (the per-contract multiplier lives in
 * the IBKR bracket payload, not the OCC string). Returns null if malformed.
 */
export function parseOcc(occSymbol: string): ParsedOption | null {
  const s = occSymbol;
  if (s.length !== 21) return null;
  const underlying = s.slice(0, 6).trim();
  if (!underlying) return null;
  const yymmdd = s.slice(6, 12);
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const expiration = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  const rightChar = s[12];
  if (rightChar !== 'C' && rightChar !== 'P') return null;
  const right: 'CALL' | 'PUT' = rightChar === 'C' ? 'CALL' : 'PUT';
  const strikeRaw = s.slice(13);
  if (!/^\d{8}$/.test(strikeRaw)) return null;
  const strike = String(Number(strikeRaw) / 1000);
  return { occSymbol: s, underlying, expiration, right, strike, multiplier: 100 };
}

export function parseOptionPosition(pos: IbkrPosition): ParsedOption | null {
  const occ = parseOccFromContractDescription(pos.contract_description);
  if (!occ) return null;
  const parsed = parseOcc(occ.occSymbol);
  if (!parsed) return null;
  // multiplier comes from the IBKR bracket payload, not the OCC string.
  return { ...parsed, multiplier: occ.multiplier };
}
```

Append at the end of `tools/ibkr-sync/src/mapping.ts`:

```ts
/**
 * Map one IBKR position row to an ObservedPosition for the sync state machine.
 * Quantity is preserved verbatim (including "0" for closed rows).
 */
export function ibkrPositionToObserved(pos: IbkrPosition): ObservedPosition {
  const parsed = parseOptionPosition(pos);
  if (parsed) {
    return {
      contractId: pos.contract_id,
      contractDescription: pos.contract_description,
      occSymbol: parsed.occSymbol,
      instrumentType: 'OPTION',
      expiration: parsed.expiration,
      quantity: String(pos.position),
      avgCost: String(pos.average_price),
      currency: pos.currency,
    };
  }
  return {
    contractId: pos.contract_id,
    contractDescription: pos.contract_description.trim(),
    occSymbol: null,
    instrumentType: 'EQUITY',
    expiration: null,
    quantity: String(pos.position),
    avgCost: String(pos.average_price),
    currency: pos.currency,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mapping.test.ts`
Expected: PASS (existing + new). Then `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add tools/ibkr-sync/src/mapping.ts tools/ibkr-sync/test/mapping.test.ts
git commit -m "feat(ibkr-sync): ibkrPositionToObserved + extracted parseOcc

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Map a closing position → re-injection snapshot row

**Files:**
- Modify: `tools/ibkr-sync/src/mapping.ts`
- Test: `tools/ibkr-sync/test/mapping.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tools/ibkr-sync/test/mapping.test.ts`:

```ts
import { reinjectionToHoldingsPosition } from '../src/mapping.js';
import type { ClosingPosition } from '../src/state.js';

function closing(overrides: Partial<ClosingPosition> = {}): ClosingPosition {
  return {
    contractId: 7,
    contractDescription: 'SPX ...',
    occSymbol: 'SPXW  260603P07500000',
    instrumentType: 'OPTION',
    expiration: '2026-06-03',
    quantity: '1',
    avgCost: '1.8',
    currency: 'USD',
    lastSeenDate: '2026-06-03',
    closedDate: '2026-06-04',
    kind: 'EXPIRED',
    ...overrides,
  };
}

describe('reinjectionToHoldingsPosition', () => {
  it('EXPIRED option keeps avgCost so the backend shows the full loss', () => {
    expect(reinjectionToHoldingsPosition(closing())).toEqual({
      symbol: 'SPXW  260603P07500000',
      quantity: '1',
      avgCost: '1.8',
      currency: 'USD',
      instrumentType: 'OPTION',
    });
  });

  it('CLOSED position forces avgCost 0 (informational $0 row)', () => {
    const row = reinjectionToHoldingsPosition(
      closing({ kind: 'CLOSED', expiration: '2026-07-17', occSymbol: 'INTC  260717P00100000', avgCost: '6.85' }),
    );
    expect(row.avgCost).toBe('0');
    expect(row.symbol).toBe('INTC  260717P00100000');
  });

  it('CLOSED stock uses contract_description as the symbol', () => {
    const row = reinjectionToHoldingsPosition(
      closing({ kind: 'CLOSED', instrumentType: 'EQUITY', occSymbol: null, contractDescription: 'RKLB' }),
    );
    expect(row).toEqual({ symbol: 'RKLB', quantity: '1', avgCost: '0', currency: 'USD', instrumentType: 'EQUITY' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mapping.test.ts -t reinjection`
Expected: FAIL — `reinjectionToHoldingsPosition is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/ibkr-sync/src/mapping.ts` (and add `ClosingPosition` to the `./state.js` type import):

```ts
/**
 * Build a holdings-snapshot row for a grace-window position.
 *  - EXPIRED options keep their last avgCost so the backend (which zero-values
 *    expired options) renders $0 with the full premium loss.
 *  - CLOSED positions force avgCost "0" → $0 value, no P&L, no net-worth impact.
 */
export function reinjectionToHoldingsPosition(c: ClosingPosition): HoldingsPositionInput {
  return {
    symbol: c.occSymbol ?? c.contractDescription,
    quantity: c.quantity,
    avgCost: c.kind === 'EXPIRED' ? c.avgCost : '0',
    currency: c.currency,
    instrumentType: c.instrumentType,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mapping.test.ts` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add tools/ibkr-sync/src/mapping.ts tools/ibkr-sync/test/mapping.test.ts
git commit -m "feat(ibkr-sync): map closing positions to re-injection snapshot rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Orders count parser

**Files:**
- Modify: `tools/ibkr-sync/src/ibkr.ts`
- Test: `tools/ibkr-sync/test/ibkr.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tools/ibkr-sync/test/ibkr.test.ts`:

```ts
import { parseOrdersCount } from '../src/ibkr.js';

describe('parseOrdersCount', () => {
  it('counts the orders array in an envelope', () => {
    expect(parseOrdersCount({ orders: [{ a: 1 }, { b: 2 }] })).toBe(2);
  });
  it('counts a bare array', () => {
    expect(parseOrdersCount([{ a: 1 }])).toBe(1);
  });
  it('returns 0 for empty/missing/garbage', () => {
    expect(parseOrdersCount({ orders: [] })).toBe(0);
    expect(parseOrdersCount(null)).toBe(0);
    expect(parseOrdersCount(undefined)).toBe(0);
    expect(parseOrdersCount({ nope: true })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ibkr.test.ts -t parseOrdersCount`
Expected: FAIL — `parseOrdersCount is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/ibkr-sync/src/ibkr.ts`:

```ts
/**
 * Count live orders from a `get_account_orders` response. We do NOT store
 * orders in Wealthfolio (no entity exists) — the count goes in the sync log.
 * Accepts an `{orders: []}` envelope or a bare array; 0 on anything unexpected.
 */
export function parseOrdersCount(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { orders?: unknown }).orders)) {
    return ((raw as { orders: unknown[] }).orders).length;
  }
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ibkr.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/ibkr-sync/src/ibkr.ts tools/ibkr-sync/test/ibkr.test.ts
git commit -m "feat(ibkr-sync): parseOrdersCount for the log summary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire state + re-injection + orders into `sync.ts`

**Files:**
- Modify: `tools/ibkr-sync/src/sync.ts`

This task is orchestration glue over the pure, already-tested pieces. Verify by typecheck + a dry-run against a fixture (Step 4); no new unit test.

- [ ] **Step 1: Add imports and the `--state` arg**

In `src/sync.ts`, extend the imports:

```ts
import {
  parsePositions,
  parseBalances,
  parseSummary,
  parseOrdersCount,
  type IbkrPosition,
} from './ibkr.js';
import {
  ibkrPositionToHoldingsPosition,
  ibkrPositionToObserved,
  reinjectionToHoldingsPosition,
  parseOptionPosition,
  parseOcc,
} from './mapping.js';
import {
  loadState,
  saveState,
  reconcile,
  type ClosingPosition,
} from './state.js';
```

Add `statePath` and `graceDays` to `CliArgs` and `parseArgs` (read `--state`, default `state/positions-state.json`; grace from `IBKR_CLOSING_GRACE_DAYS`, default 1):

```ts
// in CliArgs
  statePath: string;
  graceDays: number;

// in parseArgs return
    statePath: String(opts['state'] ?? 'state/positions-state.json'),
    graceDays: Number(process.env.IBKR_CLOSING_GRACE_DAYS ?? '1'),
```

- [ ] **Step 2: Reconcile + build re-injections after parsing**

In `run()`, immediately after `const summary = ...` and before the existing mapping loop, add:

```ts
  // Reconcile against prior runs to find just-closed / just-expired positions.
  const today = todayUtc();
  const observed = positions.map(ibkrPositionToObserved);
  const prevState = await loadState(args.statePath);
  const { next: nextState, reinjections } = reconcile(prevState, observed, today, args.graceDays);
  nextState.lastRunUtc = new Date().toISOString();
```

After the existing `mapped` / `stkCount` / `optCount` block, append the re-injection rows and counts:

```ts
  const reinjectedRows: HoldingsPositionInput[] = reinjections.map(reinjectionToHoldingsPosition);
  const expiredCount = reinjections.filter((r) => r.kind === 'EXPIRED').length;
  const closedCount = reinjections.length - expiredCount;
  const allPositions: HoldingsPositionInput[] = [...mapped, ...reinjectedRows];
```

Replace later uses of `mapped` in the snapshot push (the `positions:` field and dry-run listing) with `allPositions`.

- [ ] **Step 3: Ensure option assets for re-injected options; bind assetId**

The existing pre-create loop iterates IBKR `positions`; re-injected options are not there. After that loop (after `if (optionAssetIds.size > 0) {...}`), add:

```ts
  // Re-injected options need their asset to exist too (it normally does from
  // when the position was live). findOrCreateAsset is idempotent — it matches
  // the existing asset by (instrumentSymbol, OPTION) and returns it.
  const reinjectAssetIds = new Map<number, string>(); // contractId -> asset.id
  for (const c of reinjections) {
    if (c.instrumentType !== 'OPTION' || !c.occSymbol) continue;
    const spec = parseOcc(c.occSymbol);
    const asset = await client.findOrCreateAsset({
      quoteCcy: c.currency,
      quoteMode: 'MANUAL',
      instrumentType: 'OPTION',
      instrumentSymbol: c.occSymbol,
      displayCode: c.occSymbol,
      metadata: spec
        ? {
            option: {
              underlyingAssetId: spec.underlying,
              expiration: spec.expiration,
              right: spec.right,
              strike: spec.strike,
              multiplier: String(spec.multiplier),
              occSymbol: c.occSymbol,
            },
          }
        : { option: { occSymbol: c.occSymbol } },
    });
    reinjectAssetIds.set(c.contractId, asset.id);
  }
```

Bind the assetId onto the matching re-injected row. Re-injected rows share the same index order as `reinjections`, so after building `reinjectedRows`, set:

```ts
  reinjections.forEach((c, i) => {
    const id = reinjectAssetIds.get(c.contractId);
    if (id) reinjectedRows[i].assetId = id;
  });
```

(Place this binding after Step 4's `client` is constructed and `reinjectAssetIds` is populated — i.e., inside the post-account block, mirroring the existing option-asset binding for `mappedEntries`.)

- [ ] **Step 4: Save state and extend the summary line**

Change `summaryLine` to include closing + orders counts. Update its definition:

```ts
  const orderCount = parseOrdersCount(raw.orders);
  const summaryLine = (extra: string): string =>
    `[ibkr-sync] summary: date=${today} positions=${positions.length} (stk=${stkCount} opt=${optCount} skipped=${skipped}) closing=${reinjections.length} (expired=${expiredCount} closed=${closedCount}) cash_currencies=${Object.keys(cashBalances).length}${summary ? ` net_liq=${summary.net_liquidation.toFixed(2)}${summary.currency}` : ''} orders=${orderCount} ${extra}`;
```

(Replace the previous `date=${date}` with `date=${today}` and delete the now-unused `const date = todayUtc();` — reuse `today`. Update the snapshot push to use `date: today`.)

Persist state right before returning success (after a successful snapshot import, before the final `return`):

```ts
  await saveState(args.statePath, nextState);
```

Also save in the dry-run branch is NOT needed (dry-run must not mutate state) — leave the dry-run path without `saveState`.

- [ ] **Step 5: Typecheck + dry-run**

Run: `npx tsc --noEmit`
Expected: no errors.

Run a dry-run against the existing fixture (no server, no state mutation):
```bash
WEALTHFOLIO_PASSWORD=x npx tsx src/sync.ts --from=fixtures/ibkr-positions.json --state=/tmp/wf-state-dryrun.json --dry-run
```
Expected: prints the loaded positions and a `summary:` line containing `closing=` and `orders=`. (If no positions fixture exists, dump one first per README "Dry-run from fixture".)

- [ ] **Step 6: Commit**

```bash
git add tools/ibkr-sync/src/sync.ts
git commit -m "feat(ibkr-sync): re-inject closing positions + state + orders count in sync

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Fetch orders in the routine prompt + allowedTools

**Files:**
- Modify: `tools/ibkr-sync/scripts/routine-prompt.txt`
- Modify: `tools/ibkr-sync/scripts/run-hourly.sh`

- [ ] **Step 1: Add the orders MCP call to the prompt**

In `scripts/routine-prompt.txt`, Step 1 list, add a fourth tool:

```
  - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_orders     (no args)
```

And in Step 2's JSON shape, add the `orders` key:

```
  {
    "positions": <full positions response>,
    "balances":  <full balances response>,
    "summary":   <full summary response>,
    "orders":    <full orders response>
  }
```

- [ ] **Step 2: Allow the orders tool in the headless session**

In `scripts/run-hourly.sh`, append `get_account_orders` to `--allowedTools`:

```
  --allowedTools "Bash,Read,Write,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_positions,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_balances,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_summary,mcp__claude_ai_Interactive_Brokers_IBKR__get_account_orders" \
```

- [ ] **Step 3: Sanity-check the scripts**

Run: `bash -n scripts/run-hourly.sh`
Expected: no syntax errors (exit 0).

- [ ] **Step 4: Commit**

```bash
git add tools/ibkr-sync/scripts/routine-prompt.txt tools/ibkr-sync/scripts/run-hourly.sh
git commit -m "feat(ibkr-sync): fetch open orders for the log count

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Backend — grace-aware expired-option display filter

**Files:**
- Modify: `crates/core/src/portfolio/holdings/holdings_service.rs`

- [ ] **Step 1: Write the failing test**

In `holdings_service.rs`, find the test module (existing option-expiry tests live around lines 1412-1443). Add a test for the cutoff helper:

```rust
    #[test]
    fn expired_skip_cutoff_applies_grace_days() {
        let today = NaiveDate::from_ymd_opt(2026, 6, 4).unwrap();
        // grace 1 → cutoff is yesterday; an option expiring 2026-06-03 is NOT
        // beyond the cutoff (still displayed), one expiring 2026-06-02 is.
        let cutoff = expired_skip_cutoff(today, 1);
        assert_eq!(cutoff, NaiveDate::from_ymd_opt(2026, 6, 3).unwrap());
        assert!(!is_expired_option(true, None, &["SPXW  260603P07500000"], cutoff));
        assert!(is_expired_option(true, None, &["SPXW  260602P07500000"], cutoff));
        // grace 0 → original behavior: yesterday's expiry is hidden.
        let strict = expired_skip_cutoff(today, 0);
        assert!(is_expired_option(true, None, &["SPXW  260603P07500000"], strict));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p wealthfolio-core expired_skip_cutoff_applies_grace_days`
Expected: FAIL — `cannot find function expired_skip_cutoff`.

- [ ] **Step 3: Write minimal implementation**

Add the helper next to `is_expired_option` (after line ~105):

```rust
/// Display cutoff for the expired-option *skip* filter: options expiring on or
/// after this date are still shown. `grace_days` (default 1, from
/// `WF_EXPIRED_OPTION_GRACE_DAYS`) lets a just-expired option linger ~1 day in
/// holdings before disappearing. Valuation still zeroes it independently.
fn expired_skip_cutoff(today: NaiveDate, grace_days: i64) -> NaiveDate {
    today - chrono::Duration::days(grace_days.max(0))
}

fn expired_option_grace_days() -> i64 {
    std::env::var("WF_EXPIRED_OPTION_GRACE_DAYS")
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(1)
}
```

In `build_live_holdings_from_snapshot`, compute the cutoff once near `let today = self.today_in_user_timezone();` (line ~152):

```rust
        let expired_cutoff = expired_skip_cutoff(today, expired_option_grace_days());
```

At the skip site (lines ~223-232), pass `expired_cutoff` instead of `today`:

```rust
            if skip_expired_options
                && is_expired_option(
                    asset_info.is_option,
                    asset_info.metadata.as_ref(),
                    &[
                        asset_info.instrument_symbol.as_deref().unwrap_or_default(),
                        &asset_info.instrument.symbol,
                    ],
                    expired_cutoff,
                )
```

Leave the valuation path (`holdings_valuation_service.rs`) untouched so grace-window options still value to `$0`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p wealthfolio-core expired_skip_cutoff_applies_grace_days`
Expected: PASS. Then `cargo test -p wealthfolio-core holdings::` to confirm no regressions in the holdings tests.

(If the crate name differs, discover it: `grep -m1 '^name' crates/core/Cargo.toml`.)

- [ ] **Step 5: Commit**

```bash
git add crates/core/src/portfolio/holdings/holdings_service.rs
git commit -m "feat(holdings): grace window for expired-option display filter

Expired options stay visible for WF_EXPIRED_OPTION_GRACE_DAYS (default 1)
before being hidden; valuation still zeroes them. Supports the IBKR sync
closed/expired grace feature.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: gitignore state + docs, then end-to-end verification

**Files:**
- Modify: `tools/ibkr-sync/.gitignore`
- Modify: `tools/ibkr-sync/README.md`

- [ ] **Step 1: Ignore the state dir**

Append to `tools/ibkr-sync/.gitignore`:

```
state/
```

- [ ] **Step 2: Document the feature in the README**

Under "Knobs" in `tools/ibkr-sync/README.md`, add:

```
- Closed/expired grace window: `IBKR_CLOSING_GRACE_DAYS` (sync tool, default 1)
  and `WF_EXPIRED_OPTION_GRACE_DAYS` (backend, default 1). Just-closed/expired
  positions linger in holdings for this many days, then disappear. State lives
  in `state/positions-state.json` (gitignored). See
  `docs/ibkr-sync/2026-06-04-expiry-grace-design.md`.
- Open orders are fetched only to print `orders=<n>` in the summary; not stored.
```

- [ ] **Step 3: Commit**

```bash
git add tools/ibkr-sync/.gitignore tools/ibkr-sync/README.md
git commit -m "docs(ibkr-sync): document grace window + ignore state dir

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Rebuild the patched backend image**

Run (per memory `wealthfolio-deploy-topology`: serial-pull base images first if BuildKit TLS timeouts occur):
```bash
docker compose build --progress=plain wealthfolio; echo BUILD_EXIT=$?
docker compose up -d wealthfolio
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://localhost:8088
```
Expected: `BUILD_EXIT=0`, container healthy, HTTP 200.

- [ ] **Step 5: Run the full sync twice and verify**

```bash
env -i HOME=/home/samsung bash scripts/run-hourly.sh
tail -5 logs/sync-$(date -u +%Y%m%d).log
```
Expected: the `summary:` line now includes `closing=N (expired=… closed=…)` and `orders=N`. After at least one position closes/expires on a later run, confirm in the Wealthfolio UI (`http://localhost:8088`) that the closed/expired position shows for the grace window (expired option at `$0` with the loss) and disappears afterward. Confirm `state/positions-state.json` exists and tracks `live`/`closing`.

- [ ] **Step 6: Final verification commit (if any doc tweaks)**

No code changes expected here; if verification surfaced fixes, commit them with a clear message.

---

## Self-Review

- **Spec coverage:** state file (T1), reconcile/grace machine (T2), observed mapping (T3), re-injection rows incl. EXPIRED-vs-CLOSED valuation (T4), orders count (T5), sync wiring + summary + state persistence (T6), prompt/allowedTools (T7), backend grace patch (T8), gitignore/docs/rebuild/verify (T9). All spec sections covered.
- **Placeholders:** none — every code/test step is concrete.
- **Type consistency:** `ObservedPosition`/`LivePosition`/`ClosingPosition`/`SyncState`/`reconcile`/`ReconcileResult` defined in T1–T2 and consumed consistently in T3–T6; `parseOcc` returns `ParsedOption` (existing type) and is reused by `parseOptionPosition`; `reinjectionToHoldingsPosition` returns `HoldingsPositionInput` (existing). `expired_skip_cutoff`/`expired_option_grace_days` defined and used in T8.
- **Warm-up & idempotency** handled by `reconcile` (first-seen-zero ignored; closedDate set once); covered by T2 tests.
