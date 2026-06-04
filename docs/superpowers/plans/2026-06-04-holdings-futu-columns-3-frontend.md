# Holdings — Futu-style Metric Columns (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the desktop and mobile holdings tables into a Futu-style layout — a frozen first "Position" column plus a horizontally scrollable area of stacked (top/bottom) metric columns — driven by one shared column-descriptor module, reading `Holding.realizedGain` (shows 0/None until the backend layers land).

**Architecture:** A new descriptor module (`holdings-metrics.ts`) exposes an ordered list of metric columns with `top`/`bottom`/`pct`/group/strategy accessors. The shared `DataTable` gains an opt-in `pinFirstColumn` prop that makes the first header+body cell sticky. The desktop table builds its `tanstack` columns from the descriptors and enables `pinFirstColumn`; the mobile table renders the same descriptors as a hand-rolled sticky-first-column + horizontal-scroll grid. Group aggregation (`group-by-underlying.ts` / `detect-strategies.ts`) gains `unrealizedGainBase` + `realizedGainBase` so group/strategy rows can feed the new columns.

**Tech Stack:** React 18, TypeScript, `@tanstack/react-table`, Vitest + React Testing Library, Tailwind, `@wealthfolio/ui` (`AmountDisplay`, `GainPercent`, `QuantityDisplay`, `parseOccSymbol`).

---

## File Structure

**Created**
- `apps/frontend/src/pages/holdings/utils/holdings-metrics.ts` — single source of truth for the ordered metric columns: id, label, alignment, `defaultVisible`, `showPct`, and `top`/`bottom`/`pct` accessors for leaf `Holding`, `HoldingGroupRow`, and `StrategyGroupRow` rows. Also exports the leaf average-cost helper.
- `apps/frontend/src/pages/holdings/utils/holdings-metrics.test.ts` — unit tests for the descriptor accessors (market value, qty, price, option avg-cost, day, unrealized + its %, realized, holding, weight) across leaf/group/strategy rows.

**Modified**
- `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts` — add `unrealizedGainBase` + `realizedGainBase` to `HoldingGroupRow` and aggregate them in `buildGroupRow`.
- `apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts` — assert the two new aggregated fields.
- `apps/frontend/src/pages/holdings/utils/detect-strategies.ts` — aggregate `unrealizedGainBase` + `realizedGainBase` in `buildStrategyRow`.
- `apps/frontend/src/lib/types.ts` — add `unrealizedGainBase` + `realizedGainBase` to the `StrategyGroupRow` interface (~L2391).
- `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts` — assert the two new aggregated fields on a strategy row.
- `packages/ui/src/components/ui/data-table/index.tsx` — add opt-in `pinFirstColumn?: boolean`; when set, the first header + body cell get sticky left-0 styling. Default off → existing callers unchanged.
- `apps/frontend/src/pages/holdings/components/data-table-pin.test.tsx` — **(Created)** render test for `pinFirstColumn` (frontend app hosts the test because `@wealthfolio/ui` has no test runner).
- `apps/frontend/src/pages/holdings/components/holdings-table.tsx` — rebuild `getColumns` from the descriptors into stacked cells; enable `pinFirstColumn`; remove the table's Total/Daily `AnimatedToggleGroup` (keep the parent `showTotalReturn` prop for the summary bar).
- `apps/frontend/src/pages/holdings/components/holdings-table.test.tsx` — update for the new column structure / removed toggle.
- `apps/frontend/src/pages/holdings/components/holdings-table-mobile.tsx` — replace the card body with a frozen-first-column + horizontally scrollable metric grid built from the descriptors; keep search, filter sheet, account scope, group/strategy toggles, expand/collapse.
- `apps/frontend/src/pages/holdings/components/holdings-table-mobile.test.tsx` — update for the new grid structure.

---

## Verified commands (read from config)

- **Single test file:** `pnpm --filter frontend exec vitest run <path-relative-to-apps/frontend>`
  (verified: `pnpm --filter frontend exec vitest run src/pages/holdings/utils/group-by-underlying.test.ts` → `Test Files 1 passed (1)`).
- **All frontend tests:** `pnpm --filter frontend test` (alias for `vitest`, runs once in CI mode is `vitest run`; use the single-file form above for fast TDD loops).
- **Type check (this app only):** `pnpm --filter frontend type-check` (`tsc --noEmit`).
- **Lint (this app only):** `pnpm --filter frontend lint` (`eslint .`).
- Vitest config lives in `apps/frontend/vite.config.ts` (`test:` block at L93–98): `globals: true`, `environment: "jsdom"`, `setupFiles: "./src/test/setup.ts"`.

All git commands below run from the repo root `/home/samsung/ws/wealthfolio_ws/wealthfolio`. Current branch is `feature/holdings-futu-columns` (HEAD `38f9d24e`) — commit directly onto it.

---

### Task 1: Shared metric-column descriptors module

Build the single descriptor list both surfaces consume. A descriptor knows how to read its top value, bottom value, and (for the Unrealized column only) a percent, for each of the three row shapes: leaf `Holding`, `HoldingGroupRow`, `StrategyGroupRow`.

Default-visible columns per spec: `marketValue` (MktVal/Qty), `priceAvgCost` (Price/AvgCost), `day` (Day). Scroll-only: `unrealized`, `realized`, `holding`, `weight`. Only `unrealized` shows a `%`.

Reference anchors:
- `Holding` shape — `apps/frontend/src/lib/types.ts:637-666` (`marketValue`, `costBasis`, `price`, `unrealizedGain`, `realizedGain`, `totalGain`, `dayChange`, `weight`, `contractMultiplier`).
- `HoldingGroupRow` — `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts:8-25` (`marketValueBase`, `dayChangeBase`, `totalGainBase`, `weight`, `underlyingPrice`; `unrealizedGainBase`/`realizedGainBase` added in Task 2).
- `StrategyGroupRow` — `apps/frontend/src/lib/types.ts:2391-2416`.
- `parseOccSymbol` — `apps/frontend/src/lib/occ-symbol.ts:19`.

**Files:**
- Create: `apps/frontend/src/pages/holdings/utils/holdings-metrics.ts`
- Test: `apps/frontend/src/pages/holdings/utils/holdings-metrics.test.ts`

