# Holdings Option-Strategy Detection (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully unit-tested pure TypeScript module `detect-strategies.ts` that classifies a single underlying's option legs into named strategy groups (vertical, calendar, diagonal, straddle, strangle, covered-call, protective-put, collar, butterfly, iron-condor, iron-butterfly, custom), honoring user overrides, plus the shared `StrategyType` / `StrategyGroupRow` row types.

**Architecture:** `detectStrategies(legs, overrides)` returns `{ strategies, looseLegs }`. It first extracts per-leg features (long/short via signed quantity, option vs stock via `parseOccSymbol`), applies `StrategyOverride` records (mode `group`/`exclude`) first, then runs greedy auto-detection from most-specific (4-leg) to simplest (stock+1), consuming each leg at most once and dropping leftover/ambiguous legs into `looseLegs`. A shared `buildStrategyRow` helper performs the P1 base-currency aggregation to produce each `StrategyGroupRow`.

**Tech Stack:** TypeScript, Vitest. Reuses `parseOccSymbol` (`apps/frontend/src/lib/occ-symbol.ts`) and mirrors the base-currency aggregation rules of P1 `group-by-underlying.ts`.

---

## Scope & Boundaries

IN scope (this plan):
- `StrategyGroupRow`, `isStrategyGroupRow` in `apps/frontend/src/lib/types.ts`.
- `apps/frontend/src/pages/holdings/utils/detect-strategies.ts` + `.test.ts` — the entire pure detection algorithm (spec sections 4.1, 5, 7), including the `defaultStrategyLabel` label map.

OUT of scope (other plans — do NOT touch):
- `StrategyType` (the 12-value union) + `StrategyOverride` type + backend persistence + adapters/hooks → **Plan 1**. This plan **imports** `StrategyType` and `StrategyOverride` from `@/lib/types`; it does NOT define them.
- `group-by-underlying.ts` two-level integration, DataTable recursion, any view rendering → **Plan 3**.

Cross-plan contract reminders (reproduce verbatim, do not paraphrase):
- `StrategyType` is exactly these 12 values: `'vertical' | 'calendar' | 'diagonal' | 'straddle' | 'strangle' | 'covered-call' | 'protective-put' | 'collar' | 'butterfly' | 'iron-condor' | 'iron-butterfly' | 'custom'`.
- `StrategyOverride` (defined by Plan 1) has fields: `id`, `accountId`, `underlying`, `name: string | null`, `strategyType: StrategyType | null`, `legs: string[]`, `mode: 'group' | 'exclude'`, `createdAt`, `updatedAt`.
- `StrategyGroupRow.id` format: `` `strategy:${underlyingKey}:${legKey}` `` where `legKey` = the group's leg OCC symbols **sorted** then `join('|')`.

Reference files to read before starting:
- `apps/frontend/src/lib/occ-symbol.ts` — `parseOccSymbol(symbol): { underlying; expiration; optionType: 'CALL'|'PUT'; strikePrice } | null`.
- `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts` — P1 aggregation primitives + `null`-on-zero-denominator pct rule to mirror.
- `apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts` — the `makeHolding` factory shape and OCC fixtures to copy.
- `apps/frontend/src/lib/types.ts` — `Holding` (~line 637), `MonetaryValue` (~line 580), `Instrument` (~line 567).

Test command: `pnpm --filter frontend test -- detect-strategies`
Type check: `pnpm type-check`

---

## Task 1 — Shared row types: `StrategyGroupRow`, `isStrategyGroupRow`

> **Cross-plan contract — `StrategyType` is NOT declared here.** The 12-value
> `StrategyType` union is defined EXACTLY ONCE, by **Plan 1**, in
> `apps/frontend/src/lib/types.ts` (because `StrategyOverride.strategyType`
> references it). This plan only ADDS `StrategyGroupRow` + `isStrategyGroupRow`
> (and the default-label fn in `detect-strategies.ts`). `StrategyGroupRow.strategyType`
> references the EXISTING `StrategyType` — do NOT re-declare or re-export it.
> The 12 values are listed below for reference only:
> `'vertical' | 'calendar' | 'diagonal' | 'straddle' | 'strangle' | 'covered-call' | 'protective-put' | 'collar' | 'butterfly' | 'iron-condor' | 'iron-butterfly' | 'custom'`.

**Files:**
- Modify: `apps/frontend/src/lib/types.ts` (append a new section at end of file)

- [ ] Step 1.1 — Append the strategy row types to `apps/frontend/src/lib/types.ts`. Add this block at the very end of the file. (It references `Holding` and `MonetaryValue`, both already declared earlier in this same file, plus `StrategyType` and `StrategyOverride`, which Plan 1 adds to this same file — do NOT add `StrategyType` or `StrategyOverride` here.)

```ts
// ---------------------------------------------------------------------------
// Option strategy grouping (P2)
// ---------------------------------------------------------------------------

// NOTE: `StrategyType` (the 12-value union) is declared by Plan 1 in this same
// file. Do NOT re-declare it here; the interface below references it directly.

/**
 * Strategy group: a set of legs (option + optional stock) for one underlying
 * within one account, with combined base-currency aggregates. Mirrors the
 * aggregation primitives of the P1 underlying group row.
 */
export interface StrategyGroupRow {
  kind: "strategy";
  /** `strategy:${underlyingKey}:${legKey}`; legKey = leg OCC symbols sorted then join('|'). */
  id: string;
  underlyingKey: string;
  strategyType: StrategyType;
  /** Display name: user override name > default label for the strategyType. */
  name: string;
  /** 'auto' = live auto-detection; 'override' = from a saved StrategyOverride. */
  source: "auto" | "override";
  /** Set when source === 'override'. */
  overrideId?: string;
  memberCount: number;
  baseCurrency: string;
  marketValueBase: number;
  costBasisBase: number;
  totalGainBase: number;
  totalGainPct: number | null;
  dayChangeBase: number;
  dayChangePct: number | null;
  weight: number;
  /** Σ costBasisBase; > 0 = net debit (净付), < 0 = net credit (净收). */
  netCashBase: number;
  /** The legs of this strategy. */
  subRows: Holding[];
}

export function isStrategyGroupRow(row: { kind?: string }): row is StrategyGroupRow {
  return row.kind === "strategy";
}
```

- [ ] Step 1.2 — Verify the file type-checks. Run: `pnpm type-check`. Expected: PASS once Plan 1 has added `StrategyType` (and `StrategyOverride`) to this file. `StrategyGroupRow.strategyType` references Plan 1's `StrategyType` — if Plan 1 has not yet landed that union, finish Plan 1 first. Note: do NOT declare `StrategyType` or `StrategyOverride` in this plan.
- [ ] Step 1.3 — Commit:

```sh
git add apps/frontend/src/lib/types.ts
git commit -m "feat(holdings): add StrategyGroupRow row type and isStrategyGroupRow guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 — Module skeleton: `LegFeature` extraction, label map, test factory

This task lays the internal scaffolding consumed by every later task. It does NOT yet implement any strategy predicate; `detectStrategies` returns everything as loose legs so the suite stays green incrementally.

**Files:**
- Create: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Create: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 2.1 — Write the failing test file `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`. This sets up the shared `makeHolding` factory (copied/extended from the P1 test) and a baseline test. Write the COMPLETE file:

```ts
import { describe, expect, it } from "vitest";
import type { Holding, StrategyOverride } from "@/lib/types";
import { buildOccSymbol } from "@/lib/occ-symbol";
import { detectStrategies } from "./detect-strategies";