- [ ] **Step 1: Write the failing test file.** Create `apps/frontend/src/pages/holdings/utils/holdings-metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Holding } from "@/lib/types";
import {
  HOLDING_METRIC_COLUMNS,
  getMetricColumn,
  leafAvgCost,
} from "./holdings-metrics";

function leaf(p: {
  symbol: string;
  qty?: number;
  price?: number;
  mvLocal?: number;
  costLocal?: number;
  unrealLocal?: number;
  realLocal?: number;
  totalLocal?: number;
  dayLocal?: number;
  weight?: number;
  multiplier?: number | null;
}): Holding {
  return {
    id: p.symbol,
    instrument: { id: p.symbol, symbol: p.symbol, name: p.symbol, currency: "USD", quoteMode: "LIVE" },
    quantity: p.qty ?? 1,
    price: p.price ?? null,
    contractMultiplier: p.multiplier ?? null,
    localCurrency: "USD",
    baseCurrency: "USD",
    fxRate: 1,
    marketValue: { local: p.mvLocal ?? 0, base: p.mvLocal ?? 0 },
    costBasis: { local: p.costLocal ?? 0, base: p.costLocal ?? 0 },
    unrealizedGain: { local: p.unrealLocal ?? 0, base: p.unrealLocal ?? 0 },
    unrealizedGainPct: null,
    realizedGain: { local: p.realLocal ?? 0, base: p.realLocal ?? 0 },
    totalGain: { local: p.totalLocal ?? 0, base: p.totalLocal ?? 0 },
    dayChange: { local: p.dayLocal ?? 0, base: p.dayLocal ?? 0 },
    weight: p.weight ?? 0,
  } as unknown as Holding;
}

describe("HOLDING_METRIC_COLUMNS shape", () => {
  it("is the ordered Futu column set with only Unrealized showing pct", () => {
    expect(HOLDING_METRIC_COLUMNS.map((c) => c.id)).toEqual([
      "marketValue",
      "priceAvgCost",
      "day",
      "unrealized",
      "realized",
      "holding",
      "weight",
    ]);
    const pctCols = HOLDING_METRIC_COLUMNS.filter((c) => c.showPct).map((c) => c.id);
    expect(pctCols).toEqual(["unrealized"]);
    const visible = HOLDING_METRIC_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);
    expect(visible).toEqual(["marketValue", "priceAvgCost", "day"]);
  });
});

describe("leafAvgCost", () => {
  it("divides cost basis by quantity for a stock (multiplier 1)", () => {
    const h = leaf({ symbol: "AAPL", qty: 10, costLocal: 1500 });
    expect(leafAvgCost(h)).toBeCloseTo(150, 6);
  });
  it("divides by quantity * 100 for an option contract", () => {
    const h = leaf({ symbol: "AAPL260618C00100000", qty: 2, costLocal: 1000, multiplier: 100 });
    // 1000 / (2 * 100) = 5 (per-share premium)
    expect(leafAvgCost(h)).toBeCloseTo(5, 6);
  });
  it("returns 0 when quantity is 0 (no divide-by-zero)", () => {
    const h = leaf({ symbol: "AAPL", qty: 0, costLocal: 100 });
    expect(leafAvgCost(h)).toBe(0);
  });
});

describe("leaf accessors", () => {
  const h = leaf({
    symbol: "AAPL",
    qty: 10,
    price: 200,
    mvLocal: 2000,
    costLocal: 1500,
    unrealLocal: 500,
    realLocal: 120,
    totalLocal: 620,
    dayLocal: 7,
    weight: 0.25,
  });
  it("marketValue top=mv local, bottom=qty", () => {
    const c = getMetricColumn("marketValue");
    expect(c.leafTop(h)).toBe(2000);
    expect(c.leafBottom?.(h)).toBe(10);
  });
  it("priceAvgCost top=price, bottom=avg cost", () => {
    const c = getMetricColumn("priceAvgCost");
    expect(c.leafTop(h)).toBe(200);
    expect(c.leafBottom?.(h)).toBeCloseTo(150, 6);
  });
  it("day top=day change local", () => {
    expect(getMetricColumn("day").leafTop(h)).toBe(7);
  });
  it("unrealized top=unrealized local and pct=unreal/|cost|", () => {
    const c = getMetricColumn("unrealized");
    expect(c.leafTop(h)).toBe(500);
    expect(c.leafPct?.(h)).toBeCloseTo(500 / 1500, 6);
  });
  it("realized top=realized local", () => {
    expect(getMetricColumn("realized").leafTop(h)).toBe(120);
  });
  it("holding top=total gain local", () => {
    expect(getMetricColumn("holding").leafTop(h)).toBe(620);
  });
  it("weight top=weight", () => {
    expect(getMetricColumn("weight").leafTop(h)).toBe(0.25);
  });
  it("unrealized pct is null when cost basis is 0", () => {
    const z = leaf({ symbol: "X", qty: 1, costLocal: 0, unrealLocal: 5 });
    expect(getMetricColumn("unrealized").leafPct?.(z)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, see it fail (module missing).**
```
pnpm --filter frontend exec vitest run src/pages/holdings/utils/holdings-metrics.test.ts
```
Expected: failure — `Failed to resolve import "./holdings-metrics"` (the module does not exist yet).

- [ ] **Step 3: Create the descriptor module (minimal implementation).** Create `apps/frontend/src/pages/holdings/utils/holdings-metrics.ts`:

```ts
import { parseOccSymbol } from "@/lib/occ-symbol";
import type { Holding } from "@/lib/types";
import type { HoldingGroupRow } from "./group-by-underlying";
import type { StrategyGroupRow } from "./detect-strategies";

export type MetricColumnId =
  | "marketValue"
  | "priceAvgCost"
  | "day"
  | "unrealized"
  | "realized"
  | "holding"
  | "weight";

export interface MetricColumn {
  id: MetricColumnId;
  /** Short header label (Futu-style). */
  label: string;
  /** Whether the column is visible before the user opens the show/hide menu. */
  defaultVisible: boolean;
  /** Only the Unrealized column renders a percent under its amount. */
  showPct: boolean;

  // Leaf-row (Holding) accessors. `leafTop` is required; bottom/pct optional.
  leafTop: (h: Holding) => number;
  leafBottom?: (h: Holding) => number;
  leafPct?: (h: Holding) => number | null;

  // Underlying group-row accessors (blank where the cell should be empty).
  groupTop?: (g: HoldingGroupRow) => number | null;
  groupPct?: (g: HoldingGroupRow) => number | null;

  // Strategy group-row accessors.
  strategyTop?: (s: StrategyGroupRow) => number | null;
  strategyPct?: (s: StrategyGroupRow) => number | null;
}

const local = (m: { local: number } | null | undefined): number => m?.local ?? 0;
const base = (m: { base: number } | null | undefined): number => m?.base ?? 0;

/** Average cost per share/contract: costBasis.local / (quantity * (multiplier || 1)). */
export function leafAvgCost(h: Holding): number {
  const isOption = parseOccSymbol(h.instrument?.symbol ?? h.id) !== null;
  const multiplier = isOption ? (h.contractMultiplier ?? 100) : 1;
  const denom = h.quantity * multiplier;
  if (denom === 0) return 0;
  return local(h.costBasis) / denom;
}

const pctOrNull = (numer: number, denom: number): number | null =>
  denom !== 0 ? numer / Math.abs(denom) : null;

export const HOLDING_METRIC_COLUMNS: MetricColumn[] = [
  {
    id: "marketValue",
    label: "MktVal / Qty",
    defaultVisible: true,
    showPct: false,
    leafTop: (h) => local(h.marketValue),
    leafBottom: (h) => h.quantity,
    groupTop: (g) => g.marketValueBase,
    strategyTop: (s) => s.marketValueBase,
  },
  {
    id: "priceAvgCost",
    label: "Price / AvgCost",
    defaultVisible: true,
    showPct: false,
    leafTop: (h) => h.price ?? 0,
    leafBottom: (h) => leafAvgCost(h),
    // Underlying group shows the underlying price; strategy group is blank.
    groupTop: (g) => g.underlyingPrice,
    strategyTop: () => null,
  },
  {
    id: "day",
    label: "Day",
    defaultVisible: true,
    showPct: false,
    leafTop: (h) => local(h.dayChange),
    groupTop: (g) => g.dayChangeBase,
    strategyTop: (s) => s.dayChangeBase,
  },
  {
    id: "unrealized",
    label: "Unrealized",
    defaultVisible: false,
    showPct: true,
    leafTop: (h) => local(h.unrealizedGain),
    leafPct: (h) => pctOrNull(local(h.unrealizedGain), local(h.costBasis)),
    groupTop: (g) => g.unrealizedGainBase,
    groupPct: (g) => pctOrNull(g.unrealizedGainBase, g.costBasisBase),
    strategyTop: (s) => s.unrealizedGainBase,
    strategyPct: (s) => pctOrNull(s.unrealizedGainBase, s.costBasisBase),
  },
  {
    id: "realized",
    label: "Realized",
    defaultVisible: false,
    showPct: false,
    leafTop: (h) => local(h.realizedGain),
    groupTop: (g) => g.realizedGainBase,
    strategyTop: (s) => s.realizedGainBase,
  },
  {
    id: "holding",
    label: "Holding P&L",
    defaultVisible: false,
    showPct: false,
    leafTop: (h) => local(h.totalGain),
    groupTop: (g) => g.totalGainBase,
    strategyTop: (s) => s.totalGainBase,
  },
  {
    id: "weight",
    label: "Weight",
    defaultVisible: false,
    showPct: false,
    leafTop: (h) => h.weight,
    groupTop: (g) => g.weight,
    strategyTop: (s) => s.weight,
  },
];

const BY_ID = new Map<MetricColumnId, MetricColumn>(
  HOLDING_METRIC_COLUMNS.map((c) => [c.id, c]),
);

export function getMetricColumn(id: MetricColumnId): MetricColumn {
  const col = BY_ID.get(id);
  if (!col) throw new Error(`Unknown metric column: ${id}`);
  return col;
}

// `base` is exported-but-unused at module level today; kept inline above for groupTop base sums.
void base;
```

> Note: `groupTop`/`strategyTop` reference `g.unrealizedGainBase`, `g.realizedGainBase`, `s.unrealizedGainBase`, `s.realizedGainBase`. Those fields are added in Task 2 / Task 3. The module type-checks against them now only if Task 2/3 land first — so **execute Task 2 and Task 3 before running `type-check`**, but the *unit test* in this task does not touch group/strategy accessors and passes standalone. If you prefer strict ordering, run Tasks 1→2→3 then do the combined commit; the per-task commits below are still independent at the Vitest level.

- [ ] **Step 4: Run the test, see it pass.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/utils/holdings-metrics.test.ts
```
Expected: `Test Files 1 passed (1)` with all `HOLDING_METRIC_COLUMNS shape`, `leafAvgCost`, and `leaf accessors` tests green.

- [ ] **Step 5: Remove the placeholder `void base` once Task 2/3 land** is deferred; for now keep it so the module is self-consistent. Commit:
```
git add apps/frontend/src/pages/holdings/utils/holdings-metrics.ts apps/frontend/src/pages/holdings/utils/holdings-metrics.test.ts
git commit -m "feat(holdings): shared Futu metric-column descriptors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Aggregate unrealized + realized base into `HoldingGroupRow`

`buildGroupRow` already sums `marketValueBase`, `costBasisBase`, `totalGainBase`, `dayChangeBase`, `weight` (`group-by-underlying.ts:75-114`). Add `unrealizedGainBase` (Σ `h.unrealizedGain.base`) and `realizedGainBase` (Σ `h.realizedGain.base`).

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts` (interface L8-25, aggregation L75-116)
- Test: `apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts` (factory L12-39; group test L64-86)

- [ ] **Step 1: Extend the test factory and add a failing assertion.** In `group-by-underlying.test.ts`, add two fields to the `makeHolding` param object and its returned holding. Replace the factory signature block (L12-23) so it accepts `unreal` and `real`:

```ts
function makeHolding(p: {
  id: string;
  symbol: string;
  name?: string;
  price?: number;
  mv?: number; // marketValue.base
  cost?: number; // costBasis.base
  gain?: number; // totalGain.base
  unreal?: number; // unrealizedGain.base
  real?: number; // realizedGain.base
  day?: number; // dayChange.base
  prevClose?: number; // prevCloseValue.base
  weight?: number;
}): Holding {
```

Then inside the returned object (after the `totalGain` line at L34), add:

```ts
    unrealizedGain: { local: p.unreal ?? 0, base: p.unreal ?? 0 },
    realizedGain: { local: p.real ?? 0, base: p.real ?? 0 },
```

Then extend the existing "groups a stock + its option legs" test (L64-86) to pass `unreal`/`real` and assert the new sums. Replace the three `makeHolding` calls in that test with:

```ts
      makeHolding({ id: "s", symbol: "ASTS", name: "AST SpaceMobile", price: 113.41, mv: 113.41, cost: 123, gain: -9.59, unreal: -9.59, real: 0, day: 1, prevClose: 112.41, weight: 0.1 }),
      makeHolding({ id: "c1", symbol: OCC_CALL, mv: -1264.56, cost: 313, gain: -300, unreal: -340, real: 40, day: 2, prevClose: -1266.56, weight: -0.3 }),
      makeHolding({ id: "c2", symbol: OCC_CALL2, mv: 2028.15, cost: 578, gain: 1450, unreal: 1400, real: 50, day: 3, prevClose: 2025.15, weight: 0.5 }),
```

and add these assertions just after the `group.totalGainBase` assertion (L81):

```ts
    expect(group.unrealizedGainBase).toBeCloseTo(-9.59 - 340 + 1400, 2);
    expect(group.realizedGainBase).toBeCloseTo(0 + 40 + 50, 2);
```