// Minimal Holding factory (extends the P1 group-by-underlying factory with the
// fields detection needs: quantity sign, accountId, contractMultiplier).
function makeHolding(p: {
  id: string;
  symbol: string;
  accountId?: string;
  quantity?: number; // signed: >0 long, <0 short
  contractMultiplier?: number | null;
  mv?: number; // marketValue.base
  cost?: number; // costBasis.base
  gain?: number; // totalGain.base
  day?: number; // dayChange.base
  prevClose?: number; // prevCloseValue.base
  weight?: number;
}): Holding {
  return {
    id: p.id,
    accountId: p.accountId ?? "acct-1",
    instrument: { id: p.id, symbol: p.symbol, name: p.symbol, currency: "USD", quoteMode: "LIVE" },
    quantity: p.quantity ?? 1,
    contractMultiplier: p.contractMultiplier ?? null,
    price: null,
    localCurrency: "USD",
    baseCurrency: "USD",
    fxRate: 1,
    marketValue: { local: p.mv ?? 0, base: p.mv ?? 0 },
    costBasis: { local: p.cost ?? 0, base: p.cost ?? 0 },
    totalGain: { local: p.gain ?? 0, base: p.gain ?? 0 },
    dayChange: { local: p.day ?? 0, base: p.day ?? 0 },
    prevCloseValue: { local: p.prevClose ?? 0, base: p.prevClose ?? 0 },
    weight: p.weight ?? 0,
  } as unknown as Holding;
}

// OCC fixture builders (underlying fixed to ASTS unless overridden).
const EXP_A = "2026-06-12";
const EXP_B = "2026-07-17";
function call(strike: number, exp = EXP_A, u = "ASTS") {
  return buildOccSymbol(u, exp, "CALL", strike);
}
function put(strike: number, exp = EXP_A, u = "ASTS") {
  return buildOccSymbol(u, exp, "PUT", strike);
}

// shared helpers re-used across families
const NO_OVERRIDES: StrategyOverride[] = [];

describe("detectStrategies — baseline", () => {
  it("returns empty for empty input", () => {
    expect(detectStrategies([], NO_OVERRIDES)).toEqual({ strategies: [], looseLegs: [] });
  });

  it("leaves a lone short put as a loose leg (cash-secured put does not group)", () => {
    const leg = makeHolding({ id: "p1", symbol: put(100), quantity: -1 });
    const result = detectStrategies([leg], NO_OVERRIDES);
    expect(result.strategies).toHaveLength(0);
    expect(result.looseLegs).toEqual([leg]);
  });

  it("leaves a lone stock holding as a loose leg", () => {
    const leg = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const result = detectStrategies([leg], NO_OVERRIDES);
    expect(result.strategies).toHaveLength(0);
    expect(result.looseLegs).toEqual([leg]);
  });
});

export { makeHolding, call, put, EXP_A, EXP_B, NO_OVERRIDES };
```

- [ ] Step 2.2 — Run the test (expect FAIL — module not yet created). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL with `Failed to resolve import "./detect-strategies"` (or `detectStrategies is not a function`).
- [ ] Step 2.3 — Create the module skeleton `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`. Write the COMPLETE file (feature extraction + label map + a stub `detectStrategies` that routes everything to `looseLegs`; predicates filled in later tasks):

```ts
import { parseOccSymbol } from "@/lib/occ-symbol";
import type { Holding, StrategyGroupRow, StrategyOverride, StrategyType } from "@/lib/types";

/** Per-leg features extracted once up front. */
interface LegFeature {
  holding: Holding;
  symbol: string;
  /** OCC parse result, or null for a stock leg. */
  occ: ReturnType<typeof parseOccSymbol>;
  isOption: boolean;
  isStock: boolean;
  /** signed: >0 long, <0 short. */
  quantity: number;
  isLong: boolean;
  isShort: boolean;
  /** contractMultiplier ?? 100 for options; 1 for stock. */
  multiplier: number;
}

/** Default display label per StrategyType (English; direction-aware vertical labels are produced separately). */
const STRATEGY_LABELS: Record<StrategyType, string> = {
  vertical: "Vertical Spread",
  calendar: "Calendar Spread",
  diagonal: "Diagonal Spread",
  straddle: "Straddle",
  strangle: "Strangle",
  "covered-call": "Covered Call",
  "protective-put": "Protective Put",
  collar: "Collar",
  butterfly: "Butterfly",
  "iron-condor": "Iron Condor",
  "iron-butterfly": "Iron Butterfly",
  custom: "Custom Strategy",
};

export function defaultStrategyLabel(type: StrategyType): string {
  return STRATEGY_LABELS[type];
}

function symbolOf(h: Holding): string {
  return h.instrument?.symbol ?? h.id;
}

function extractFeature(h: Holding, underlyingKey: string): LegFeature {
  const symbol = symbolOf(h);
  const occ = parseOccSymbol(symbol);
  const isOption = occ !== null;
  const isStock = !isOption && symbol === underlyingKey;
  const quantity = h.quantity ?? 0;
  return {
    holding: h,
    symbol,
    occ,
    isOption,
    isStock,
    quantity,
    isLong: quantity > 0,
    isShort: quantity < 0,
    multiplier: isOption ? (h.contractMultiplier ?? 100) : 1,
  };
}

/** Derive the underlying key from the first parseable OCC leg, else the first symbol. */
function deriveUnderlyingKey(legs: Holding[]): string {
  for (const h of legs) {
    const occ = parseOccSymbol(symbolOf(h));
    if (occ) return occ.underlying;
  }
  return legs.length > 0 ? symbolOf(legs[0]) : "";
}