- [ ] **Step 2: Run the test, see it fail.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/utils/group-by-underlying.test.ts
```
Expected: failure — `expect(received).toBeCloseTo(expected)` with `received` `undefined` for `group.unrealizedGainBase` (field not yet on the row).

- [ ] **Step 3: Add the fields to the interface.** In `group-by-underlying.ts`, in the `HoldingGroupRow` interface (after `totalGainPct: number | null;` at L20), add:

```ts
  unrealizedGainBase: number;
  realizedGainBase: number;
```

- [ ] **Step 4: Aggregate in `buildGroupRow`.** Add two accumulators next to the existing ones (after `let totalGainBase = 0;` at L77):

```ts
  let unrealizedGainBase = 0;
  let realizedGainBase = 0;
```

Inside the `for (const h of members)` loop (after `totalGainBase += h.totalGain?.base ?? 0;` at L84), add:

```ts
    unrealizedGainBase += h.unrealizedGain?.base ?? 0;
    realizedGainBase += h.realizedGain?.base ?? 0;
```

In the returned object (after `totalGainPct: ...` at L111), add:

```ts
    unrealizedGainBase,
    realizedGainBase,
```

- [ ] **Step 5: Run the test, see it pass.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/utils/group-by-underlying.test.ts
```
Expected: `Test Files 1 passed (1)`, 13 tests pass.

- [ ] **Step 6: Commit.**
```
git add apps/frontend/src/pages/holdings/utils/group-by-underlying.ts apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts
git commit -m "feat(holdings): aggregate unrealized + realized base into HoldingGroupRow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Aggregate unrealized + realized base into `StrategyGroupRow`

`StrategyGroupRow` is declared in `apps/frontend/src/lib/types.ts:2391-2416` and built in `detect-strategies.ts:80-123` (`buildStrategyRow`). Add the same two fields.

**Files:**
- Modify: `apps/frontend/src/lib/types.ts` (interface L2391-2416)
- Modify: `apps/frontend/src/pages/holdings/utils/detect-strategies.ts` (`buildStrategyRow` L80-123)
- Test: `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts`

- [ ] **Step 1: Inspect the existing strategy test factory.** Open `apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts` and find the leg/holding factory (it mirrors the `makeLeg` helper in `group-by-underlying.test.ts:134-159`, which sets `marketValue`/`costBasis`/`totalGain`). Confirm whether it already constructs a `StrategyGroupRow` via `buildStrategyRow` or `detectStrategies`. Add a focused test at the end of the file:

```ts
describe("buildStrategyRow base-gain aggregation", () => {
  it("sums unrealizedGainBase and realizedGainBase across legs", () => {
    const legA = {
      id: "a",
      accountId: "acc-1",
      instrument: { id: "a", symbol: "ASTS260612C00100000", name: "a", currency: "USD", quoteMode: "LIVE" },
      quantity: 1,
      contractMultiplier: 100,
      localCurrency: "USD",
      baseCurrency: "USD",
      fxRate: 1,
      marketValue: { local: 250, base: 250 },
      costBasis: { local: 300, base: 300 },
      unrealizedGain: { local: -50, base: -50 },
      realizedGain: { local: 10, base: 10 },
      totalGain: { local: -40, base: -40 },
      dayChange: { local: 0, base: 0 },
      prevCloseValue: { local: 0, base: 0 },
      weight: 0,
    } as unknown as Holding;
    const legB = {
      ...legA,
      id: "b",
      instrument: { id: "b", symbol: "ASTS260612C00110000", name: "b", currency: "USD", quoteMode: "LIVE" },
      quantity: -1,
      unrealizedGain: { local: 30, base: 30 },
      realizedGain: { local: 5, base: 5 },
    } as unknown as Holding;

    const row = buildStrategyRow("ASTS", "vertical", "Bull Call Spread", "auto", [legA, legB]);
    expect(row.unrealizedGainBase).toBeCloseTo(-50 + 30, 2);
    expect(row.realizedGainBase).toBeCloseTo(10 + 5, 2);
  });
});
```

Ensure the test file imports `buildStrategyRow` and `Holding`. If `buildStrategyRow` is not already imported, add it to the existing `import { ... } from "./detect-strategies";` line, and add `import type { Holding } from "@/lib/types";` if absent.

- [ ] **Step 2: Run the test, see it fail.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/utils/detect-strategies.test.ts
```
Expected: failure — `row.unrealizedGainBase` is `undefined`, `toBeCloseTo` fails.

- [ ] **Step 3: Add the fields to the `StrategyGroupRow` interface.** In `apps/frontend/src/lib/types.ts`, after `totalGainPct: number | null;` (L2408), add:

```ts
  unrealizedGainBase: number;
  realizedGainBase: number;
```

- [ ] **Step 4: Aggregate in `buildStrategyRow`.** In `detect-strategies.ts`, after `let totalGainBase = 0;` (L91) add:

```ts
  let unrealizedGainBase = 0;
  let realizedGainBase = 0;
```

Inside the `for (const h of legs)` loop, after `totalGainBase += h.totalGain?.base ?? 0;` (L97), add:

```ts
    unrealizedGainBase += h.unrealizedGain?.base ?? 0;
    realizedGainBase += h.realizedGain?.base ?? 0;
```

In the returned object, after `totalGainPct: ...` (L116) add:

```ts
    unrealizedGainBase,
    realizedGainBase,
```

- [ ] **Step 5: Run the test, see it pass.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/utils/detect-strategies.test.ts
```
Expected: `Test Files 1 passed (1)`, all detect-strategies tests pass including the new one.

- [ ] **Step 6: Now run the descriptor + type-check to confirm Task 1's `groupTop`/`strategyTop` resolve.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/utils/holdings-metrics.test.ts
pnpm --filter frontend type-check
```
Expected: holdings-metrics test passes; `type-check` succeeds (the descriptor module's references to `unrealizedGainBase`/`realizedGainBase` now resolve).

- [ ] **Step 7: Commit.**
```
git add apps/frontend/src/lib/types.ts apps/frontend/src/pages/holdings/utils/detect-strategies.ts apps/frontend/src/pages/holdings/utils/detect-strategies.test.ts
git commit -m "feat(holdings): aggregate unrealized + realized base into StrategyGroupRow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Add opt-in `pinFirstColumn` to the shared `DataTable`

`DataTable` is at `packages/ui/src/components/ui/data-table/index.tsx`. `TableHead`/`TableCell` both forward `className` to `th`/`td` (`packages/ui/src/components/ui/table.tsx:44-62`). The body cell loop is L142-147; the header loop is L130-136. The container already does `overflow-auto` when `scrollable` (L125). `@wealthfolio/ui` has **no test runner**, so the render test lives in the frontend app, importing `DataTable` from `@wealthfolio/ui/components/ui/data-table` exactly like `data-table-expansion.test.tsx` does.

**Files:**
- Modify: `packages/ui/src/components/ui/data-table/index.tsx` (props L29-45; signature L47-63; header cell L130-136; body cell L142-147)
- Test (Create): `apps/frontend/src/pages/holdings/components/data-table-pin.test.tsx`

- [ ] **Step 1: Write the failing render test.** Create `apps/frontend/src/pages/holdings/components/data-table-pin.test.tsx`:

```tsx
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

interface Row {
  name: string;
  value: number;
}

const columns: ColumnDef<Row>[] = [
  { id: "name", header: () => <span>Name</span>, cell: ({ row }) => <span>{row.original.name}</span> },
  { id: "value", header: () => <span>Value</span>, cell: ({ row }) => <span>{row.original.value}</span> },
];

const data: Row[] = [{ name: "AAPL", value: 1 }];

describe("DataTable pinFirstColumn", () => {
  it("does not add sticky class to the first cell by default", () => {
    render(<DataTable columns={columns} data={data} />);
    const cell = screen.getByText("AAPL").closest("td");
    expect(cell?.className).not.toContain("sticky");
  });

  it("makes the first header and body cell sticky when pinFirstColumn is set", () => {
    render(<DataTable columns={columns} data={data} pinFirstColumn scrollable />);
    const firstBodyCell = screen.getByText("AAPL").closest("td");
    expect(firstBodyCell?.className).toContain("sticky");
    expect(firstBodyCell?.className).toContain("left-0");

    const firstHeaderCell = screen.getByText("Name").closest("th");
    expect(firstHeaderCell?.className).toContain("sticky");
    expect(firstHeaderCell?.className).toContain("left-0");

    // Non-first cells stay unpinned.
    const secondBodyCell = screen.getByText("1").closest("td");
    expect(secondBodyCell?.className).not.toContain("sticky");
  });
});
```

- [ ] **Step 2: Run the test, see it fail.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/components/data-table-pin.test.tsx
```
Expected: the first test passes (default off), the second fails — `expect(firstBodyCell?.className).toContain("sticky")` fails because no sticky class is applied yet.

- [ ] **Step 3: Add the prop and the sticky styling.** In `packages/ui/src/components/ui/data-table/index.tsx`:

Add to the `DataTableProps` interface (after `filterFromLeafRows?: boolean;` at L44):

```ts
  pinFirstColumn?: boolean;
```

Add to the destructured params (after `filterFromLeafRows = false,` at L62):

```ts
  pinFirstColumn = false,
```

Replace the header cell map (L130-136) so the first column gets sticky classes:

```tsx
                {headerGroup.headers.map((header, index) => {
                  const pinned = pinFirstColumn && index === 0;
                  return (
                    <TableHead
                      key={header.id}
                      className={pinned ? "bg-muted/50 sticky left-0 z-20" : undefined}
                    >
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
```

Replace the body cell map (L144-146) so the first column gets sticky classes with a solid background above the scrolling area:

```tsx
                  {row.getVisibleCells().map((cell, index) => (
                    <TableCell
                      key={cell.id}
                      className={
                        pinFirstColumn && index === 0
                          ? "bg-background sticky left-0 z-10"
                          : undefined
                      }
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
```

> The header keeps its existing `sticky top-0 z-10` on the `TableHeader` (L127); the pinned header cell uses `z-20` so the frozen corner sits above both the scrolling header row and body. Body pinned cells use `z-10` and a solid `bg-background` so scrolled metric cells pass underneath.

- [ ] **Step 4: Run the test, see it pass.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/components/data-table-pin.test.tsx
```
Expected: `Test Files 1 passed (1)`, both tests green.

- [ ] **Step 5: Confirm existing DataTable behavior is unchanged.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/components/data-table-expansion.test.tsx
```
Expected: `Test Files 1 passed (1)` — the opt-in default (`pinFirstColumn = false`) leaves existing callers untouched.

- [ ] **Step 6: Commit.**
```
git add packages/ui/src/components/ui/data-table/index.tsx apps/frontend/src/pages/holdings/components/data-table-pin.test.tsx
git commit -m "feat(ui): opt-in pinFirstColumn on DataTable for frozen first column

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Rebuild the desktop holdings table from descriptors

Rebuild `getColumns` in `holdings-table.tsx` so the symbol column stays frozen (column 1) and the metric columns (2-8) come from `HOLDING_METRIC_COLUMNS`, each rendering a stacked top/bottom cell. Enable `pinFirstColumn` on the `DataTable` (L235). Remove the Total/Daily `AnimatedToggleGroup` (L325-336) but keep the `showTotalReturn`/`setShowTotalReturn` props on the component (the parent summary bar still uses them).

Key existing anchors:
- `DataTable` call: L235-360; `columns={getColumns(...)}` L237-248; `scrollable={true}` L269; `defaultColumnVisibility` L262-267.
- The Total/Daily toggle to remove: L325-336.
- `getColumns` signature + symbol column: L385-553 (keep the symbol column's cell/sort/filter logic; it is the frozen column).
- `getDisplayValueAndCurrency` helper: L55-77 (reused for base/local toggle on leaf cells).
- `showConvertedValues` currency toggle still applies to leaf amounts.

The desktop table currently passes `showTotalReturn` into `getColumns` to switch the "performance" column between total/day. After this task, Day and Holding are separate descriptor columns, so `getColumns` no longer needs `showTotalReturn` for column content — but keep the prop on the component for the parent.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table.tsx`
- Test: `apps/frontend/src/pages/holdings/components/holdings-table.test.tsx`

- [ ] **Step 1: Update the test for the new structure (failing).** In `holdings-table.test.tsx`:

The grouping/strategy/editing tests (L142-377) drive behavior through the symbol column and toolbar toggles and must keep passing. The only removed UI is the Total/Daily toggle, which these tests do not assert. Add a new describe block at the end to lock in the new columns and the absence of the toggle:

```tsx
describe("HoldingsTable Futu columns", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders the default-visible metric column headers", () => {
    renderTable([TSLA]);
    expect(screen.getByText("MktVal / Qty")).toBeInTheDocument();
    expect(screen.getByText("Price / AvgCost")).toBeInTheDocument();
    expect(screen.getByText("Day")).toBeInTheDocument();
  });

  it("no longer renders the table Total/Daily toggle", () => {
    renderTable([TSLA]);
    // The removed toggle rendered buttons labelled exactly "Total" and "Daily".
    expect(screen.queryByText("Daily")).not.toBeInTheDocument();
  });
});
```

> The `DataTableColumnHeader` stub-free path renders the `title` prop as text, so the descriptor `label` strings appear verbatim. If the real `DataTableColumnHeader` wraps the title (e.g. in a button), assert with `screen.getByText("MktVal / Qty", { exact: false })`. Verify by reading `packages/ui/src/components/ui/data-table/data-table-column-header.tsx` before finalizing the matcher.

- [ ] **Step 2: Run the updated test, see the new block fail.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/components/holdings-table.test.tsx
```
Expected: the new `Futu columns` block fails — headers `MktVal / Qty` etc. are not present (columns not rebuilt yet); `Daily` may still be present (toggle not removed yet).

- [ ] **Step 3: Add a stacked-cell helper and a descriptor→ColumnDef builder.** At the top of `holdings-table.tsx` (after the existing imports, near L53), add imports:

```ts
import {
  HOLDING_METRIC_COLUMNS,
  type MetricColumn,
} from "../utils/holdings-metrics";
```

Add a small presentational helper above `getColumns` (after the `getDisplayValueAndCurrency` helper, ~L77):

```tsx
// One stacked metric cell: top amount, optional bottom value, optional pct.
function MetricCell({
  topValue,
  bottomValue,
  pct,
  currency,
  showPct,
  isHidden,
}: {
  topValue: number | null;
  bottomValue?: number | null;
  pct?: number | null;
  currency: string;
  showPct: boolean;
  isHidden: boolean;
}) {
  if (topValue == null) return <div className="min-h-[40px] px-4" />;
  return (
    <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
      <AmountDisplay value={topValue} currency={currency} colorFormat isHidden={isHidden} />
      {showPct && pct != null ? (
        <GainPercent className="text-xs" value={pct} />
      ) : bottomValue != null ? (
        <span className="text-muted-foreground text-xs">{bottomValue}</span>
      ) : (
        <div className="text-xs text-transparent">-</div>
      )}
    </div>
  );
}
```

Add a builder that turns a `MetricColumn` into a `ColumnDef<HoldingRow>`, just below `MetricCell`:

```tsx
function buildMetricColumn(
  metric: MetricColumn,
  isHidden: boolean,
): ColumnDef<HoldingRow> {
  return {
    id: metric.id,
    enableHiding: true,
    enableSorting: true,
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? metric.groupTop?.(row) ?? 0
        : isStrategyGroupRow(row)
          ? metric.strategyTop?.(row) ?? 0
          : metric.leafTop(row),
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end text-right" column={column} title={metric.label} />
    ),
    meta: { label: metric.label },
    cell: ({ row }) => {
      const data = row.original;
      const currency = isHoldingGroupRow(data) || isStrategyGroupRow(data) ? data.baseCurrency : data.localCurrency;
      if (isHoldingGroupRow(data)) {
        return (
          <MetricCell
            topValue={metric.groupTop ? metric.groupTop(data) : null}
            pct={metric.groupPct?.(data)}
            currency={currency}
            showPct={metric.showPct}
            isHidden={isHidden}
          />
        );
      }
      if (isStrategyGroupRow(data)) {
        return (
          <MetricCell
            topValue={metric.strategyTop ? metric.strategyTop(data) : null}
            pct={metric.strategyPct?.(data)}
            currency={currency}
            showPct={metric.showPct}
            isHidden={isHidden}
          />
        );
      }
      return (
        <MetricCell
          topValue={metric.leafTop(data)}
          bottomValue={metric.leafBottom?.(data)}
          pct={metric.leafPct?.(data)}
          currency={currency}
          showPct={metric.showPct}
          isHidden={isHidden}
        />
      );
    },
  };
}
```

> `MetricCell` renders base-currency amounts for group/strategy rows and local-currency for leaf rows, matching the current behavior where group rows show `baseCurrency` and leaf rows show `localCurrency` (`holdings-table.tsx:707-731`). The base/local user toggle (`showConvertedValues`) is intentionally not re-plumbed through every metric column in this pass — leaf cells show local currency, consistent with the mobile card today (`holdings-table-mobile.tsx:215-219`). If the parent requires the toggle on metric cells, thread `showConvertedValues` into `buildMetricColumn` in a follow-up; out of scope for the default decisions.

- [ ] **Step 4: Rebuild `getColumns` to compose [symbol, ...metrics, actions].** Change the `getColumns` signature to drop the now-unused `showTotalReturn` and `showConvertedValues` params it used only for the merged performance column, **only if** they are no longer referenced after removing the `quantity`/`marketPrice`/`bookValue`/`marketValue`/`performance` columns. Concretely:

1. Keep the `symbol` column object (L397-553) verbatim — it is the frozen column.
2. Keep the `symbolName`, `holdingType`, `currency` hidden/utility columns (L554-566, L784-814) — they back search/filter and the column-toggle menu.
3. **Delete** the `quantity` (L567-598), `marketPrice` (L599-644), `bookValue` (L645-687), `marketValue` (L688-733), and `performance` (L734-783) column objects — they are replaced by descriptor columns.
4. Insert the descriptor columns between `symbolName` and `holdingType`:

```tsx
  ...HOLDING_METRIC_COLUMNS.map((m) => buildMetricColumn(m, isHidden)),