export function detectStrategies(
  legs: Holding[],
  _overrides: StrategyOverride[],
): { strategies: StrategyGroupRow[]; looseLegs: Holding[] } {
  if (legs.length === 0) return { strategies: [], looseLegs: [] };
  const underlyingKey = deriveUnderlyingKey(legs);
  void underlyingKey;
  // Stub: implemented incrementally in later tasks.
  return { strategies: [], looseLegs: [...legs] };
}
```

- [ ] Step 2.4 — Run the test (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS (all 3 baseline tests green).
- [ ] Step 2.5 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): detect-strategies skeleton with leg feature extraction

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 — `buildStrategyRow` aggregation helper (spec section 7)

The shared helper that turns a set of legs into a `StrategyGroupRow`, mirroring P1 base-currency sums and the null-on-zero-denominator pct rule, plus `netCashBase` and the sorted `legKey` id.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 3.1 — Add a failing test for `buildStrategyRow`. Append this `describe` block to the test file (keep the existing `export {...}` at the very end of the file; insert this block before that export line). Also extend the top import to pull in `buildStrategyRow`:

Change the import line:
```ts
import { detectStrategies } from "./detect-strategies";
```
to:
```ts
import { buildStrategyRow, detectStrategies } from "./detect-strategies";
```

Then add this block:
```ts
describe("buildStrategyRow", () => {
  it("aggregates base-currency sums, netCashBase, sorted legKey id, and pct", () => {
    const c1 = makeHolding({
      id: "c1",
      symbol: call(110),
      quantity: -1,
      mv: -1264.56,
      cost: 313,
      gain: -300,
      day: 2,
      prevClose: -1266.56,
      weight: -0.3,
    });
    const c2 = makeHolding({
      id: "c2",
      symbol: call(100),
      quantity: 1,
      mv: 2028.15,
      cost: 578,
      gain: 1450,
      day: 3,
      prevClose: 2025.15,
      weight: 0.5,
    });
    const row = buildStrategyRow("ASTS", "vertical", "Bull Call Spread", "auto", [c2, c1]);
    expect(row.kind).toBe("strategy");
    expect(row.underlyingKey).toBe("ASTS");
    expect(row.strategyType).toBe("vertical");
    expect(row.name).toBe("Bull Call Spread");
    expect(row.source).toBe("auto");
    expect(row.overrideId).toBeUndefined();
    expect(row.memberCount).toBe(2);
    expect(row.baseCurrency).toBe("USD");
    expect(row.marketValueBase).toBeCloseTo(-1264.56 + 2028.15, 2);
    expect(row.costBasisBase).toBeCloseTo(313 + 578, 2);
    expect(row.totalGainBase).toBeCloseTo(-300 + 1450, 2);
    expect(row.dayChangeBase).toBeCloseTo(2 + 3, 2);
    expect(row.weight).toBeCloseTo(-0.3 + 0.5, 4);
    expect(row.netCashBase).toBeCloseTo(313 + 578, 2);
    expect(row.totalGainPct).toBeCloseTo((-300 + 1450) / Math.abs(313 + 578), 6);
    expect(row.dayChangePct).toBeCloseTo((2 + 3) / Math.abs(-1266.56 + 2025.15), 6);
    // id = strategy:ASTS:<sorted leg symbols join '|'>
    const sorted = [call(110), call(100)].sort().join("|");
    expect(row.id).toBe(`strategy:ASTS:${sorted}`);
    // legs preserved in the passed order
    expect(row.subRows).toEqual([c2, c1]);
  });

  it("returns null pct when cost basis / prevClose sums are zero", () => {
    const a = makeHolding({ id: "a", symbol: call(100), quantity: 1, cost: 0, prevClose: 0 });
    const b = makeHolding({ id: "b", symbol: call(110), quantity: -1, cost: 0, prevClose: 0 });
    const row = buildStrategyRow("ASTS", "vertical", "X", "auto", [a, b]);
    expect(row.totalGainPct).toBeNull();
    expect(row.dayChangePct).toBeNull();
  });

  it("sets source='override' with overrideId when provided", () => {
    const a = makeHolding({ id: "a", symbol: call(100), quantity: 1 });
    const b = makeHolding({ id: "b", symbol: call(110), quantity: -1 });
    const row = buildStrategyRow("ASTS", "vertical", "X", "override", [a, b], "ovr-9");
    expect(row.source).toBe("override");
    expect(row.overrideId).toBe("ovr-9");
  });
});
```

- [ ] Step 3.2 — Run (expect FAIL). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL with `buildStrategyRow is not a function` / import resolution error.
- [ ] Step 3.3 — Implement `buildStrategyRow` in `detect-strategies.ts`. Add this exported function (place it after `extractFeature`, before `detectStrategies`):

```ts
/** Build the sorted leg key: leg OCC/symbols sorted then join('|'). */
function legKeyOf(legs: Holding[]): string {
  return legs
    .map((h) => h.instrument?.symbol ?? h.id)
    .sort()
    .join("|");
}

/**
 * Aggregate a set of legs into a StrategyGroupRow (spec section 7).
 * Base-currency sums; pct = sum / |denom|, null when denom is 0;
 * netCashBase = Σ costBasisBase.
 */