```

5. Keep the `actions` column (L815-884) last.

The `getColumns` call site (L237-248) then simplifies — remove the `showConvertedValues` and `showTotalReturn` arguments **only if** the retained columns no longer use them. Verify by searching the final `getColumns` body for `showConvertedValues` / `showTotalReturn`; the symbol column does not use either, so both arguments can be dropped from the signature and call. Update the call to:

```tsx
        columns={getColumns(
          navigate,
          isBalanceHidden,
          onClassify,
          openRename,
          ungroupStrategy,
          selecting,
          selectedLegs,
          toggleLeg,
        )}
```

and the signature to drop `showConvertedValues: boolean,` and `showTotalReturn: boolean,`.

6. Enable the frozen column on the `DataTable` — add `pinFirstColumn` next to `scrollable={true}` (L269):

```tsx
        scrollable={true}
        pinFirstColumn
```

7. Update `defaultColumnVisibility` (L262-267) so scroll-only metrics start hidden, matching `defaultVisible` in the descriptors:

```tsx
        defaultColumnVisibility={{
          currency: false,
          symbolName: false,
          holdingType: false,
          unrealized: false,
          realized: false,
          holding: false,
          weight: false,
        }}
```

- [ ] **Step 5: Remove the Total/Daily toggle.** Delete the `{setShowTotalReturn && ( <AnimatedToggleGroup ... /> )}` block (L325-336). Keep the `showTotalReturn`/`setShowTotalReturn` props in the component's prop list (L82-90) — the parent passes them for the summary bar. If `setShowTotalReturn` and `showTotalReturn` are now unreferenced inside this component, ESLint will flag them; in that case prefix-ignore by keeping them in the destructure but referencing neither is an error. To satisfy lint while preserving the public prop shape, keep them destructured and add `void showTotalReturn;` is **not** desired — instead leave the props in the interface but only destructure what is used. Verify with the lint step below and, if flagged, remove `showTotalReturn`/`setShowTotalReturn` from the destructure (keep them in the prop type) so the component still accepts them without using them.

> The `AnimatedToggleGroup` import (L26) is still used by the Grouped/Flat, Strategy/Legs, and View/Select toggles, so do not remove the import.

- [ ] **Step 6: Run the desktop test, see it pass.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/components/holdings-table.test.tsx
```
Expected: `Test Files 1 passed (1)` — all grouping/strategy/editing tests plus the new `Futu columns` block pass; `Daily` is gone.

- [ ] **Step 7: Type-check and lint the change.**
```
pnpm --filter frontend type-check
pnpm --filter frontend exec eslint src/pages/holdings/components/holdings-table.tsx
```
Expected: no type errors; no eslint errors (resolve any unused-var on `showTotalReturn`/`setShowTotalReturn` per Step 5).

- [ ] **Step 8: Commit.**
```
git add apps/frontend/src/pages/holdings/components/holdings-table.tsx apps/frontend/src/pages/holdings/components/holdings-table.test.tsx
git commit -m "feat(holdings): desktop Futu table from shared descriptors + frozen column

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Rebuild the mobile holdings table as a frozen-column + scrollable metric grid

Replace the card-list body in `holdings-table-mobile.tsx` with a compact table: a frozen first "Position" column and a horizontally scrollable area of the same descriptor metric columns. Keep all existing chrome — search (L316-323), filter button + sheet (L324-337, L422-442), account scope, group/strategy toggles (in the sheet), and expand/collapse (`expandedKeys`/`toggleExpand` L74-89, `expandedStrategies`/`toggleStrategy`).

The mobile surface does not use the shared `DataTable`; it renders its own rows. Implement the frozen column with the same Tailwind primitives used in Task 4: a scroll container (`overflow-x-auto`), and a first cell per row with `sticky left-0 bg-background z-10`. Default-visible metric columns on mobile = the descriptor `defaultVisible` set (`marketValue`, `priceAvgCost`, `day`); the rest are reachable by horizontal scroll (mobile shows all descriptors in the scroll area; no per-column hide menu).

Existing render functions to replace/adapt:
- `renderLeafCard` (L181-241) → `renderLeafRow`
- `renderStrategyCard` (L243-299) → `renderStrategyRow`
- group card branch (L342-405) → group row
- These currently render `marketValue` + total/day gain only; the new rows render the full descriptor metric set in a scrollable strip.

**Files:**
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table-mobile.tsx`
- Test: `apps/frontend/src/pages/holdings/components/holdings-table-mobile.test.tsx`

- [ ] **Step 1: Add a failing test for the metric strip.** In `holdings-table-mobile.test.tsx`, the existing grouping/expand tests (L99-149) rely on `labelMatcher` (a `<p>`-scoped text match L72-73) and on `/CALL/` `/PUT/` appearing once legs are expanded. Keep them working by preserving the symbol label as a `<p>` element and rendering leg subtitles. Add a new block:

```tsx
describe("HoldingsTableMobile Futu metric strip", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders the default metric headers in the scrollable strip", () => {
    renderMobile([IBKR]);
    expect(screen.getByText("MktVal / Qty")).toBeInTheDocument();
    expect(screen.getByText("Price / AvgCost")).toBeInTheDocument();
    expect(screen.getByText("Day")).toBeInTheDocument();
  });
});
```

> The `@wealthfolio/ui` mock in this test file (L24-44) stubs `AmountDisplay`/`GainPercent` as value-only spans. The header labels are plain strings rendered by the component, so they appear regardless of the stub. If the new mobile code imports any additional `@wealthfolio/ui` export (e.g. nothing new is required — `AmountDisplay`, `GainPercent`, `Badge`, `Input`, `Separator`, `usePersistentState` are already stubbed), extend the mock object accordingly. Plan to import `QuantityDisplay` only if you use it; the leaf bottom value (qty) can be rendered as plain text to avoid touching the mock.

- [ ] **Step 2: Run the test, see it fail.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/components/holdings-table-mobile.test.tsx
```
Expected: the new block fails — `MktVal / Qty` header not present (strip not built yet). Existing grouping/expand tests still pass.

- [ ] **Step 3: Import descriptors and build a shared metric-strip renderer.** Add to the imports (near L14):

```ts
import { HOLDING_METRIC_COLUMNS, type MetricColumn } from "../utils/holdings-metrics";
```

Add a metric-strip component inside the module (above the `HoldingsTableMobile` component body), reused by leaf/group/strategy rows. It takes a function that resolves `{ top, bottom, pct }` per descriptor for the given row kind:

```tsx
type MetricValues = { top: number | null; bottom?: number | null; pct?: number | null };