export function buildStrategyRow(
  underlyingKey: string,
  strategyType: StrategyType,
  name: string,
  source: "auto" | "override",
  legs: Holding[],
  overrideId?: string,
): StrategyGroupRow {
  let marketValueBase = 0;
  let costBasisBase = 0;
  let totalGainBase = 0;
  let dayChangeBase = 0;
  let prevCloseBase = 0;
  let weight = 0;
  for (const h of legs) {
    marketValueBase += h.marketValue?.base ?? 0;
    costBasisBase += h.costBasis?.base ?? 0;
    totalGainBase += h.totalGain?.base ?? 0;
    dayChangeBase += h.dayChange?.base ?? 0;
    prevCloseBase += h.prevCloseValue?.base ?? 0;
    weight += h.weight ?? 0;
  }

  return {
    kind: "strategy",
    id: `strategy:${underlyingKey}:${legKeyOf(legs)}`,
    underlyingKey,
    strategyType,
    name,
    source,
    overrideId,
    memberCount: legs.length,
    baseCurrency: legs[0].baseCurrency,
    marketValueBase,
    costBasisBase,
    totalGainBase,
    totalGainPct: costBasisBase !== 0 ? totalGainBase / Math.abs(costBasisBase) : null,
    dayChangeBase,
    dayChangePct: prevCloseBase !== 0 ? dayChangeBase / Math.abs(prevCloseBase) : null,
    weight,
    netCashBase: costBasisBase,
    subRows: legs,
  };
}
```

- [ ] Step 3.4 — Run (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS.
- [ ] Step 3.5 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): buildStrategyRow base-currency aggregation helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4 — Two-leg family A: vertical / calendar / diagonal (same type, one long + one short)

These three share the gate "2 options, same optionType, one long + one short". They differ on strike/expiration equality. Implement the detector that scans the remaining pool for any unordered pair matching the gate, classifies it, and consumes both legs. Per spec, the **vertical direction** rule is uniform for call/put: **long-lower-strike = bull, long-higher-strike = bear**.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 4.1 — Add failing tests. Insert before the trailing `export {...}` line:

```ts
describe("two-leg: vertical / calendar / diagonal", () => {
  it("bull call vertical: same type, same expiry, long lower strike + short higher", () => {
    const long = makeHolding({ id: "L", symbol: call(100, EXP_A), quantity: 1, cost: 600 });
    const short = makeHolding({ id: "S", symbol: call(110, EXP_A), quantity: -1, cost: -200 });
    const { strategies, looseLegs } = detectStrategies([long, short], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(strategies[0].name).toBe("Bull Call Spread");
    expect(strategies[0].memberCount).toBe(2);
    expect(strategies[0].netCashBase).toBeCloseTo(400, 2);
  });

  it("bear put vertical: same type, same expiry, long higher strike", () => {
    const long = makeHolding({ id: "L", symbol: put(110, EXP_A), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: put(100, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(strategies[0].name).toBe("Bear Put Spread");
  });

  it("bull put vertical (credit): put, same expiry, long lower strike", () => {
    const long = makeHolding({ id: "L", symbol: put(100, EXP_A), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: put(110, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(strategies[0].name).toBe("Bull Put Spread");
  });

  it("bear call vertical: call, same expiry, long higher strike", () => {
    const long = makeHolding({ id: "L", symbol: call(110, EXP_A), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: call(100, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(strategies[0].name).toBe("Bear Call Spread");
  });

  it("calendar: same type, same strike, different expiry, one long one short", () => {
    const long = makeHolding({ id: "L", symbol: call(100, EXP_B), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: call(100, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("calendar");
    expect(strategies[0].name).toBe("Calendar Spread");
  });

  it("diagonal: same type, different strike AND different expiry, one long one short", () => {
    const long = makeHolding({ id: "L", symbol: call(100, EXP_A), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: call(110, EXP_B), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("diagonal");
    expect(strategies[0].name).toBe("Diagonal Spread");
  });

  it("two longs of same type do not form a vertical (ambiguous -> loose)", () => {
    const a = makeHolding({ id: "a", symbol: call(100, EXP_A), quantity: 1 });
    const b = makeHolding({ id: "b", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([a, b], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });
});
```

- [ ] Step 4.2 — Run (expect FAIL). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL (verticals/calendar/diagonal land in `looseLegs`, strategies empty).
- [ ] Step 4.3 — Implement the detection driver + the family-A detector. Replace the stub body of `detectStrategies` and add the helpers. First add these helper functions above `detectStrategies`:

```ts
function isOptionPairOppositeSides(a: LegFeature, b: LegFeature): boolean {
  return a.isOption && b.isOption && ((a.isLong && b.isShort) || (a.isShort && b.isLong));
}

/** Direction label for a vertical: uniform for call/put — long lower=bull, long higher=bear. */
function verticalLabel(a: LegFeature, b: LegFeature): string {
  const long = a.isLong ? a : b;
  const short = a.isLong ? b : a;
  const isCall = long.occ!.optionType === "CALL";
  const bull = long.occ!.strikePrice < short.occ!.strikePrice;
  if (isCall) return bull ? "Bull Call Spread" : "Bear Call Spread";
  return bull ? "Bull Put Spread" : "Bear Put Spread";
}

/** Try to classify a same-type, opposite-side option pair. Returns null if not a 2-leg spread. */
function classifyVerticalFamily(
  a: LegFeature,
  b: LegFeature,
): { type: StrategyType; name: string } | null {
  if (!isOptionPairOppositeSides(a, b)) return null;
  if (a.occ!.optionType !== b.occ!.optionType) return null;
  const sameStrike = a.occ!.strikePrice === b.occ!.strikePrice;
  const sameExpiry = a.occ!.expiration === b.occ!.expiration;
  if (!sameStrike && sameExpiry) return { type: "vertical", name: verticalLabel(a, b) };
  if (sameStrike && !sameExpiry) return { type: "calendar", name: defaultStrategyLabel("calendar") };
  if (!sameStrike && !sameExpiry) return { type: "diagonal", name: defaultStrategyLabel("diagonal") };
  return null; // same strike & same expiry of same type & opposite sides => degenerate, skip
}
```

Then replace the whole `detectStrategies` function with the greedy driver (note: this task wires only the family-A 2-leg detector; later tasks register more detectors in `detectStrategies`):

```ts
export function detectStrategies(
  legs: Holding[],
  _overrides: StrategyOverride[],
): { strategies: StrategyGroupRow[]; looseLegs: Holding[] } {
  if (legs.length === 0) return { strategies: [], looseLegs: [] };
  const underlyingKey = deriveUnderlyingKey(legs);
  const pool: LegFeature[] = legs.map((h) => extractFeature(h, underlyingKey));
  const consumed = new Set<LegFeature>();
  const strategies: StrategyGroupRow[] = [];

  const avail = () => pool.filter((f) => !consumed.has(f));

  // ---- 2-leg verticals / calendars / diagonals -------------------------
  for (let i = 0; i < pool.length; i++) {
    if (consumed.has(pool[i])) continue;
    for (let j = i + 1; j < pool.length; j++) {
      if (consumed.has(pool[j])) continue;
      const hit = classifyVerticalFamily(pool[i], pool[j]);
      if (hit) {
        consumed.add(pool[i]);
        consumed.add(pool[j]);
        strategies.push(
          buildStrategyRow(
            underlyingKey,
            hit.type,
            hit.name,
            "auto",
            [pool[i].holding, pool[j].holding],
          ),
        );
        break;
      }
    }
  }

  const looseLegs = avail().map((f) => f.holding);
  return { strategies, looseLegs };
}
```

- [ ] Step 4.4 — Run (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS (all family-A + baseline + buildStrategyRow tests green).
- [ ] Step 4.5 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): detect vertical/calendar/diagonal 2-leg spreads

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5 — Two-leg family B: straddle / strangle (1 call + 1 put, same side)

Straddle = 1 call + 1 put, **same strike, same expiry, same side** (both long or both short). Strangle = 1 call + 1 put, **different strike, same expiry, same side**.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 5.1 — Add failing tests. Insert before the trailing `export {...}` line:

```ts
describe("two-leg: straddle / strangle", () => {
  it("long straddle: call + put, same strike, same expiry, both long", () => {
    const c = makeHolding({ id: "c", symbol: call(100, EXP_A), quantity: 1 });
    const p = makeHolding({ id: "p", symbol: put(100, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([c, p], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies[0].strategyType).toBe("straddle");
    expect(strategies[0].name).toBe("Straddle");
  });

  it("short strangle: call + put, different strike, same expiry, both short", () => {
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([c, p], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("strangle");
    expect(strategies[0].name).toBe("Strangle");
  });

  it("call + put same strike but opposite sides is NOT a straddle (-> diagonal/loose)", () => {
    // long call + short put, same strike same expiry: not same-side -> not straddle.
    const c = makeHolding({ id: "c", symbol: call(100, EXP_A), quantity: 1 });
    const p = makeHolding({ id: "p", symbol: put(100, EXP_A), quantity: -1 });
    const { strategies, looseLegs } = detectStrategies([c, p], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });

  it("call + put different expiry is not a strangle (-> loose)", () => {
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: 1 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_B), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([c, p], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });
});
```

- [ ] Step 5.2 — Run (expect FAIL). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL (straddle/strangle land in looseLegs).
- [ ] Step 5.3 — Implement. Add a classifier helper above `detectStrategies`:

```ts
function bothSameSide(a: LegFeature, b: LegFeature): boolean {
  return (a.isLong && b.isLong) || (a.isShort && b.isShort);
}

/** Try call+put same-side pair -> straddle / strangle. */
function classifyStraddleFamily(
  a: LegFeature,
  b: LegFeature,
): { type: StrategyType; name: string } | null {
  if (!a.isOption || !b.isOption) return null;
  if (a.occ!.optionType === b.occ!.optionType) return null; // need one call + one put
  if (!bothSameSide(a, b)) return null;
  if (a.occ!.expiration !== b.occ!.expiration) return null; // both straddle & strangle need same expiry
  const sameStrike = a.occ!.strikePrice === b.occ!.strikePrice;
  return sameStrike
    ? { type: "straddle", name: defaultStrategyLabel("straddle") }
    : { type: "strangle", name: defaultStrategyLabel("strangle") };
}
```

Then, in `detectStrategies`, extend the 2-leg scan so each pair tries family-A first, then family-B. Replace the inner pair-loop body in the "2-leg" section with:

```ts
      const hit = classifyVerticalFamily(pool[i], pool[j]) ?? classifyStraddleFamily(pool[i], pool[j]);
      if (hit) {
        consumed.add(pool[i]);
        consumed.add(pool[j]);
        strategies.push(
          buildStrategyRow(
            underlyingKey,
            hit.type,
            hit.name,
            "auto",
            [pool[i].holding, pool[j].holding],
          ),
        );
        break;
      }
```

- [ ] Step 5.4 — Run (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS.
- [ ] Step 5.5 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): detect straddle/strangle 2-leg spreads

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6 — Stock-based: covered-call & protective-put (stock + 1 option)

Covered call = long stock + short call, with shares ≥ 100 × |short call contracts| (use `multiplier` for the per-contract share count; default 100). Protective put = long stock + long put. These run AFTER the 2-leg option detectors in greedy order, but stock legs are never consumed by the 2-leg option scan (those require two options), so order among them is safe; the spec orders stock+1 last.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 6.1 — Add failing tests. Insert before the trailing `export {...}` line:

```ts
describe("stock-based: covered-call / protective-put", () => {
  it("covered call: long 100 shares + short 1 call", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const { strategies, looseLegs } = detectStrategies([stock, c], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies[0].strategyType).toBe("covered-call");
    expect(strategies[0].name).toBe("Covered Call");
    expect(strategies[0].memberCount).toBe(2);
  });

  it("not covered if shares < 100 * short-call contracts (-> loose)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 50 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const { strategies, looseLegs } = detectStrategies([stock, c], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });

  it("protective put: long stock + long put", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([stock, p], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("protective-put");
    expect(strategies[0].name).toBe("Protective Put");
  });

  it("long stock + long call is not covered/protective (-> loose)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([stock, c], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });
});
```

- [ ] Step 6.2 — Run (expect FAIL). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL.
- [ ] Step 6.3 — Implement. Add a classifier helper above `detectStrategies`:

```ts
/** Try long-stock + 1 option -> covered-call / protective-put. */
function classifyStockPlusOne(
  stock: LegFeature,
  opt: LegFeature,
): { type: StrategyType; name: string } | null {
  if (!stock.isStock || !stock.isLong || !opt.isOption) return null;
  const sharesPerContract = opt.multiplier; // 100 by default
  const requiredShares = sharesPerContract * Math.abs(opt.quantity);
  if (opt.occ!.optionType === "CALL" && opt.isShort && stock.quantity >= requiredShares) {
    return { type: "covered-call", name: defaultStrategyLabel("covered-call") };
  }
  if (opt.occ!.optionType === "PUT" && opt.isLong) {
    return { type: "protective-put", name: defaultStrategyLabel("protective-put") };
  }
  return null;
}
```

Then, in `detectStrategies`, add a new section AFTER the 2-leg scan and BEFORE the final `looseLegs` computation:

```ts
  // ---- stock + 1 option: covered-call / protective-put ----------------
  for (let i = 0; i < pool.length; i++) {
    if (consumed.has(pool[i]) || !pool[i].isStock || !pool[i].isLong) continue;
    for (let j = 0; j < pool.length; j++) {
      if (j === i || consumed.has(pool[j]) || !pool[j].isOption) continue;
      const hit = classifyStockPlusOne(pool[i], pool[j]);
      if (hit) {
        consumed.add(pool[i]);
        consumed.add(pool[j]);
        strategies.push(
          buildStrategyRow(underlyingKey, hit.type, hit.name, "auto", [
            pool[i].holding,
            pool[j].holding,
          ]),
        );
        break;
      }
    }
  }
```

- [ ] Step 6.4 — Run (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS.
- [ ] Step 6.5 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): detect covered-call/protective-put stock strategies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7 — Collar (stock + short call high strike + long put low strike)

Collar = long stock + short call (higher strike) + long put (lower strike). This is a 3-leg (stock + 2 options) detector and per spec section 5.3 runs at priority 3 — BEFORE the stock+1 covered/protective detectors, so a collar is not prematurely consumed as a covered call. Reorder the driver accordingly in this task.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 7.1 — Add failing tests. Insert before the trailing `export {...}` line:

```ts
describe("stock-based: collar", () => {
  it("collar: long stock + short call (high strike) + long put (low strike)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([stock, c, p], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("collar");
    expect(strategies[0].name).toBe("Collar");
    expect(strategies[0].memberCount).toBe(3);
  });

  it("collar takes priority over covered-call (does not split into covered + loose put)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([p, c, stock], NO_OVERRIDES);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("collar");
  });

  it("call strike below put strike is not a collar (-> covered-call + loose put or loose)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(90, EXP_A), quantity: -1 });
    const p = makeHolding({ id: "p", symbol: put(110, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([stock, c, p], NO_OVERRIDES);
    expect(strategies.some((s) => s.strategyType === "collar")).toBe(false);
  });
});
```

- [ ] Step 7.2 — Run (expect FAIL). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL (collar not detected; first test sees covered-call + loose put instead).
- [ ] Step 7.3 — Implement. Add a classifier helper above `detectStrategies`:

```ts
/** Try long-stock + short-call(high) + long-put(low) -> collar. */
function classifyCollar(
  stock: LegFeature,
  callLeg: LegFeature,
  putLeg: LegFeature,
): boolean {
  if (!stock.isStock || !stock.isLong) return false;
  if (!callLeg.isOption || callLeg.occ!.optionType !== "CALL" || !callLeg.isShort) return false;
  if (!putLeg.isOption || putLeg.occ!.optionType !== "PUT" || !putLeg.isLong) return false;
  return callLeg.occ!.strikePrice > putLeg.occ!.strikePrice;
}
```

Then add a collar section in `detectStrategies` placed AFTER the 2-leg scan and BEFORE the covered-call/protective-put section:

```ts
  // ---- collar: stock + short call(high) + long put(low) ----------------
  for (let i = 0; i < pool.length; i++) {
    if (consumed.has(pool[i]) || !pool[i].isStock || !pool[i].isLong) continue;
    const calls = pool.filter((f) => !consumed.has(f) && f.isOption && f.occ!.optionType === "CALL" && f.isShort);
    const puts = pool.filter((f) => !consumed.has(f) && f.isOption && f.occ!.optionType === "PUT" && f.isLong);
    let matched = false;
    for (const c of calls) {
      for (const p of puts) {
        if (classifyCollar(pool[i], c, p)) {
          consumed.add(pool[i]);
          consumed.add(c);
          consumed.add(p);
          strategies.push(
            buildStrategyRow(underlyingKey, "collar", defaultStrategyLabel("collar"), "auto", [
              pool[i].holding,
              c.holding,
              p.holding,
            ]),
          );
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }
```

- [ ] Step 7.4 — Run (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS.
- [ ] Step 7.5 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): detect collar (priority over covered-call)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8 — Butterfly (3 options, same type, same expiry, equidistant K1<K2<K3, ratio 1:2:1)

Butterfly = 3 options, same optionType, same expiry, three distinct strikes K1<K2<K3 equidistant (K2−K1 == K3−K2), with quantity ratio 1:2:1 where the middle strike is opposite-signed to the wings (long butterfly: long wings + short 2× middle; short butterfly: reverse). 3-leg detector, priority 2, runs BEFORE all 2-leg detectors so its inner verticals are not consumed first.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 8.1 — Add failing tests. Insert before the trailing `export {...}` line:

```ts
describe("three-leg: butterfly", () => {
  it("long call butterfly: long 1x K1, short 2x K2, long 1x K3, equidistant", () => {
    const w1 = makeHolding({ id: "w1", symbol: call(90, EXP_A), quantity: 1 });
    const mid = makeHolding({ id: "mid", symbol: call(100, EXP_A), quantity: -2 });
    const w2 = makeHolding({ id: "w2", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([w1, mid, w2], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("butterfly");
    expect(strategies[0].name).toBe("Butterfly");
    expect(strategies[0].memberCount).toBe(3);
  });

  it("short put butterfly: short 1x K1, long 2x K2, short 1x K3", () => {
    const w1 = makeHolding({ id: "w1", symbol: put(90, EXP_A), quantity: -1 });
    const mid = makeHolding({ id: "mid", symbol: put(100, EXP_A), quantity: 2 });
    const w2 = makeHolding({ id: "w2", symbol: put(110, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([w1, mid, w2], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("butterfly");
  });

  it("non-equidistant strikes are not a butterfly (-> loose / partial)", () => {
    const w1 = makeHolding({ id: "w1", symbol: call(90, EXP_A), quantity: 1 });
    const mid = makeHolding({ id: "mid", symbol: call(95, EXP_A), quantity: -2 });
    const w2 = makeHolding({ id: "w2", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([w1, mid, w2], NO_OVERRIDES);
    expect(strategies.some((s) => s.strategyType === "butterfly")).toBe(false);
  });

  it("wrong ratio 1:1:1 is not a butterfly", () => {
    const w1 = makeHolding({ id: "w1", symbol: call(90, EXP_A), quantity: 1 });
    const mid = makeHolding({ id: "mid", symbol: call(100, EXP_A), quantity: -1 });
    const w2 = makeHolding({ id: "w2", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([w1, mid, w2], NO_OVERRIDES);
    expect(strategies.some((s) => s.strategyType === "butterfly")).toBe(false);
  });
});
```

- [ ] Step 8.2 — Run (expect FAIL). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL (butterfly not detected; the 1:2:1 case currently breaks into a vertical + loose legs).
- [ ] Step 8.3 — Implement. Add a classifier helper above `detectStrategies`:

```ts
/** Try 3 same-type same-expiry options -> butterfly (1:2:1, equidistant, mid opposite sign). */
function classifyButterfly(legs: LegFeature[]): boolean {
  if (legs.length !== 3) return false;
  if (!legs.every((f) => f.isOption)) return false;
  const type = legs[0].occ!.optionType;
  if (!legs.every((f) => f.occ!.optionType === type)) return false;
  const exp = legs[0].occ!.expiration;
  if (!legs.every((f) => f.occ!.expiration === exp)) return false;
  const sorted = [...legs].sort((a, b) => a.occ!.strikePrice - b.occ!.strikePrice);
  const [k1, k2, k3] = sorted.map((f) => f.occ!.strikePrice);
  if (k1 === k2 || k2 === k3) return false; // need 3 distinct strikes
  if (k2 - k1 !== k3 - k2) return false; // equidistant
  const [q1, q2, q3] = sorted.map((f) => f.quantity);
  // 1:2:1 with middle opposite-signed: q1 == q3, q2 == -2*q1, |q1| == 1 ratio.
  if (q1 !== q3) return false;
  if (q1 === 0) return false;
  return q2 === -2 * q1;
}
```

Then add a butterfly section in `detectStrategies` placed AT THE TOP of detection (before the 2-leg scan, after pool setup). Butterfly needs to consider 3-combinations of available option legs:

```ts
  // ---- butterfly: 3 same-type same-expiry options, 1:2:1 equidistant ---
  {
    const opts = avail().filter((f) => f.isOption);
    outer: for (let i = 0; i < opts.length; i++) {
      for (let j = i + 1; j < opts.length; j++) {
        for (let k = j + 1; k < opts.length; k++) {
          const trio = [opts[i], opts[j], opts[k]];
          if (trio.some((f) => consumed.has(f))) continue;
          if (classifyButterfly(trio)) {
            trio.forEach((f) => consumed.add(f));
            strategies.push(
              buildStrategyRow(
                underlyingKey,
                "butterfly",
                defaultStrategyLabel("butterfly"),
                "auto",
                trio.map((f) => f.holding),
              ),
            );
            continue outer;
          }
        }
      }
    }
  }
```

- [ ] Step 8.4 — Run (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS.
- [ ] Step 8.5 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): detect butterfly (1:2:1 equidistant, priority over verticals)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9 — Iron condor & iron butterfly (4 options, same expiry)

Iron condor = 4 options same expiry: long put (lowest) + short put + short call + long call (highest), with **all put strikes < all call strikes**. Iron butterfly = same shape but the short put and short call share the same middle strike. 4-leg detector, priority 1 (most specific), runs BEFORE butterfly and the 2-leg detectors so its inner spreads are not consumed.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 9.1 — Add failing tests. Insert before the trailing `export {...}` line:

```ts
describe("four-leg: iron-condor / iron-butterfly", () => {
  it("iron condor: long put 80, short put 90, short call 110, long call 120, all same expiry", () => {
    const lp = makeHolding({ id: "lp", symbol: put(80, EXP_A), quantity: 1 });
    const sp = makeHolding({ id: "sp", symbol: put(90, EXP_A), quantity: -1 });
    const sc = makeHolding({ id: "sc", symbol: call(110, EXP_A), quantity: -1 });
    const lc = makeHolding({ id: "lc", symbol: call(120, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([lp, sp, sc, lc], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("iron-condor");
    expect(strategies[0].name).toBe("Iron Condor");
    expect(strategies[0].memberCount).toBe(4);
  });

  it("iron butterfly: short put and short call share middle strike 100", () => {
    const lp = makeHolding({ id: "lp", symbol: put(90, EXP_A), quantity: 1 });
    const sp = makeHolding({ id: "sp", symbol: put(100, EXP_A), quantity: -1 });
    const sc = makeHolding({ id: "sc", symbol: call(100, EXP_A), quantity: -1 });
    const lc = makeHolding({ id: "lc", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([lp, sp, sc, lc], NO_OVERRIDES);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("iron-butterfly");
    expect(strategies[0].name).toBe("Iron Butterfly");
  });

  it("iron condor takes priority over its inner verticals", () => {
    const lp = makeHolding({ id: "lp", symbol: put(80, EXP_A), quantity: 1 });
    const sp = makeHolding({ id: "sp", symbol: put(90, EXP_A), quantity: -1 });
    const sc = makeHolding({ id: "sc", symbol: call(110, EXP_A), quantity: -1 });
    const lc = makeHolding({ id: "lc", symbol: call(120, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([lc, sp, lp, sc], NO_OVERRIDES);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("iron-condor");
  });

  it("put strikes overlapping call strikes is not an iron condor", () => {
    const lp = makeHolding({ id: "lp", symbol: put(80, EXP_A), quantity: 1 });
    const sp = makeHolding({ id: "sp", symbol: put(115, EXP_A), quantity: -1 }); // > a call strike
    const sc = makeHolding({ id: "sc", symbol: call(110, EXP_A), quantity: -1 });
    const lc = makeHolding({ id: "lc", symbol: call(120, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([lp, sp, sc, lc], NO_OVERRIDES);
    expect(strategies.some((s) => s.strategyType === "iron-condor")).toBe(false);
  });
});
```

- [ ] Step 9.2 — Run (expect FAIL). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL (iron structures break into 2 verticals).
- [ ] Step 9.3 — Implement. Add a classifier helper above `detectStrategies`:

```ts
/** Try 4 same-expiry options -> iron-condor / iron-butterfly. Returns the type or null. */
function classifyIron(legs: LegFeature[]): StrategyType | null {
  if (legs.length !== 4) return null;
  if (!legs.every((f) => f.isOption)) return null;
  const exp = legs[0].occ!.expiration;
  if (!legs.every((f) => f.occ!.expiration === exp)) return null;

  const puts = legs.filter((f) => f.occ!.optionType === "PUT");
  const calls = legs.filter((f) => f.occ!.optionType === "CALL");
  if (puts.length !== 2 || calls.length !== 2) return null;

  const longPut = puts.find((f) => f.isLong);
  const shortPut = puts.find((f) => f.isShort);
  const longCall = calls.find((f) => f.isLong);
  const shortCall = calls.find((f) => f.isShort);
  if (!longPut || !shortPut || !longCall || !shortCall) return null;

  // long put is the lowest, long call the highest; shorts in the middle.
  if (!(longPut.occ!.strikePrice < shortPut.occ!.strikePrice)) return null;
  if (!(shortCall.occ!.strikePrice < longCall.occ!.strikePrice)) return null;
  // all put strikes < all call strikes
  const maxPut = Math.max(longPut.occ!.strikePrice, shortPut.occ!.strikePrice);
  const minCall = Math.min(longCall.occ!.strikePrice, shortCall.occ!.strikePrice);
  if (!(maxPut <= minCall)) return null;

  // iron butterfly: short put and short call share the same middle strike
  if (shortPut.occ!.strikePrice === shortCall.occ!.strikePrice) return "iron-butterfly";
  // iron condor: strict separation (short put < short call)
  if (shortPut.occ!.strikePrice < shortCall.occ!.strikePrice) return "iron-condor";
  return null;
}
```

Then add an iron section in `detectStrategies` placed AT THE VERY TOP of detection (before the butterfly section). It scans 4-combinations of available option legs:

```ts
  // ---- iron-condor / iron-butterfly: 4 same-expiry options ------------
  {
    const opts = avail().filter((f) => f.isOption);
    outerIron: for (let a = 0; a < opts.length; a++) {
      for (let b = a + 1; b < opts.length; b++) {
        for (let c = b + 1; c < opts.length; c++) {
          for (let d = c + 1; d < opts.length; d++) {
            const quad = [opts[a], opts[b], opts[c], opts[d]];
            if (quad.some((f) => consumed.has(f))) continue;
            const type = classifyIron(quad);
            if (type) {
              quad.forEach((f) => consumed.add(f));
              strategies.push(
                buildStrategyRow(
                  underlyingKey,
                  type,
                  defaultStrategyLabel(type),
                  "auto",
                  quad.map((f) => f.holding),
                ),
              );
              continue outerIron;
            }
          }
        }
      }
    }
  }
```

- [ ] Step 9.4 — Run (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS.
- [ ] Step 9.5 — Verify the greedy ordering in the source: confirm the sections in `detectStrategies` appear top-to-bottom as iron (4) → butterfly (3) → 2-leg verticals/calendar/diagonal/straddle/strangle → collar (stock+2) → covered-call/protective-put (stock+1) → looseLegs. NOTE the spec lists collar at priority 3 (before 2-leg) for stock interplay, but since 2-leg detectors only consume option pairs and collar requires a stock leg, the option pairs cannot poach a collar's call/put. Keep collar BEFORE covered-call/protective-put (Task 7) so the collar's call is not consumed as a covered call. This ordering is asserted by the Task 7 priority test and the Task 9 priority test.
- [ ] Step 9.6 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): detect iron-condor/iron-butterfly (top priority)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10 — Override application (mode 'group' / 'exclude'), runs first

Overrides are applied BEFORE auto-detection (spec section 5.3 step 1). A `mode='group'` record rematches its `legs[]` by OCC symbol + accountId against the pool; matched legs are removed and assembled into a `StrategyGroupRow{source:'override'}` with display name `name ?? defaultStrategyLabel(strategyType)`; groups with `< 2` matched legs are hidden (dropped). A `mode='exclude'` record's matched legs are removed and pushed directly to `looseLegs`.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`

- [ ] Step 10.1 — Add failing tests. First extend the test imports to construct overrides (no new import needed beyond `StrategyOverride`, already imported). Add a small override factory and tests; insert before the trailing `export {...}` line:

```ts
function makeOverride(p: {
  id: string;
  accountId?: string;
  underlying?: string;
  name?: string | null;
  strategyType?: StrategyOverride["strategyType"];
  legs: string[];
  mode: "group" | "exclude";
}): StrategyOverride {
  return {
    id: p.id,
    accountId: p.accountId ?? "acct-1",
    underlying: p.underlying ?? "ASTS",
    name: p.name ?? null,
    strategyType: p.strategyType ?? null,
    legs: p.legs,
    mode: p.mode,
    createdAt: "2026-05-31T00:00:00Z",
    updatedAt: "2026-05-31T00:00:00Z",
  };
}

describe("override application", () => {
  it("mode='group' assembles matched legs into an override strategy row", () => {
    const a = makeHolding({ id: "a", symbol: call(100, EXP_A), quantity: 1 });
    const b = makeHolding({ id: "b", symbol: call(110, EXP_A), quantity: -1 });
    const ovr = makeOverride({
      id: "o1",
      name: "My Spread",
      strategyType: "vertical",
      legs: [call(100, EXP_A), call(110, EXP_A)],
      mode: "group",
    });
    const { strategies, looseLegs } = detectStrategies([a, b], [ovr]);
    expect(looseLegs).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].source).toBe("override");
    expect(strategies[0].overrideId).toBe("o1");
    expect(strategies[0].name).toBe("My Spread");
    expect(strategies[0].strategyType).toBe("vertical");
  });

  it("mode='group' with null name falls back to the strategyType label", () => {
    const a = makeHolding({ id: "a", symbol: call(100, EXP_A), quantity: 1 });
    const b = makeHolding({ id: "b", symbol: call(110, EXP_A), quantity: -1 });
    const ovr = makeOverride({ id: "o1", name: null, strategyType: "vertical", legs: [call(100, EXP_A), call(110, EXP_A)], mode: "group" });
    const { strategies } = detectStrategies([a, b], [ovr]);
    expect(strategies[0].name).toBe("Vertical Spread");
  });

  it("mode='group' with null strategyType uses 'custom' label", () => {
    const a = makeHolding({ id: "a", symbol: call(100, EXP_A), quantity: 1 });
    const b = makeHolding({ id: "b", symbol: put(90, EXP_A), quantity: -1 });
    const ovr = makeOverride({ id: "o1", name: null, strategyType: null, legs: [call(100, EXP_A), put(90, EXP_A)], mode: "group" });
    const { strategies } = detectStrategies([a, b], [ovr]);
    expect(strategies[0].strategyType).toBe("custom");
    expect(strategies[0].name).toBe("Custom Strategy");
  });

  it("group override matching < 2 present legs is hidden (legs still go to auto)", () => {
    // override references 2 legs but only 1 is present; closed leg dropped out.
    const a = makeHolding({ id: "a", symbol: call(100, EXP_A), quantity: 1 });
    const ovr = makeOverride({ id: "o1", legs: [call(100, EXP_A), call(110, EXP_A)], mode: "group" });
    const { strategies, looseLegs } = detectStrategies([a, ovr ? a : a].slice(0, 1) as Holding[], [ovr]);
    // the single present leg is NOT grouped (hidden) -> falls through to auto -> loose
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toEqual([a]);
  });

  it("mode='exclude' forces matched legs to loose, skipping auto-detection", () => {
    const a = makeHolding({ id: "a", symbol: call(100, EXP_A), quantity: 1 });
    const b = makeHolding({ id: "b", symbol: call(110, EXP_A), quantity: -1 });
    const ovr = makeOverride({ id: "o1", legs: [call(100, EXP_A), call(110, EXP_A)], mode: "exclude" });
    const { strategies, looseLegs } = detectStrategies([a, b], [ovr]);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });

  it("override only matches legs in the same account", () => {
    const a = makeHolding({ id: "a", symbol: call(100, EXP_A), quantity: 1, accountId: "acct-1" });
    const b = makeHolding({ id: "b", symbol: call(110, EXP_A), quantity: -1, accountId: "acct-2" });
    const ovr = makeOverride({ id: "o1", accountId: "acct-1", legs: [call(100, EXP_A), call(110, EXP_A)], mode: "group" });
    const { strategies, looseLegs } = detectStrategies([a, b], [ovr]);
    // only leg a matches the override account -> < 2 -> hidden -> both fall to auto.
    // a + b are same account? no (different) -> auto sees a(acct1)+b(acct2); they still
    // form a vertical by symbol, but only 1 matched the override so override is hidden.
    expect(strategies.some((s) => s.source === "override")).toBe(false);
    expect(looseLegs.length + strategies.flatMap((s) => s.subRows).length).toBe(2);
  });
});
```

- [ ] Step 10.2 — Run (expect FAIL). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: FAIL (overrides currently ignored — `_overrides` unused).
- [ ] Step 10.3 — Implement. Add a label resolver and the override pass. First add a helper above `detectStrategies`:

```ts
/** Resolve the display name for an override: name ?? label(strategyType ?? 'custom'). */
function overrideName(ovr: StrategyOverride): string {
  if (ovr.name) return ovr.name;
  return defaultStrategyLabel(ovr.strategyType ?? "custom");
}
```

Then change the `detectStrategies` signature to use `overrides` (rename `_overrides` → `overrides`) and insert the override pass IMMEDIATELY after `consumed`/`strategies` are declared and BEFORE the iron-condor section. Replace:

```ts
  const consumed = new Set<LegFeature>();
  const strategies: StrategyGroupRow[] = [];

  const avail = () => pool.filter((f) => !consumed.has(f));
```

with:

```ts
  const consumed = new Set<LegFeature>();
  const strategies: StrategyGroupRow[] = [];
  const forcedLoose = new Set<LegFeature>();

  const avail = () => pool.filter((f) => !consumed.has(f) && !forcedLoose.has(f));

  // ---- override pass (runs first) -------------------------------------
  for (const ovr of overrides) {
    const matched = pool.filter(
      (f) =>
        !consumed.has(f) &&
        !forcedLoose.has(f) &&
        f.holding.accountId === ovr.accountId &&
        ovr.legs.includes(f.symbol),
    );
    if (ovr.mode === "exclude") {
      matched.forEach((f) => forcedLoose.add(f));
      continue;
    }
    // mode === 'group': hide groups with < 2 matched legs.
    if (matched.length < 2) continue;
    matched.forEach((f) => consumed.add(f));
    const type: StrategyType = ovr.strategyType ?? "custom";
    strategies.push(
      buildStrategyRow(
        underlyingKey,
        type,
        overrideName(ovr),
        "override",
        matched.map((f) => f.holding),
        ovr.id,
      ),
    );
  }
```

Then, at the END of `detectStrategies`, change the final `looseLegs` to include the forced-loose legs in original order:

```ts
  const looseLegs = pool
    .filter((f) => !consumed.has(f))
    .map((f) => f.holding);
  return { strategies, looseLegs };
```

(Note: `forcedLoose` legs are never in `consumed`, so they naturally appear in `looseLegs`; `avail()` excludes them so auto-detection skips them.)

- [ ] Step 10.4 — Run (expect PASS). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS.
- [ ] Step 10.5 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): apply group/exclude overrides before auto-detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11 — Greedy ordering, ambiguity, and mixed-pool integration tests

End-to-end tests over a mixed pool to lock the greedy order and the "consumed at most once" / "leftover → loose" invariants. No new implementation — these must pass against Tasks 4-10. If any fail, fix via TDD (write the minimal predicate/order fix), do NOT loosen the test.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`

- [ ] Step 11.1 — Add integration tests. Insert before the trailing `export {...}` line:

```ts
describe("greedy ordering & ambiguity (integration)", () => {
  it("a clean iron condor is one group, not two verticals", () => {
    const legs = [
      makeHolding({ id: "lp", symbol: put(80, EXP_A), quantity: 1 }),
      makeHolding({ id: "sp", symbol: put(90, EXP_A), quantity: -1 }),
      makeHolding({ id: "sc", symbol: call(110, EXP_A), quantity: -1 }),
      makeHolding({ id: "lc", symbol: call(120, EXP_A), quantity: 1 }),
    ];
    const { strategies } = detectStrategies(legs, NO_OVERRIDES);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("iron-condor");
  });

  it("each leg is consumed at most once across families", () => {
    // a vertical + an unrelated lone short put: vertical groups, put stays loose.
    const legs = [
      makeHolding({ id: "L", symbol: call(100, EXP_A), quantity: 1 }),
      makeHolding({ id: "S", symbol: call(110, EXP_A), quantity: -1 }),
      makeHolding({ id: "p", symbol: put(95, EXP_A), quantity: -1 }),
    ];
    const { strategies, looseLegs } = detectStrategies(legs, NO_OVERRIDES);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(looseLegs).toHaveLength(1);
    expect(looseLegs[0].id).toBe("p");
    const grouped = strategies.flatMap((s) => s.subRows.map((h) => h.id));
    const all = [...grouped, ...looseLegs.map((h) => h.id)];
    expect(new Set(all).size).toBe(all.length); // no leg counted twice
  });

  it("strategies come before loose legs and totals reconcile", () => {
    const legs = [
      makeHolding({ id: "L", symbol: call(100, EXP_A), quantity: 1, cost: 600 }),
      makeHolding({ id: "S", symbol: call(110, EXP_A), quantity: -1, cost: -200 }),
      makeHolding({ id: "x", symbol: put(95, EXP_B), quantity: 1, cost: 50 }),
    ];
    const { strategies, looseLegs } = detectStrategies(legs, NO_OVERRIDES);
    const totalLegs = strategies.reduce((n, s) => n + s.memberCount, 0) + looseLegs.length;
    expect(totalLegs).toBe(3);
  });

  it("a degenerate same-strike same-expiry call straddle-shape with opposite sides stays loose", () => {
    const c = makeHolding({ id: "c", symbol: call(100, EXP_A), quantity: 1 });
    const c2 = makeHolding({ id: "c2", symbol: call(100, EXP_A), quantity: -1 });
    const { strategies, looseLegs } = detectStrategies([c, c2], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });
});
```

- [ ] Step 11.2 — Run (expect PASS, since Tasks 4-10 implement all needed predicates). Command: `pnpm --filter frontend test -- detect-strategies`. Expected: PASS. If a case FAILS, debug the corresponding predicate/order with systematic-debugging and fix minimally.
- [ ] Step 11.3 — Run the full type-check and the whole frontend suite to confirm no regressions. Commands: `pnpm type-check` (expect PASS) and `pnpm --filter frontend test -- detect-strategies group-by-underlying` (expect PASS).
- [ ] Step 11.4 — Commit:

```sh
git add apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "test(holdings): greedy ordering and ambiguity integration coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Definition of Done

- [ ] `StrategyGroupRow` (all spec fields incl `netCashBase`, `source`, `overrideId`, `id` format) + `isStrategyGroupRow` exported from `apps/frontend/src/lib/types.ts`, referencing Plan 1's `StrategyType` (NOT re-declared here).
- [ ] `detectStrategies(legs, overrides)`, `buildStrategyRow(...)`, and `defaultStrategyLabel(type)` exported from `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`.
- [ ] All families detected per spec section 5.4 table: vertical (uniform call/put direction rule), calendar, diagonal, straddle, strangle, covered-call (≥100×contracts share gate), protective-put, collar (call>put strike), butterfly (1:2:1 equidistant), iron-condor (puts<calls), iron-butterfly (shared middle strike).
- [ ] Greedy order iron(4) → butterfly(3) → 2-leg → collar(stock+2) → covered/protective(stock+1); each leg consumed at most once; leftovers/ambiguous → `looseLegs`.
- [ ] Overrides applied first: `group` (rematch OCC+account, `name ?? label`, hide `<2`) / `exclude` (force loose).
- [ ] `pnpm --filter frontend test -- detect-strategies` PASS; `pnpm type-check` PASS.
- [ ] No backend, no `group-by-underlying` integration, no view rendering touched.