function MetricStrip({
  resolve,
  currency,
  isHidden,
  showHeader,
}: {
  resolve: (m: MetricColumn) => MetricValues;
  currency: string;
  isHidden: boolean;
  showHeader: boolean;
}) {
  return (
    <div className="flex">
      {HOLDING_METRIC_COLUMNS.map((m) => {
        const v = resolve(m);
        return (
          <div key={m.id} className="flex min-w-[88px] flex-col items-end px-2 text-right">
            {showHeader && <span className="text-muted-foreground text-[10px]">{m.label}</span>}
            {v.top == null ? (
              <span className="text-xs text-transparent">-</span>
            ) : (
              <AmountDisplay value={v.top} currency={currency} colorFormat isHidden={isHidden} className="text-sm" />
            )}
            {m.showPct && v.pct != null ? (
              <GainPercent className="text-[10px]" value={v.pct} />
            ) : v.bottom != null ? (
              <span className="text-muted-foreground text-[10px]">{v.bottom}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
```

Add resolvers per row kind:

```tsx
const resolveLeaf = (h: Holding) => (m: MetricColumn): MetricValues => ({
  top: m.leafTop(h),
  bottom: m.leafBottom?.(h),
  pct: m.leafPct?.(h),
});
const resolveGroup = (g: HoldingGroupRow) => (m: MetricColumn): MetricValues => ({
  top: m.groupTop ? m.groupTop(g) : null,
  pct: m.groupPct?.(g),
});
const resolveStrategy = (s: StrategyGroupRow) => (m: MetricColumn): MetricValues => ({
  top: m.strategyTop ? m.strategyTop(s) : null,
  pct: m.strategyPct?.(s),
});
```

Import the row types (extend the existing import at L14-15):

```ts
import {
  groupHoldingsByUnderlying,
  isHoldingGroupRow,
  type HoldingRow,
  type HoldingGroupRow,
} from "../utils/group-by-underlying";
```

> `HoldingGroupRow` is exported from `group-by-underlying.ts:8`. `StrategyGroupRow` is already imported at L15. `Holding` is imported at L5.

- [ ] **Step 4: Compose the frozen-column + scroll layout.** Wrap each row in a flex container: a sticky left cell (avatar + symbol/subtitle, the existing left-hand content from the cards) and a horizontally scrollable `MetricStrip`. Structure for a leaf row (replaces `renderLeafCard`'s body):

```tsx
const renderLeafRow = (holding: Holding) => {
  const symbol = holding.instrument?.symbol ?? holding.id;
  const isCash = symbol.startsWith("$CASH");
  const parsedOption = isCash ? null : parseOccSymbol(symbol);
  const avatarSymbol = isCash ? "$CASH" : parsedOption ? parsedOption.underlying : symbol;
  const displaySymbol = isCash ? symbol.split("-")[0] : parsedOption ? parsedOption.underlying : symbol;
  const subtitle = parsedOption
    ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
    : (holding.instrument?.name ?? null);
  const isNavigable = !isCash && holding.instrument?.symbol;

  return (
    <div key={holding.id} className="flex items-stretch border-b">
      <button
        type="button"
        className={cn(
          "bg-background sticky left-0 z-10 flex min-w-[140px] items-center gap-2 p-2 text-left",
          isNavigable && "hover:bg-muted/50",
        )}
        onClick={() => isNavigable && handleNavigate(holding)}
      >
        <span className="h-4 w-4 shrink-0" />
        <TickerAvatar symbol={avatarSymbol} className="h-8 w-8" />
        <div className="overflow-hidden">
          <p className="truncate text-sm font-semibold">{displaySymbol}</p>
          {subtitle && <p className="text-muted-foreground truncate text-[11px]">{subtitle}</p>}
        </div>
      </button>
      <MetricStrip
        resolve={resolveLeaf(holding)}
        currency={holding.localCurrency}
        isHidden={isBalanceHidden}
        showHeader={false}
      />
    </div>
  );
};
```

The group and strategy rows follow the same pattern: a sticky left button (chevron + avatar/name + member-count `Badge` + net-debit/credit subtitle, copied from the existing cards) plus `<MetricStrip resolve={resolveGroup(row)} currency={row.baseCurrency} ... />` (group) / `resolveStrategy(strategy)` (strategy). Render one header strip at the top of the list so users see the metric labels:

```tsx
<div className="overflow-x-auto">
  <div className="flex border-b">
    <div className="bg-background sticky left-0 z-10 min-w-[140px] p-2" />
    <MetricStrip
      resolve={() => ({ top: null })}
      currency=""
      isHidden={false}
      showHeader
    />
  </div>
  {/* rows... */}
</div>
```

Wrap the whole list body (currently `<div className="space-y-2">` at L339) in `<div className="overflow-x-auto">` so the sticky-left columns freeze while the metric strip scrolls. Replace `renderLeafCard`/`renderStrategyCard`/group-card usages with the new `renderLeafRow`/`renderStrategyRow`/group-row functions.

> Keep `handleNavigate` (L173-179), the empty-state block (L410-418), and the filter sheet (L422-442) unchanged. The grouping/expand state and toggles are unchanged; only the per-row presentation changes.

- [ ] **Step 5: Run the mobile test, see it pass.**
```
pnpm --filter frontend exec vitest run src/pages/holdings/components/holdings-table-mobile.test.tsx
```
Expected: `Test Files 1 passed (1)` — the new metric-strip block passes and the existing grouping/expand/strategy tests still pass (symbol still in a `<p>`, legs still render `CALL`/`PUT` on expand).

- [ ] **Step 6: Type-check and lint.**
```
pnpm --filter frontend type-check
pnpm --filter frontend exec eslint src/pages/holdings/components/holdings-table-mobile.tsx
```
Expected: no type errors, no eslint errors. (Remove any now-unused imports such as `Card`/`Separator` that YOUR change orphaned — verify with eslint's `no-unused-vars`.)

- [ ] **Step 7: Commit.**
```
git add apps/frontend/src/pages/holdings/components/holdings-table-mobile.tsx apps/frontend/src/pages/holdings/components/holdings-table-mobile.test.tsx
git commit -m "feat(holdings): mobile Futu metric strip with frozen first column

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Full-suite verification + cleanup

- [ ] **Step 1: Run the whole frontend test suite.**
```
pnpm --filter frontend exec vitest run
```
Expected: all test files pass, including `holdings-metrics`, `group-by-underlying`, `detect-strategies`, `data-table-pin`, `data-table-expansion`, `holdings-table`, `holdings-table-mobile`.

- [ ] **Step 2: Type-check the whole app.**
```
pnpm --filter frontend type-check
```
Expected: exits 0. Resolve the deferred `void base;` placeholder in `holdings-metrics.ts` only if it triggers a lint/type warning; otherwise leave it (it documents the base-sum option). If it warns, delete the `void base;` line and the unused `base` helper.

- [ ] **Step 3: Lint the touched files.**
```
pnpm --filter frontend exec eslint src/pages/holdings/utils/holdings-metrics.ts src/pages/holdings/components/holdings-table.tsx src/pages/holdings/components/holdings-table-mobile.tsx packages/ui/src/components/ui/data-table/index.tsx
```
Expected: no errors. (The `packages/ui` path lints under the frontend eslint flat config; if it is excluded, run `pnpm --filter @wealthfolio/ui lint` for that one file instead.)

- [ ] **Step 4: Commit any cleanup.**
```
git add -A
git commit -m "chore(holdings): cleanup after Futu column rebuild

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(Skip if the working tree is clean.)

---

## Done criteria

- Desktop and mobile holdings tables render a frozen first column and a horizontally scrollable metric area driven by the single `holdings-metrics.ts` descriptor list.
- Default-visible metric columns are MktVal/Qty, Price/AvgCost, Day; Unrealized/Realized/Holding/Weight are scroll-only; only Unrealized shows a percent.
- `HoldingGroupRow` and `StrategyGroupRow` aggregate `unrealizedGainBase` + `realizedGainBase`.
- The desktop table no longer renders its own Total/Daily toggle; the parent `showTotalReturn` prop is preserved.
- Option average cost = `costBasis.local / (quantity * 100)`; stock avg cost divides by quantity.
- `Holding.realizedGain` is read directly; the Realized column shows 0/None until backend Layers ①/③ land — this plan is independently buildable and testable.
- `pnpm --filter frontend exec vitest run`, `pnpm --filter frontend type-check`, and `pnpm --filter frontend lint` all pass.
