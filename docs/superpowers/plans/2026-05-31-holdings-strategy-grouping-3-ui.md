# Holdings Strategy Grouping (P2) — UI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the auto-detected option-strategy layer as a two-level nest (underlying → strategy → leg) across the desktop table, mobile cards, and dashboard widget, with a persistent "strategy sub-grouping" toggle and desktop-only rename/ungroup/create-group editing wired to the override CRUD.

**Architecture:** `group-by-underlying.ts` (plan 2 extends its row union) calls plan 2's `detectStrategies()` to place `[...strategies, ...looseLegs]` as the underlying's `subRows` when the toggle is on. The TanStack `DataTable` recurses `getSubRows` to depth 2 natively; indentation is keyed off `row.depth`. Desktop columns gain an `isStrategyGroupRow` branch plus a `⋯` menu (Rename/Ungroup) and a leg-selection "Create strategy" flow, all calling plan 1's `use-option-strategies` mutations. Mobile and dashboard render the nested strategy layer read-only.

**Tech Stack:** React 18, TypeScript, TanStack Table v8, `@wealthfolio/ui` (shadcn), `@tanstack/react-query`, Vitest + React Testing Library.

---

## Prerequisites — contracts consumed from plans 1 & 2

This plan DEPENDS ON plan 1 and plan 2. Do **not** redefine these; import and consume them verbatim. They are reproduced here only so steps are self-contained.

**From plan 2 — `apps/frontend/src/pages/holdings/utils/detect-strategies.ts`:**

```ts
// StrategyType — the discriminated set of detectable strategy kinds
export type StrategyType =
  | "vertical"
  | "calendar"
  | "diagonal"
  | "straddle"
  | "strangle"
  | "covered-call"
  | "protective-put"
  | "collar"
  | "butterfly"
  | "iron-condor"
  | "iron-butterfly"
  | "custom";

// StrategyGroupRow — a detected/override strategy group with base aggregates
export interface StrategyGroupRow {
  kind: "strategy";
  id: string; // `strategy:${underlyingKey}:${legKey}`
  underlyingKey: string;
  strategyType: StrategyType;
  name: string; // user name > default label(strategyType)
  source: "auto" | "override";
  overrideId?: string;
  memberCount: number;
  marketValueBase: number;
  costBasisBase: number;
  totalGainBase: number;
  totalGainPct: number | null;
  dayChangeBase: number;
  dayChangePct: number | null;
  weight: number;
  netCashBase: number; // = Σ costBasisBase ; >0 net debit, <0 net credit
  baseCurrency: string;
  subRows: Holding[];
}

// Type guard
export function isStrategyGroupRow(row: unknown): row is StrategyGroupRow;

// Pure detection (overrides applied first, then greedy auto-detect)
export function detectStrategies(
  legs: Holding[],
  overrides: StrategyOverride[],
): { strategies: StrategyGroupRow[]; looseLegs: Holding[] };

// Default display label for a strategy type (used to suggest a name on create)
export function defaultStrategyLabel(strategyType: StrategyType): string;
```

**From plan 1 — `apps/frontend/src/lib/types.ts` + `apps/frontend/src/hooks/use-option-strategies.ts`:**

```ts
// types.ts
export interface StrategyOverride {
  id: string;
  accountId: string;
  underlying: string;
  name: string | null;
  strategyType: StrategyType | null;
  legs: string[];
  mode: "group" | "exclude";
  createdAt: string;
  updatedAt: string;
}

export interface NewStrategyOverride {
  accountId: string;
  underlying: string;
  name: string | null;
  strategyType: StrategyType | null;
  legs: string[];
  mode: "group" | "exclude";
}

export interface UpdateStrategyOverride {
  name?: string | null;
  strategyType?: StrategyType | null;
  legs?: string[];
  mode?: "group" | "exclude";
}

// use-option-strategies.ts
export function useOptionStrategies(): UseQueryResult<StrategyOverride[]>;
export function useCreateOptionStrategy(): UseMutationResult<StrategyOverride, Error, NewStrategyOverride>;
export function useUpdateOptionStrategy(): UseMutationResult<
  StrategyOverride,
  Error,
  { id: string; payload: UpdateStrategyOverride }
>;
export function useDeleteOptionStrategy(): UseMutationResult<void, Error, string>;
```

> If any imported symbol does not yet exist when you reach a task, plans 1/2 are incomplete — stop and finish them first. Do not stub them here.

**Key patterns to copy from (exact paths/lines):**
- Row-union + `buildGroupRow` aggregation: `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts:56-94`.
- Two-level `getSubRows` wiring (already 1-level): `apps/frontend/src/pages/holdings/components/holdings-table.tsx:136`.
- Indentation by `row.depth`: `holdings-table.tsx:224` (`paddingLeft: ${row.depth * 1.5}rem`) and `:265`.
- Group cell render (chevron + avatar + Badge memberCount): `holdings-table.tsx:219-245`.
- `DropdownMenu` three-dot menu: `holdings-table.tsx:548-569`.
- Secondary toggle (`AnimatedToggleGroup` + `usePersistentState`): `holdings-table.tsx:76-79, 148-170`.
- Mobile nested block (`ml-4 border-l pl-2`): `holdings-table-mobile.tsx:309-313`.
- Mobile toggle in sheet: `holdings-mobile-filter-sheet.tsx:70-86`.
- Dashboard nested block + Popover options: `top-holdings.tsx:492-508` and `:355-464`.
- Test mock style for `@wealthfolio/ui`: `holdings-table.test.tsx:19-40`, `holdings-table-mobile.test.tsx:20-40`.
- Mutation-hook shape to mock in tests: `apps/frontend/src/hooks/use-custom-providers.ts:24-74`.

**Commands** (run from repo root `/home/samsung/ws/wealthfolio_ws/wealthfolio`):
- Single test file: `pnpm --filter frontend test -- <pattern>`
- All frontend tests: `pnpm --filter frontend test`
- `pnpm type-check`
- `pnpm lint`

---

## Task 1 — `group-by-underlying.ts`: two-level subRows + strategy sub-grouping flag

**Files:**
- Modify: `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts` (lines 4-21 interface, 35-54 `groupHoldingsByUnderlying`, 56-94 `buildGroupRow`)
- Modify: `apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts` (append new `describe` block)

The underlying-level base aggregation must keep summing **all** legs unchanged. Only `subRows` changes shape: when `groupByStrategy` is on and the underlying has ≥1 option leg, `subRows = [...strategies, ...looseLegs]`; otherwise the flat P1 leg list.

- [ ] **Step 1.1 — Write failing test for `subRows` shape under strategy sub-grouping.** Append to `apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts`:

```ts
import { isStrategyGroupRow } from "./detect-strategies";

// Vertical call spread on ASTS: long low strike + short high strike, same expiry.
const VERT_LONG = "ASTS260612C00100000"; // long 100
const VERT_SHORT = "ASTS260612C00110000"; // short 110

function makeLeg(p: {
  id: string;
  symbol: string;
  qty: number;
  accountId?: string;
  cost?: number;
  mv?: number;
}): Holding {
  return {
    id: p.id,
    accountId: p.accountId ?? "acc-1",
    instrument: { id: p.id, symbol: p.symbol, name: p.symbol, currency: "USD", quoteMode: "LIVE" },
    quantity: p.qty,
    price: 1,
    contractMultiplier: 100,
    localCurrency: "USD",
    baseCurrency: "USD",
    fxRate: 1,
    marketValue: { local: p.mv ?? 0, base: p.mv ?? 0 },
    costBasis: { local: p.cost ?? 0, base: p.cost ?? 0 },
    totalGain: { local: 0, base: 0 },
    dayChange: { local: 0, base: 0 },
    prevCloseValue: { local: 0, base: 0 },
    weight: 0,
  } as unknown as Holding;
}

describe("groupHoldingsByUnderlying — strategy sub-grouping", () => {
  it("nests detected strategies as strategy rows when groupByStrategy is on", () => {
    const rows = groupHoldingsByUnderlying(
      [
        makeLeg({ id: "L1", symbol: VERT_LONG, qty: 1, cost: 300, mv: 250 }),
        makeLeg({ id: "L2", symbol: VERT_SHORT, qty: -1, cost: -100, mv: -80 }),
      ],
      { groupByStrategy: true, overrides: [] },
    );
    expect(rows).toHaveLength(1);
    const group = rows[0] as HoldingGroupRow;
    expect(isHoldingGroupRow(group)).toBe(true);
    // Underlying-level aggregation still sums ALL legs (unchanged).
    expect(group.marketValueBase).toBeCloseTo(250 - 80, 2);
    expect(group.costBasisBase).toBeCloseTo(300 - 100, 2);
    expect(group.memberCount).toBe(2);
    // subRows now holds one strategy row (no loose legs).
    expect(group.subRows).toHaveLength(1);
    expect(isStrategyGroupRow(group.subRows[0])).toBe(true);
  });

  it("places strategies before loose legs in subRows order", () => {
    const loose = makeLeg({ id: "S", symbol: "ASTS", qty: 50 }); // bare stock, < covered-call qty -> loose
    const rows = groupHoldingsByUnderlying(
      [
        makeLeg({ id: "L1", symbol: VERT_LONG, qty: 1, cost: 300, mv: 250 }),
        makeLeg({ id: "L2", symbol: VERT_SHORT, qty: -1, cost: -100, mv: -80 }),
        loose,
      ],
      { groupByStrategy: true, overrides: [] },
    );
    const group = rows[0] as HoldingGroupRow;
    expect(isStrategyGroupRow(group.subRows[0])).toBe(true); // strategy first
    expect(isStrategyGroupRow(group.subRows[group.subRows.length - 1])).toBe(false); // loose last
  });

  it("keeps flat legs (P1 behaviour) when groupByStrategy is off", () => {
    const rows = groupHoldingsByUnderlying(
      [
        makeLeg({ id: "L1", symbol: VERT_LONG, qty: 1, cost: 300, mv: 250 }),
        makeLeg({ id: "L2", symbol: VERT_SHORT, qty: -1, cost: -100, mv: -80 }),
      ],
      { groupByStrategy: false, overrides: [] },
    );
    const group = rows[0] as HoldingGroupRow;
    expect(group.subRows).toHaveLength(2);
    expect(isStrategyGroupRow(group.subRows[0])).toBe(false);
    expect(isStrategyGroupRow(group.subRows[1])).toBe(false);
  });

  it("defaults to flat legs when called with no options arg (back-compat)", () => {
    const rows = groupHoldingsByUnderlying([
      makeLeg({ id: "L1", symbol: VERT_LONG, qty: 1, cost: 300, mv: 250 }),
      makeLeg({ id: "L2", symbol: VERT_SHORT, qty: -1, cost: -100, mv: -80 }),
    ]);
    const group = rows[0] as HoldingGroupRow;
    expect(group.subRows).toHaveLength(2);
    expect(isStrategyGroupRow(group.subRows[0])).toBe(false);
  });
});
```

- [ ] **Step 1.2 — Run it (expected FAIL).** Command: `pnpm --filter frontend test -- group-by-underlying`. Expected: FAIL — `groupHoldingsByUnderlying` currently takes one arg and `subRows` is `Holding[]` only; the strategy assertions fail.

- [ ] **Step 1.3 — Implement the signature + interface change.** Edit `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts`. Replace the imports and `HoldingGroupRow` interface head:

```ts
import { parseOccSymbol } from "@/lib/occ-symbol";
import type { Holding, StrategyOverride } from "@/lib/types";
import {
  detectStrategies,
  type StrategyGroupRow,
} from "./detect-strategies";

export interface HoldingGroupRow {
  kind: "group";
  id: string;
  underlyingKey: string;
  underlyingSymbol: string;
  underlyingName: string | null;
  memberCount: number;
  underlyingPrice: number | null;
  baseCurrency: string;
  marketValueBase: number;
  costBasisBase: number;
  totalGainBase: number;
  totalGainPct: number | null;
  dayChangeBase: number;
  dayChangePct: number | null;
  weight: number;
  subRows: (StrategyGroupRow | Holding)[];
}

export interface GroupOptions {
  groupByStrategy: boolean;
  overrides: StrategyOverride[];
}
```

- [ ] **Step 1.4 — Thread `GroupOptions` through `groupHoldingsByUnderlying` and `buildGroupRow`.** Replace lines 35-94 (`groupHoldingsByUnderlying` + `buildGroupRow`) with:

```ts
export function groupHoldingsByUnderlying(
  holdings: Holding[],
  options?: GroupOptions,
): HoldingRow[] {
  // Map 保留首次出现顺序,输出确定。
  const buckets = new Map<string, Holding[]>();
  for (const holding of holdings) {
    const key = getUnderlyingKey(holding);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(holding);
    else buckets.set(key, [holding]);
  }

  const rows: HoldingRow[] = [];
  for (const [key, members] of buckets) {
    if (members.length < 2) {
      rows.push(members[0]);
    } else {
      rows.push(buildGroupRow(key, members, options));
    }
  }
  return rows;
}

function buildGroupRow(
  underlyingKey: string,
  members: Holding[],
  options?: GroupOptions,
): HoldingGroupRow {
  const stock = members.find((h) => (h.instrument?.symbol ?? h.id) === underlyingKey);

  let marketValueBase = 0;
  let costBasisBase = 0;
  let totalGainBase = 0;
  let dayChangeBase = 0;
  let prevCloseBase = 0;
  let weight = 0;
  for (const h of members) {
    marketValueBase += h.marketValue?.base ?? 0;
    costBasisBase += h.costBasis?.base ?? 0;
    totalGainBase += h.totalGain?.base ?? 0;
    dayChangeBase += h.dayChange?.base ?? 0;
    prevCloseBase += h.prevCloseValue?.base ?? 0;
    weight += h.weight ?? 0;
  }

  let subRows: (StrategyGroupRow | Holding)[] = members;
  const hasOptionLeg = members.some((h) => parseOccSymbol(h.instrument?.symbol ?? h.id) !== null);
  if (options?.groupByStrategy && hasOptionLeg) {
    const { strategies, looseLegs } = detectStrategies(members, options.overrides);
    subRows = [...strategies, ...looseLegs];
  }

  return {
    kind: "group",
    id: `group:${underlyingKey}`,
    underlyingKey,
    underlyingSymbol: underlyingKey,
    underlyingName: stock?.instrument?.name ?? null,
    memberCount: members.length,
    underlyingPrice: stock?.price ?? null,
    // All holdings in a given scope share the same base currency, so taking the
    // first member's is safe; aggregates above are summed in base currency.
    baseCurrency: members[0].baseCurrency,
    marketValueBase,
    costBasisBase,
    totalGainBase,
    totalGainPct: costBasisBase !== 0 ? totalGainBase / Math.abs(costBasisBase) : null,
    dayChangeBase,
    dayChangePct: prevCloseBase !== 0 ? dayChangeBase / Math.abs(prevCloseBase) : null,
    weight,
    subRows,
  };
}
```

- [ ] **Step 1.5 — Run it (expected PASS).** Command: `pnpm --filter frontend test -- group-by-underlying`. Expected: PASS — all new + existing `group-by-underlying` tests green (existing callers pass no options, so `subRows` stays the flat member list).

- [ ] **Step 1.6 — Commit.**

```bash
git add apps/frontend/src/pages/holdings/utils/group-by-underlying.ts apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts
git commit -m "feat(holdings): two-level strategy subRows in group-by-underlying

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 — DataTable: verify recursive `getSubRows` to depth ≥ 2

**Files:**
- Read/confirm: `packages/ui/src/components/ui/data-table/index.tsx` (lines 42, 79-84 — `getSubRows` is already passed to `useReactTable`)
- Modify: `apps/frontend/src/pages/holdings/components/data-table-expansion.test.tsx` (append depth-2 cases)

TanStack Table recurses `getSubRows` natively; no production change is expected. This task proves depth-2 expansion + `row.depth` work and locks it with tests.

- [ ] **Step 2.1 — Write failing test for depth-2 recursion + `row.depth`.** Append to `apps/frontend/src/pages/holdings/components/data-table-expansion.test.tsx`:

```ts
describe("DataTable depth-2 recursion", () => {
  it("expands grandchildren only after both ancestors are expanded", async () => {
    const data: Row[] = [
      { name: "Underlying", subRows: [{ name: "Strategy", subRows: [{ name: "Leg" }] }] },
    ];
    render(
      <DataTable
        data={data}
        columns={columns}
        getSubRows={(row) => row.subRows}
        defaultExpanded={{}}
      />,
    );

    expect(screen.getByText("Underlying")).toBeInTheDocument();
    expect(screen.queryByText("Strategy")).not.toBeInTheDocument();
    expect(screen.queryByText("Leg")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("row-Underlying"));
    expect(screen.getByText("Strategy")).toBeInTheDocument();
    expect(screen.queryByText("Leg")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("row-Strategy"));
    expect(screen.getByText("Leg")).toBeInTheDocument();
  });

  it("exposes row.depth of 0/1/2 across the three levels", () => {
    const data: Row[] = [
      { name: "U", subRows: [{ name: "S", subRows: [{ name: "L" }] }] },
    ];
    const depthCols: ColumnDef<Row>[] = [
      {
        id: "name",
        header: () => <span>Name</span>,
        cell: ({ row }) => (
          <span data-testid={`depth-${row.original.name}`}>{row.depth}</span>
        ),
      },
    ];
    render(
      <DataTable data={data} columns={depthCols} getSubRows={(row) => row.subRows} defaultExpanded={true} />,
    );
    expect(screen.getByTestId("depth-U")).toHaveTextContent("0");
    expect(screen.getByTestId("depth-S")).toHaveTextContent("1");
    expect(screen.getByTestId("depth-L")).toHaveTextContent("2");
  });
});
```

- [ ] **Step 2.2 — Run it.** Command: `pnpm --filter frontend test -- data-table-expansion`. Expected: PASS if TanStack already recurses (likely). If FAIL, proceed to 2.3; otherwise skip to 2.4.

- [ ] **Step 2.3 — (Only if 2.2 failed) Ensure recursion is enabled.** In `packages/ui/src/components/ui/data-table/index.tsx`, confirm `getSubRows` is passed verbatim and `getExpandedRowModel()` is registered (it is, line 109). No code change should be needed beyond what exists; if a `maxDepth`/`getRowCanExpand` limiter was added by another change, remove it so recursion is unbounded. Re-run 2.2 to PASS.

- [ ] **Step 2.4 — Commit.**

```bash
git add apps/frontend/src/pages/holdings/components/data-table-expansion.test.tsx packages/ui/src/components/ui/data-table/index.tsx
git commit -m "test(ui): lock DataTable depth-2 getSubRows recursion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 — Desktop table: strategy sub-grouping toggle + strategy-row rendering (read path)

**Files:**
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table.tsx` (imports 1-31; component body 70-126; `getSubRows`/toolbar 129-194; `getColumns` 201-573)
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table.test.tsx` (extend mocks + add strategy-render cases)

This task adds the toggle, the recursive `getSubRows`, and the `isStrategyGroupRow` render branches on every column. Editing (rename/ungroup/create) comes in Task 4.

- [ ] **Step 3.1 — Write failing test: strategy sub-grouping toggle renders a strategy row.** Extend `holdings-table.test.tsx`. First add to the `@wealthfolio/ui` mock (after the `Badge` line in the existing `vi.mock("@wealthfolio/ui", ...)` block at lines 19-40) the dropdown/dialog/checkbox/label stubs and keep existing ones:

```ts
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Checkbox: ({ onCheckedChange }: { onCheckedChange?: (v: boolean) => void }) => (
    <input type="checkbox" onChange={(e) => onCheckedChange?.(e.target.checked)} />
  ),
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  Icons: new Proxy({}, { get: () => () => <span /> }),
```

Mock the two collaborating modules at the top of the file (after the existing `vi.mock` calls):

```ts
vi.mock("@/hooks/use-option-strategies", () => ({
  useOptionStrategies: () => ({ data: [] }),
  useCreateOptionStrategy: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateOptionStrategy: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteOptionStrategy: () => ({ mutate: vi.fn(), isPending: false }),
}));
```

Then add a strategy-render describe block. Use a real vertical spread so plan 2's detector forms one strategy:

```ts
const VERT_LONG = makeHolding({ id: "vl", symbol: "ASTS260612C00100000", mv: 250 });
const VERT_SHORT = (() => {
  const h = makeHolding({ id: "vs", symbol: "ASTS260612C00110000", mv: -80 });
  return { ...h, quantity: -1 } as Holding;
})();

describe("HoldingsTable strategy sub-grouping", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders a strategy row nested under the underlying when sub-grouping is on", () => {
    renderTable([VERT_LONG, VERT_SHORT]);
    // Strategy default label from plan 2 (vertical -> e.g. "Bull Call Spread"); assert the
    // strategy row's leg-count badge (2) and that legs are still reachable.
    expect(screen.getByRole("button", { name: /Spread/i })).toBeInTheDocument();
  });

  it("falls back to flat legs when the strategy sub-grouping toggle is off", async () => {
    renderTable([VERT_LONG, VERT_SHORT]);
    // Toggle is rendered by the stubbed AnimatedToggleGroup as a button labelled "Legs".
    await userEvent.click(screen.getByText("Legs"));
    expect(screen.queryByRole("button", { name: /Spread/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3.2 — Run it (expected FAIL).** Command: `pnpm --filter frontend test -- holdings-table.test`. Expected: FAIL — no strategy toggle, no strategy-row branch, `use-option-strategies` import unresolved.

- [ ] **Step 3.3 — Add imports + hook wiring to `holdings-table.tsx`.** Update the import block (top of file) to add the strategy types, guard, and hooks. Append to the existing imports:

```ts
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import {
  detectStrategies,
  defaultStrategyLabel,
  isStrategyGroupRow,
  type StrategyGroupRow,
  type StrategyType,
} from "../utils/detect-strategies";
import {
  useOptionStrategies,
  useCreateOptionStrategy,
  useUpdateOptionStrategy,
  useDeleteOptionStrategy,
} from "@/hooks/use-option-strategies";
import { useState } from "react";
```

Change the `group-by-underlying` import (lines 27-31) to also import `GroupOptions` is not needed; only the existing names are used.

- [ ] **Step 3.4 — Add the toggle state + data wiring in the component body.** After the `groupByUnderlying` state (line 79), add:

```ts
  const [groupByStrategy, setGroupByStrategy] = usePersistentState<boolean>(
    "holdings-table:group-by-strategy",
    true,
  );
  const { data: overrides = [] } = useOptionStrategies();
```

Replace the `tableData` computation (lines 123-125) with:

```ts
  const tableData: HoldingRow[] = groupByUnderlying
    ? groupHoldingsByUnderlying(holdings, { groupByStrategy, overrides })
    : holdings;
```

- [ ] **Step 3.5 — Make `getSubRows` recurse to depth 2.** Replace `getSubRows={(row) => (isHoldingGroupRow(row) ? row.subRows : undefined)}` (line 136) with:

```ts
        getSubRows={(row) =>
          isHoldingGroupRow(row)
            ? row.subRows
            : isStrategyGroupRow(row)
              ? row.subRows
              : undefined
        }
```

- [ ] **Step 3.6 — Add the strategy sub-grouping toggle to the toolbar.** Inside the `toolbarActions` div, right after the grouped/flat `AnimatedToggleGroup` (closing at line 158), add (only meaningful when grouped):

```ts
            {groupByUnderlying && (
              <AnimatedToggleGroup
                value={groupByStrategy ? "strategy" : "legs"}
                onValueChange={(value) => setGroupByStrategy(value === "strategy")}
                items={[
                  { value: "strategy", label: "Strategy" },
                  { value: "legs", label: "Legs" },
                ]}
                size="xs"
                rounded="md"
              />
            )}
```

- [ ] **Step 3.7 — Add `isStrategyGroupRow` branches to every column.** In `getColumns`, for each column update the `accessorFn`, `cell`, `sortingFn`, and `filterFn` to handle strategy rows. Apply these edits:

`symbol` column `accessorFn` (line 209-210):

```ts
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.underlyingSymbol
        : isStrategyGroupRow(row)
          ? row.name
          : row.instrument?.symbol ?? row.id,
```

`symbol` column `cell` — insert a strategy branch **before** the `isHoldingGroupRow(data)` block (before line 219):

```ts
      if (isStrategyGroupRow(data)) {
        return (
          <button
            type="button"
            className="-m-1 flex w-full items-center p-1 text-left"
            style={{ paddingLeft: `${row.depth * 1.5}rem` }}
            onClick={row.getToggleExpandedHandler()}
          >
            {row.getIsExpanded() ? (
              <Icons.ChevronDown className="mr-1 h-4 w-4 shrink-0" />
            ) : (
              <Icons.ChevronRight className="mr-1 h-4 w-4 shrink-0" />
            )}
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{data.name}</span>
                <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px]">
                  {data.memberCount}
                </Badge>
              </div>
              <span className="text-muted-foreground line-clamp-1 text-xs">
                {data.netCashBase >= 0
                  ? `Net debit ${data.baseCurrency} ${Math.abs(data.netCashBase).toFixed(2)}`
                  : `Net credit ${data.baseCurrency} ${Math.abs(data.netCashBase).toFixed(2)}`}
              </span>
            </div>
          </button>
        );
      }
```

`symbol` column `sortingFn` (lines 290-296):

```ts
    sortingFn: (rowA, rowB) => {
      const a = rowA.original;
      const b = rowB.original;
      const labelOf = (r: HoldingRow) =>
        isHoldingGroupRow(r)
          ? r.underlyingSymbol
          : isStrategyGroupRow(r)
            ? r.name
            : r.instrument?.symbol ?? r.id;
      return labelOf(a).localeCompare(labelOf(b));
    },
```

`symbol` column `filterFn` (lines 297-313) — add a strategy branch after the `isHoldingGroupRow` branch:

```ts
      if (isStrategyGroupRow(data)) {
        return data.name.toLowerCase().includes(lowerSearch);
      }
```

`quantity` column `accessorFn` (line 327): `isHoldingGroupRow(row) || isStrategyGroupRow(row) ? 0 : row.quantity`. `cell` (lines 335-339): change the guard to `if (isHoldingGroupRow(data) || isStrategyGroupRow(data)) { return <div className="min-h-[40px] px-4" />; }`.

`marketPrice` column `accessorFn` (line 359):

```ts
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.underlyingPrice ?? 0
        : isStrategyGroupRow(row)
          ? 0
          : row.price ?? 0,
```

`cell` (lines 372-393): add `if (isStrategyGroupRow(data)) { return <div className="min-h-[40px] px-4" />; }` before the leaf branch.

`bookValue` column `accessorFn` (line 397):

```ts
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.costBasisBase
        : isStrategyGroupRow(row)
          ? row.costBasisBase
          : row.costBasis?.local ?? 0,
```

`cell` (lines 405-423): add a strategy branch that mirrors the group branch but uses the strategy aggregate:

```ts
      if (isStrategyGroupRow(data)) {
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.costBasisBase} currency={data.baseCurrency} isHidden={isHidden} />
            <div className="text-xs text-transparent">-</div>
          </div>
        );
      }
```

`marketValue` column `accessorFn` (line 427):

```ts
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.marketValueBase
        : isStrategyGroupRow(row)
          ? row.marketValueBase
          : row.marketValue.base ?? 0,
```

`cell` (lines 435-456): add before the leaf branch:

```ts
      if (isStrategyGroupRow(data)) {
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.marketValueBase} currency={data.baseCurrency} isHidden={isHidden} />
            <div className="text-muted-foreground text-xs">{data.baseCurrency}</div>
          </div>
        );
      }
```

`performance` column `accessorFn` (lines 460-463):

```ts
    accessorFn: (row) =>
      isHoldingGroupRow(row) || isStrategyGroupRow(row)
        ? (showTotalReturn ? row.totalGainBase : row.dayChangeBase)
        : (showTotalReturn ? row.totalGain?.base : row.dayChange?.base) ?? 0,
```

`cell` (lines 475-496): add before the leaf branch:

```ts
      if (isStrategyGroupRow(data)) {
        const value = showTotalReturn ? data.totalGainBase : data.dayChangeBase;
        const pct = showTotalReturn ? data.totalGainPct : data.dayChangePct;
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={value} currency={data.baseCurrency} colorFormat={true} isHidden={isHidden} />
            <GainPercent className="text-xs" value={pct || 0} />
          </div>
        );
      }
```

`holdingType` column `accessorFn` (lines 500-501): `isHoldingGroupRow(row) || isStrategyGroupRow(row) ? undefined : row.instrument?.classifications?.assetType?.name`.

`currency` column `accessorFn` (line 510): `isHoldingGroupRow(row) || isStrategyGroupRow(row) ? row.baseCurrency : row.localCurrency`. `cell` (lines 515-521): change the guard to `if (isHoldingGroupRow(data) || isStrategyGroupRow(data)) { return <div className="text-muted-foreground">{data.baseCurrency}</div>; }`.

`actions` column `cell` (lines 530-571): keep the existing `isHoldingGroupRow` empty branch; add a strategy placeholder branch (real menu wired in Task 4) right after it:

```ts
      if (isStrategyGroupRow(data)) {
        return <div className="flex items-center justify-end" />;
      }
```

- [ ] **Step 3.8 — Run it (expected PASS).** Command: `pnpm --filter frontend test -- holdings-table.test`. Expected: PASS — strategy row renders with `/Spread/` label + badge; toggling to "Legs" flattens.

- [ ] **Step 3.9 — Commit.**

```bash
git add apps/frontend/src/pages/holdings/components/holdings-table.tsx apps/frontend/src/pages/holdings/components/holdings-table.test.tsx
git commit -m "feat(holdings): render strategy rows + sub-grouping toggle in desktop table

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4 — Desktop table: rename / ungroup / create-strategy editing wired to overrides

**Files:**
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table.tsx` (extract the columns + edit state into the component so mutations are in scope)
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table.test.tsx` (add edit-flow cases)

`getColumns` is currently a module function; the edit handlers and dialog need React state and mutations. Move the strategy-edit handlers into the component and pass them down via the existing `getColumns(...)` arg list.

- [ ] **Step 4.1 — Write failing test: Rename calls update mutation.** Add to `holdings-table.test.tsx`. Override the `use-option-strategies` mock per-test with spies. Add a describe block:

```ts
describe("HoldingsTable strategy editing", () => {
  beforeEach(() => window.localStorage.clear());

  it("renames a strategy via the context menu dialog (update for override-backed)", async () => {
    const updateMutate = vi.fn();
    const createMutate = vi.fn();
    // override-backed strategy: plan 2 marks source='override' when an override matches.
    vi.mocked(useUpdateOptionStrategy).mockReturnValue({ mutate: updateMutate, isPending: false } as never);
    vi.mocked(useCreateOptionStrategy).mockReturnValue({ mutate: createMutate, isPending: false } as never);
    vi.mocked(useOptionStrategies).mockReturnValue({
      data: [
        {
          id: "ov-1",
          accountId: "vl",
          underlying: "ASTS",
          name: "My Spread",
          strategyType: "vertical",
          legs: ["ASTS260612C00100000", "ASTS260612C00110000"],
          mode: "group",
          createdAt: "",
          updatedAt: "",
        },
      ],
    } as never);

    renderTable([VERT_LONG, VERT_SHORT]);
    await userEvent.click(screen.getByText("Rename"));
    const input = screen.getByPlaceholderText(/strategy name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed");
    await userEvent.click(screen.getByText("Save"));
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ov-1", payload: expect.objectContaining({ name: "Renamed" }) }),
    );
  });

  it("renames an auto-detected strategy by creating a group override", async () => {
    const createMutate = vi.fn();
    vi.mocked(useCreateOptionStrategy).mockReturnValue({ mutate: createMutate, isPending: false } as never);
    vi.mocked(useOptionStrategies).mockReturnValue({ data: [] } as never);

    renderTable([VERT_LONG, VERT_SHORT]);
    await userEvent.click(screen.getByText("Rename"));
    await userEvent.type(screen.getByPlaceholderText(/strategy name/i), "Auto Renamed");
    await userEvent.click(screen.getByText("Save"));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        underlying: "ASTS",
        mode: "group",
        name: "Auto Renamed",
        legs: expect.arrayContaining(["ASTS260612C00100000", "ASTS260612C00110000"]),
      }),
    );
  });

  it("ungroups an auto strategy by creating an exclude override", async () => {
    const createMutate = vi.fn();
    vi.mocked(useCreateOptionStrategy).mockReturnValue({ mutate: createMutate, isPending: false } as never);
    vi.mocked(useOptionStrategies).mockReturnValue({ data: [] } as never);

    renderTable([VERT_LONG, VERT_SHORT]);
    await userEvent.click(screen.getByText("Ungroup"));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        underlying: "ASTS",
        mode: "exclude",
        legs: expect.arrayContaining(["ASTS260612C00100000", "ASTS260612C00110000"]),
      }),
    );
  });

  it("ungroups an override-backed strategy by deleting its override", async () => {
    const deleteMutate = vi.fn();
    vi.mocked(useDeleteOptionStrategy).mockReturnValue({ mutate: deleteMutate, isPending: false } as never);
    vi.mocked(useOptionStrategies).mockReturnValue({
      data: [
        {
          id: "ov-1",
          accountId: "vl",
          underlying: "ASTS",
          name: "My Spread",
          strategyType: "vertical",
          legs: ["ASTS260612C00100000", "ASTS260612C00110000"],
          mode: "group",
          createdAt: "",
          updatedAt: "",
        },
      ],
    } as never);

    renderTable([VERT_LONG, VERT_SHORT]);
    await userEvent.click(screen.getByText("Ungroup"));
    expect(deleteMutate).toHaveBeenCalledWith("ov-1");
  });
});
```

Add `useUpdateOptionStrategy, useDeleteOptionStrategy` to the imports at the top of the test file (from `@/hooks/use-option-strategies`).

- [ ] **Step 4.2 — Run it (expected FAIL).** Command: `pnpm --filter frontend test -- holdings-table.test`. Expected: FAIL — no Rename/Ungroup menu items, no dialog, no mutation calls.

- [ ] **Step 4.3 — Add edit handlers + dialog state in the component.** In `holdings-table.tsx`, inside `HoldingsTable` (after the `overrides` line from Step 3.4), add the mutations, the rename-dialog state, and the three handlers:

```ts
  const createStrategy = useCreateOptionStrategy();
  const updateStrategy = useUpdateOptionStrategy();
  const deleteStrategy = useDeleteOptionStrategy();

  const [renameTarget, setRenameTarget] = useState<StrategyGroupRow | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const legSymbols = (s: StrategyGroupRow) =>
    s.subRows.map((leg) => leg.instrument?.symbol ?? leg.id);
  const accountOf = (s: StrategyGroupRow) => s.subRows[0]?.accountId ?? "";

  const openRename = (s: StrategyGroupRow) => {
    setRenameTarget(s);
    setRenameValue(s.name);
  };

  const submitRename = () => {
    const s = renameTarget;
    if (!s) return;
    if (s.source === "override" && s.overrideId) {
      updateStrategy.mutate({ id: s.overrideId, payload: { name: renameValue } });
    } else {
      createStrategy.mutate({
        accountId: accountOf(s),
        underlying: s.underlyingKey,
        name: renameValue,
        strategyType: s.strategyType,
        legs: legSymbols(s),
        mode: "group",
      });
    }
    setRenameTarget(null);
  };

  const ungroupStrategy = (s: StrategyGroupRow) => {
    if (s.source === "override" && s.overrideId) {
      deleteStrategy.mutate(s.overrideId);
    } else {
      createStrategy.mutate({
        accountId: accountOf(s),
        underlying: s.underlyingKey,
        name: null,
        strategyType: s.strategyType,
        legs: legSymbols(s),
        mode: "exclude",
      });
    }
  };
```

- [ ] **Step 4.4 — Pass the handlers into `getColumns` and render the dialog.** Change the `columns` prop (line 131) to pass the new handlers:

```ts
        columns={getColumns(
          isBalanceHidden,
          showConvertedValues,
          showTotalReturn,
          onClassify,
          openRename,
          ungroupStrategy,
        )}
```

Wrap the returned JSX so the dialog renders alongside the table. Replace the outer `return ( <div className="flex h-full flex-col"> <DataTable ... /> </div> );` with the same `<div>` plus the dialog after `</DataTable>`/`/>`:

```tsx
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename strategy</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Strategy name"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button onClick={submitRename}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

(Import `Button` is already imported at line 1; `Dialog*`, `Input` were added in Step 3.3.)

- [ ] **Step 4.5 — Update `getColumns` signature + strategy `actions` cell.** Change the `getColumns` signature (lines 201-206) to:

```ts
const getColumns = (
  isHidden: boolean,
  showConvertedValues: boolean,
  showTotalReturn: boolean,
  onClassify?: (holding: Holding) => void,
  onRenameStrategy?: (s: StrategyGroupRow) => void,
  onUngroupStrategy?: (s: StrategyGroupRow) => void,
): ColumnDef<HoldingRow>[] => [
```

Replace the strategy placeholder branch added in Step 3.7 (the `if (isStrategyGroupRow(data)) { return <div ... /> }` in the `actions` cell) with the real three-dot menu:

```ts
      if (isStrategyGroupRow(data)) {
        return (
          <div className="flex items-center justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Icons.MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onRenameStrategy?.(data)}>
                  <Icons.Pencil className="mr-2 h-4 w-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onUngroupStrategy?.(data)}>
                  <Icons.Unlink className="mr-2 h-4 w-4" />
                  Ungroup
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      }
```

> If `Icons.Pencil` / `Icons.Unlink` are absent from the icon set, substitute `Icons.Edit` / `Icons.X` (verify with `grep -nE "Pencil|Unlink|Edit|export" packages/ui/src/components/ui/icons.tsx`). The test stubs all icons, so this only affects the real build.

- [ ] **Step 4.6 — Run it (expected PASS).** Command: `pnpm --filter frontend test -- holdings-table.test`. Expected: PASS — rename (update + create paths), ungroup (exclude + delete paths) all fire the right mutation.

- [ ] **Step 4.7 — Commit.**

```bash
git add apps/frontend/src/pages/holdings/components/holdings-table.tsx apps/frontend/src/pages/holdings/components/holdings-table.test.tsx
git commit -m "feat(holdings): wire strategy rename/ungroup to override mutations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5 — Desktop table: loose-leg selection → "Create strategy"

**Files:**
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table.tsx` (add selection state, a per-leg checkbox in the `symbol` cell when selecting, and a "Create strategy" toolbar button)
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table.test.tsx` (add create-from-selection case)

Lightweight selection: a "Select legs" toolbar toggle reveals a `Checkbox` on each leaf leg row; checked OCC symbols accumulate; a "Create strategy" button creates one `mode='group'` override with the suggested default name. v1 supports a single new group at a time.

- [ ] **Step 5.1 — Write failing test: create strategy from selected legs.** Add to `holdings-table.test.tsx`:

```ts
describe("HoldingsTable create-strategy from selection", () => {
  beforeEach(() => window.localStorage.clear());

  it("creates a group override from checked legs with a suggested default name", async () => {
    const createMutate = vi.fn();
    vi.mocked(useCreateOptionStrategy).mockReturnValue({ mutate: createMutate, isPending: false } as never);
    vi.mocked(useOptionStrategies).mockReturnValue({ data: [] } as never);

    // Two unrelated legs (different expiries+types so plan 2 leaves them loose).
    const A = makeHolding({ id: "a", symbol: "ASTS260612C00100000", mv: 10 });
    const B = makeHolding({ id: "b", symbol: "ASTS260920P00050000", mv: 20 });
    renderTable([A, B]);

    await userEvent.click(screen.getByText("Select legs"));
    const checkboxes = screen.getAllByRole("checkbox");
    await userEvent.click(checkboxes[0]);
    await userEvent.click(checkboxes[1]);
    await userEvent.click(screen.getByText(/Create strategy/i));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        underlying: "ASTS",
        mode: "group",
        strategyType: "custom",
        legs: expect.arrayContaining(["ASTS260612C00100000", "ASTS260920P00050000"]),
      }),
    );
  });
});
```

- [ ] **Step 5.2 — Run it (expected FAIL).** Command: `pnpm --filter frontend test -- holdings-table.test`. Expected: FAIL — no "Select legs" entry, no per-leg checkbox, no "Create strategy" button.

- [ ] **Step 5.3 — Add selection state + handlers in the component.** In `HoldingsTable` (after the rename state from Step 4.3), add:

```ts
  const [selecting, setSelecting] = useState(false);
  const [selectedLegs, setSelectedLegs] = useState<Record<string, Holding>>({});

  const toggleLeg = (leg: Holding, checked: boolean) =>
    setSelectedLegs((prev) => {
      const next = { ...prev };
      const sym = leg.instrument?.symbol ?? leg.id;
      if (checked) next[sym] = leg;
      else delete next[sym];
      return next;
    });

  const createFromSelection = () => {
    const legs = Object.values(selectedLegs);
    if (legs.length < 2) return;
    const underlying = getUnderlyingKey(legs[0]);
    createStrategy.mutate({
      accountId: legs[0].accountId,
      underlying,
      name: defaultStrategyLabel("custom"),
      strategyType: "custom",
      legs: legs.map((l) => l.instrument?.symbol ?? l.id),
      mode: "group",
    });
    setSelectedLegs({});
    setSelecting(false);
  };
```

Add `getUnderlyingKey` to the `../utils/group-by-underlying` import (it is exported there at line 29).

- [ ] **Step 5.4 — Add the "Select legs" / "Create strategy" toolbar controls.** Inside `toolbarActions`, after the strategy toggle (Step 3.6), add:

```ts
            {groupByUnderlying && groupByStrategy && (
              <AnimatedToggleGroup
                value={selecting ? "select" : "off"}
                onValueChange={(value) => setSelecting(value === "select")}
                items={[
                  { value: "off", label: "View" },
                  { value: "select", label: "Select legs" },
                ]}
                size="xs"
                rounded="md"
              />
            )}
            {selecting && Object.keys(selectedLegs).length >= 2 && (
              <Button size="sm" onClick={createFromSelection}>
                Create strategy ({Object.keys(selectedLegs).length})
              </Button>
            )}
```

- [ ] **Step 5.5 — Render the checkbox on leaf rows when selecting.** Pass `selecting` + `selectedLegs` + `toggleLeg` into `getColumns` (extend the arg list) and render a `Checkbox` at the start of the leaf branch of the `symbol` cell (the `const holding = data;` block, around line 248). Update the `getColumns` call:

```ts
        columns={getColumns(
          isBalanceHidden,
          showConvertedValues,
          showTotalReturn,
          onClassify,
          openRename,
          ungroupStrategy,
          selecting,
          selectedLegs,
          toggleLeg,
        )}
```

Extend the `getColumns` signature:

```ts
const getColumns = (
  isHidden: boolean,
  showConvertedValues: boolean,
  showTotalReturn: boolean,
  onClassify?: (holding: Holding) => void,
  onRenameStrategy?: (s: StrategyGroupRow) => void,
  onUngroupStrategy?: (s: StrategyGroupRow) => void,
  selecting?: boolean,
  selectedLegs?: Record<string, Holding>,
  onToggleLeg?: (leg: Holding, checked: boolean) => void,
): ColumnDef<HoldingRow>[] => [
```

In the `symbol` cell leaf branch, replace the opening of the returned `<div ... onClick={handleNavigate}>` with a wrapper that shows the checkbox when selecting (insert just inside, before `<div className="flex items-center">`):

```tsx
          {selecting && (
            <span
              className="mr-2 inline-flex"
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={!!selectedLegs?.[holding.instrument?.symbol ?? holding.id]}
                onCheckedChange={(v) => onToggleLeg?.(holding, v === true)}
              />
            </span>
          )}
```

Place the `<span>` as a sibling of `<div className="flex items-center">` by wrapping both in a `<div className="flex items-center">` — i.e. change the leaf return to:

```tsx
      return (
        <div
          className="-m-1 flex cursor-pointer items-center p-1"
          style={{ paddingLeft: row.depth > 0 ? `${row.depth * 1.5 + 0.25}rem` : undefined }}
          onClick={handleNavigate}
        >
          {selecting && (
            <span className="mr-2 inline-flex" onClick={(e) => e.stopPropagation()}>
              <Checkbox
                checked={!!selectedLegs?.[holding.instrument?.symbol ?? holding.id]}
                onCheckedChange={(v) => onToggleLeg?.(holding, v === true)}
              />
            </span>
          )}
          <TickerAvatar
            symbol={parsedOption ? parsedOption.underlying : symbol}
            className="mr-2 h-8 w-8"
          />
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="font-medium">{displaySymbol}</span>
              {isManual && (
                <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px]">
                  Manual
                </Badge>
              )}
            </div>
            <span className="text-muted-foreground line-clamp-1 text-xs">
              {optionSubtitle ?? holding.instrument?.name ?? null}
            </span>
          </div>
        </div>
      );
```

- [ ] **Step 5.6 — Run it (expected PASS).** Command: `pnpm --filter frontend test -- holdings-table.test`. Expected: PASS — checking two legs then "Create strategy" fires a `mode:'group'`, `strategyType:'custom'` create with both OCC symbols.

- [ ] **Step 5.7 — Commit.**

```bash
git add apps/frontend/src/pages/holdings/components/holdings-table.tsx apps/frontend/src/pages/holdings/components/holdings-table.test.tsx
git commit -m "feat(holdings): create custom strategy from selected legs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6 — Mobile cards: read-only nested strategy layer + sheet toggle

**Files:**
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table-mobile.tsx` (imports 1-15; state 68-75; `rows` memo 124-145; group render 256-315)
- Modify: `apps/frontend/src/pages/holdings/components/holdings-mobile-filter-sheet.tsx` (props 16-35, 37-56; render block after the Grouping toggle, ~line 86)
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table-mobile.test.tsx` (add nested-strategy case)

Per spec 8.2, mobile is **read-only**: render strategy name + combo P&L + legs; no edit operations.

- [ ] **Step 6.1 — Write failing test: nested strategy block on mobile.** Extend `holdings-table-mobile.test.tsx`. First extend the `@wealthfolio/ui` mock to add `usePersistentState` already exists; add nothing new there. Add the strategy-render case:

```ts
const VERT_LONG = makeHolding({ id: "vl", symbol: "ASTS260612C00100000", mv: 250 });
const VERT_SHORT = (() => {
  const h = makeHolding({ id: "vs", symbol: "ASTS260612C00110000", mv: -80 });
  return { ...h, quantity: -1 } as Holding;
})();

describe("HoldingsTableMobile strategy sub-grouping", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows a strategy sub-card with name and legs when expanded", async () => {
    renderMobile([VERT_LONG, VERT_SHORT]);
    // Expand the underlying group, then the strategy.
    await userEvent.click(screen.getByText(labelMatcher("ASTS")));
    expect(screen.getByText(/Spread/i)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/Spread/i));
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
  });

  it("flattens legs when strategy sub-grouping is disabled (persisted)", () => {
    window.localStorage.setItem("holdings-mobile:group-by-strategy", "false");
    renderMobile([VERT_LONG, VERT_SHORT]);
    // No strategy label; legs hidden until underlying expanded (collapsed default).
    expect(screen.queryByText(/Spread/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6.2 — Run it (expected FAIL).** Command: `pnpm --filter frontend test -- holdings-table-mobile.test`. Expected: FAIL — `groupHoldingsByUnderlying` called without options, no strategy layer.

- [ ] **Step 6.3 — Add imports + state to the mobile table.** In `holdings-table-mobile.tsx`, extend the `group-by-underlying` import (line 14) and add the detect-strategies + hook imports:

```ts
import {
  detectStrategies,
  isStrategyGroupRow,
  type StrategyGroupRow,
} from "../utils/detect-strategies";
import { useOptionStrategies } from "@/hooks/use-option-strategies";
```

After `groupByUnderlying` state (line 71), add:

```ts
  const [groupByStrategy, setGroupByStrategy] = usePersistentState<boolean>(
    "holdings-mobile:group-by-strategy",
    true,
  );
  const [expandedStrategies, setExpandedStrategies] = usePersistentState<string[]>(
    "holdings-mobile:expanded-strategies",
    [],
  );
  const toggleStrategy = (id: string) =>
    setExpandedStrategies((prev) =>
      prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id],
    );
  const { data: overrides = [] } = useOptionStrategies();
```

- [ ] **Step 6.4 — Pass options into the `rows` memo grouping call.** In the `rows` memo (lines 124-145), change `groupHoldingsByUnderlying(filteredHoldings)` (line 126) to `groupHoldingsByUnderlying(filteredHoldings, { groupByStrategy, overrides })`, and remove/relax the leg-sort at lines 137-143 (it casts `subRows` to leaves; strategy rows lack `instrument`). Replace lines 137-143 with a guarded sort:

```ts
    for (const r of sorted) {
      if (isHoldingGroupRow(r)) {
        r.subRows.sort((x, y) => {
          const sx = isStrategyGroupRow(x) ? x.name : x.instrument?.symbol ?? x.id;
          const sy = isStrategyGroupRow(y) ? y.name : y.instrument?.symbol ?? y.id;
          return sx.localeCompare(sy);
        });
      }
    }
```

Add `groupByStrategy, overrides` to the memo dependency array (line 145): `}, [filteredHoldings, groupByUnderlying, sortBy, groupByStrategy, overrides]);`.

- [ ] **Step 6.5 — Render strategy sub-cards in the group's expanded block.** Replace the expanded leg block (lines 309-313) with one that renders a strategy sub-card (`ml-4 border-l pl-2`) and recurses into its legs, or a leaf card otherwise:

```tsx
                  {expanded && (
                    <div className="ml-4 space-y-2 border-l pl-2">
                      {row.subRows.map((sub) =>
                        isStrategyGroupRow(sub)
                          ? renderStrategyCard(sub)
                          : renderLeafCard(sub),
                      )}
                    </div>
                  )}
```

Add a `renderStrategyCard` helper next to `renderLeafCard` (before the `if (isLoading)` block, ~line 213):

```tsx
  const renderStrategyCard = (strategy: StrategyGroupRow) => {
    const expanded = expandedStrategies.includes(strategy.id);
    return (
      <div key={strategy.id} className="space-y-2">
        <Card
          className="hover:bg-muted/50 cursor-pointer p-3 transition-colors"
          onClick={() => toggleStrategy(strategy.id)}
        >
          <div className="flex items-center justify-between">
            <div className="flex flex-1 items-center gap-2 overflow-hidden">
              <Icons.ChevronRight
                className={cn("h-4 w-4 shrink-0 transition-transform", expanded && "rotate-90")}
              />
              <div className="flex-1 overflow-hidden">
                <div className="flex items-center gap-1.5">
                  <p className="truncate font-semibold">{strategy.name}</p>
                  <Badge variant="secondary">{strategy.memberCount}</Badge>
                </div>
                <p className="text-muted-foreground truncate text-sm">
                  {strategy.netCashBase >= 0
                    ? `Net debit ${strategy.baseCurrency} ${Math.abs(strategy.netCashBase).toFixed(2)}`
                    : `Net credit ${strategy.baseCurrency} ${Math.abs(strategy.netCashBase).toFixed(2)}`}
                </p>
              </div>
            </div>
            <div className="ml-2 text-right">
              <AmountDisplay
                value={strategy.marketValueBase}
                currency={strategy.baseCurrency}
                isHidden={isBalanceHidden}
                className="font-medium"
              />
              <div className="flex items-center justify-end gap-1">
                <AmountDisplay
                  value={showTotalReturn ? strategy.totalGainBase : strategy.dayChangeBase}
                  currency={strategy.baseCurrency}
                  isHidden={isBalanceHidden}
                  colorFormat
                  className="text-xs"
                />
                <Separator orientation="vertical" className="mx-1 h-4" />
                <GainPercent
                  value={(showTotalReturn ? strategy.totalGainPct : strategy.dayChangePct) ?? 0}
                  className="text-xs"
                />
              </div>
            </div>
          </div>
        </Card>
        {expanded && (
          <div className="ml-4 space-y-2 border-l pl-2">
            {strategy.subRows.map((leg) => renderLeafCard(leg))}
          </div>
        )}
      </div>
    );
  };
```

- [ ] **Step 6.6 — Add the sub-grouping toggle to the filter sheet + pass it through.** In `holdings-mobile-filter-sheet.tsx`, add two props to the interface (after `setGroupByUnderlying`, line 31):

```ts
  groupByStrategy?: boolean;
  setGroupByStrategy?: (value: boolean) => void;
```

Add them to the destructured params (after line 52): `groupByStrategy = true, setGroupByStrategy,`. After the Grouping `AnimatedToggleGroup` block (closing `</div>` at line 86), add a nested toggle, only when both setters are present:

```tsx
              {setGroupByStrategy && (
                <div className="space-y-3">
                  <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                    Strategy sub-grouping
                  </h4>
                  <AnimatedToggleGroup
                    value={groupByStrategy ? "strategy" : "legs"}
                    onValueChange={(value) => setGroupByStrategy(value === "strategy")}
                    items={[
                      { value: "strategy", label: "Strategy" },
                      { value: "legs", label: "Legs" },
                    ]}
                    size="sm"
                    className="inline-flex w-auto"
                  />
                </div>
              )}
```

In `holdings-table-mobile.tsx`, pass the new props to `<HoldingsMobileFilterSheet .../>` (after `setGroupByUnderlying={setGroupByUnderlying}`, line 347):

```ts
        groupByStrategy={groupByStrategy}
        setGroupByStrategy={setGroupByStrategy}
```

- [ ] **Step 6.7 — Mock `use-option-strategies` in the mobile test.** Add at the top of `holdings-table-mobile.test.tsx` (after the existing `vi.mock` calls):

```ts
vi.mock("@/hooks/use-option-strategies", () => ({
  useOptionStrategies: () => ({ data: [] }),
}));
```

- [ ] **Step 6.8 — Run it (expected PASS).** Command: `pnpm --filter frontend test -- holdings-table-mobile.test`. Expected: PASS — strategy card appears under the expanded underlying; toggling off flattens.

- [ ] **Step 6.9 — Commit.**

```bash
git add apps/frontend/src/pages/holdings/components/holdings-table-mobile.tsx apps/frontend/src/pages/holdings/components/holdings-mobile-filter-sheet.tsx apps/frontend/src/pages/holdings/components/holdings-table-mobile.test.tsx
git commit -m "feat(holdings): read-only nested strategy layer in mobile cards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7 — Dashboard widget: read-only nested strategy layer + Popover toggle

**Files:**
- Modify: `apps/frontend/src/pages/dashboard/top-holdings.tsx` (imports 7-26; state 287-298; `sortedHoldings` memo 303-330; Popover options 369-417; group render 478-524)
- Create: `apps/frontend/src/pages/dashboard/top-holdings.test.tsx` (new component test)

Per spec 8.2, dashboard is **read-only**. The widget already renders one expandable level; add the strategy layer inside the expanded group block and a "Strategy sub-grouping" item in the Popover.

- [ ] **Step 7.1 — Write failing test for the dashboard nested strategy layer.** Create `apps/frontend/src/pages/dashboard/top-holdings.test.tsx`:

```ts
import type { Holding } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopHoldings } from "./top-holdings";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/components/ticker-avatar", () => ({
  TickerAvatar: ({ symbol }: { symbol: string }) => <span>{symbol}</span>,
}));
vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/use-option-strategies", () => ({
  useOptionStrategies: () => ({ data: [] }),
}));
vi.mock("@wealthfolio/ui", () => ({
  AmountDisplay: ({ value }: { value: number }) => <span>{value}</span>,
  GainAmount: ({ value }: { value: number }) => <span>{value}</span>,
  GainPercent: ({ value }: { value: number }) => <span>{value}</span>,
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  Icons: new Proxy({}, { get: () => () => <span /> }),
  usePersistentState: <T,>(key: string, initial: T) => {
    const [v, setV] = useState<T>(() => {
      const s = window.localStorage.getItem(key);
      return s != null ? (JSON.parse(s) as T) : initial;
    });
    const set = (n: T | ((p: T) => T)) =>
      setV((p) => {
        const r = typeof n === "function" ? (n as (p: T) => T)(p) : n;
        window.localStorage.setItem(key, JSON.stringify(r));
        return r;
      });
    return [v, set] as const;
  },
}));
vi.mock("@wealthfolio/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@wealthfolio/ui/components/ui/skeleton", () => ({
  Skeleton: () => <span />,
}));

function makeHolding(p: { id: string; symbol: string; qty?: number; mv?: number }): Holding {
  return {
    id: p.id,
    accountId: "acc-1",
    holdingType: "SECURITY",
    instrument: { id: p.id, symbol: p.symbol, name: p.symbol, currency: "USD", quoteMode: "LIVE" },
    quantity: p.qty ?? 1,
    price: 1,
    contractMultiplier: 100,
    localCurrency: "USD",
    baseCurrency: "USD",
    fxRate: 1,
    marketValue: { local: p.mv ?? 0, base: p.mv ?? 0 },
    costBasis: { local: 0, base: 0 },
    totalGain: { local: 0, base: 0 },
    dayChange: { local: 0, base: 0 },
    prevCloseValue: { local: 0, base: 0 },
    weight: 0,
  } as unknown as Holding;
}

const VERT_LONG = makeHolding({ id: "vl", symbol: "ASTS260612C00100000", qty: 1, mv: 250 });
const VERT_SHORT = makeHolding({ id: "vs", symbol: "ASTS260612C00110000", qty: -1, mv: -80 });

describe("TopHoldings strategy layer", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders a strategy sub-row under an expanded underlying group", async () => {
    render(
      <MemoryRouter>
        <TopHoldings holdings={[VERT_LONG, VERT_SHORT]} isLoading={false} baseCurrency="USD" />
      </MemoryRouter>,
    );
    // Expand the underlying group, revealing the strategy sub-row.
    await userEvent.click(screen.getByText("ASTS"));
    expect(screen.getByText(/Spread/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7.2 — Run it (expected FAIL).** Command: `pnpm --filter frontend test -- top-holdings`. Expected: FAIL — grouping passes no options; the expanded block renders only `HoldingRow` leaves.

- [ ] **Step 7.3 — Add imports + state to the widget.** In `top-holdings.tsx`, extend the `group-by-underlying` import (lines 7-12) and add detect-strategies + hook:

```ts
import {
  detectStrategies,
  isStrategyGroupRow,
  type StrategyGroupRow,
} from "@/pages/holdings/utils/detect-strategies";
import { useOptionStrategies } from "@/hooks/use-option-strategies";
```

After `groupByUnderlying` state (line 290), add:

```ts
  const [groupByStrategy, setGroupByStrategy] = usePersistentState<boolean>(
    "dashboard-holdings-widget-group-by-strategy",
    true,
  );
  const [expandedStrategies, setExpandedStrategies] = usePersistentState<string[]>(
    "dashboard-holdings-widget-expanded-strategies",
    [],
  );
  const toggleStrategy = (id: string) =>
    setExpandedStrategies((prev) =>
      prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id],
    );
  const { data: overrides = [] } = useOptionStrategies();
```

- [ ] **Step 7.4 — Pass options into the grouping call.** In the `sortedHoldings` memo, change `groupHoldingsByUnderlying(filtered)` (line 313) to `groupHoldingsByUnderlying(filtered, { groupByStrategy, overrides })`, and add `groupByStrategy, overrides` to the dependency array (line 330): `}, [holdings, sortBy, showTotalReturn, groupByUnderlying, groupByStrategy, overrides]);`.

- [ ] **Step 7.5 — Render the strategy sub-row inside the expanded group block.** Replace the expanded `item.subRows.map(...)` block (lines 492-508) with one that renders a `StrategyHoldingRow` for strategy rows and the existing `HoldingRow` for leaves:

```tsx
              {expanded && (
                <div className="border-border ml-3 border-l pl-3">
                  {item.subRows.map((sub) =>
                    isStrategyGroupRow(sub) ? (
                      <StrategyHoldingRow
                        key={sub.id}
                        strategy={sub}
                        baseCurrency={baseCurrency}
                        isHidden={isBalanceHidden}
                        showTotalReturn={showTotalReturn}
                        expanded={expandedStrategies.includes(sub.id)}
                        onToggle={() => toggleStrategy(sub.id)}
                        onLegClick={(leg) =>
                          navigate(`/holdings/${encodeURIComponent(leg.instrument?.id ?? leg.id)}`)
                        }
                        showName={displayMode === "name"}
                      />
                    ) : (
                      <HoldingRow
                        key={sub.id}
                        holding={sub}
                        baseCurrency={baseCurrency}
                        isHidden={isBalanceHidden}
                        showTotalReturn={showTotalReturn}
                        showName={displayMode === "name"}
                        onClick={() =>
                          navigate(`/holdings/${encodeURIComponent(sub.instrument?.id ?? sub.id)}`)
                        }
                      />
                    ),
                  )}
                </div>
              )}
```

Add a `StrategyHoldingRow` component above `TopHoldings` (after `GroupHoldingRow`, ~line 180):

```tsx
interface StrategyHoldingRowProps {
  strategy: StrategyGroupRow;
  baseCurrency: string;
  isHidden?: boolean;
  showTotalReturn: boolean;
  expanded: boolean;
  showName: boolean;
  onToggle: () => void;
  onLegClick: (leg: Holding) => void;
}

function StrategyHoldingRow({
  strategy,
  baseCurrency,
  isHidden,
  showTotalReturn,
  expanded,
  showName,
  onToggle,
  onLegClick,
}: StrategyHoldingRowProps) {
  const gainAmount = showTotalReturn ? strategy.totalGainBase : strategy.dayChangeBase;
  const gainPercent = showTotalReturn ? (strategy.totalGainPct ?? 0) : (strategy.dayChangePct ?? 0);
  return (
    <div>
      <div
        className="border-border hover:bg-muted/30 group flex cursor-pointer items-center justify-between gap-3 border-b py-3 transition-colors last:border-0"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onToggle()}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Icons.ChevronRight
            className={cn(
              "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{strategy.name}</span>
            <span className="text-muted-foreground text-xs">
              {strategy.netCashBase >= 0
                ? `Net debit ${Math.abs(strategy.netCashBase).toFixed(2)}`
                : `Net credit ${Math.abs(strategy.netCashBase).toFixed(2)}`}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <AmountDisplay
            value={strategy.marketValueBase}
            currency={baseCurrency}
            isHidden={isHidden}
            className="text-sm font-semibold"
          />
          <div className="flex items-center gap-2">
            <GainAmount value={gainAmount} currency={baseCurrency} displayCurrency={false} className="text-xs" />
            <GainPercent value={gainPercent} variant="badge" className="min-w-[60px] justify-center text-xs" />
          </div>
        </div>
      </div>
      {expanded && (
        <div className="border-border ml-3 border-l pl-3">
          {strategy.subRows.map((leg) => (
            <HoldingRow
              key={leg.id}
              holding={leg}
              baseCurrency={baseCurrency}
              isHidden={isHidden}
              showTotalReturn={showTotalReturn}
              showName={showName}
              onClick={() => onLegClick(leg)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7.6 — Add the "Strategy sub-grouping" option to the Popover.** After the Grouping option block (the `[true, false].map(...)` ending at line 392, followed by the divider at line 393), insert a parallel block:

```tsx
              <div className="bg-border/70 mx-2 my-1.5 h-px" />
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Strategy sub-grouping
              </p>
              {([true, false] as const).map((v) => (
                <button
                  key={`strat-${String(v)}`}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setGroupByStrategy(v)}
                >
                  {v ? "Strategy" : "Legs"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      groupByStrategy === v ? "border-primary bg-primary" : "border-muted-foreground",
                    )}
                  >
                    {groupByStrategy === v && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
```

- [ ] **Step 7.7 — Run it (expected PASS).** Command: `pnpm --filter frontend test -- top-holdings`. Expected: PASS — expanding the ASTS group reveals the strategy sub-row labelled `/Spread/`.

- [ ] **Step 7.8 — Commit.**

```bash
git add apps/frontend/src/pages/dashboard/top-holdings.tsx apps/frontend/src/pages/dashboard/top-holdings.test.tsx
git commit -m "feat(dashboard): read-only nested strategy layer in top-holdings widget

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8 — Full verification: tests + type-check + lint

**Files:** none (verification only).

- [ ] **Step 8.1 — Run the full frontend test suite.** Command: `pnpm --filter frontend test`. Expected: PASS — all suites green, including the four touched in this plan (`group-by-underlying`, `data-table-expansion`, `holdings-table`, `holdings-table-mobile`, `top-holdings`). If a test from plan 1/2 fails, the contracts diverged — reconcile against the spec, do not patch around it.

- [ ] **Step 8.2 — Type-check.** Command: `pnpm type-check`. Expected: PASS — no type errors. Common culprit: a `subRows` element treated as `Holding` without the `isStrategyGroupRow` narrow; fix the missing guard.

- [ ] **Step 8.3 — Lint.** Command: `pnpm lint`. Expected: PASS — no lint errors. Fix unused imports introduced while editing (e.g. `detectStrategies` imported but only used transitively — remove if unused).

- [ ] **Step 8.4 — Final commit (only if 8.1-8.3 required fixes).**

```bash
git add -A
git commit -m "chore(holdings): satisfy type-check and lint for strategy UI integration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes / cross-plan consistency

- `groupHoldingsByUnderlying` gains an **optional** second arg `GroupOptions`; all existing P1 callers (none of which pass it) keep flat P1 behaviour, so plan-2 unit tests for the 1-arg form stay green.
- The desktop `getColumns` accretes optional callback args (`onRenameStrategy`, `onUngroupStrategy`, `selecting`, `selectedLegs`, `onToggleLeg`) so the dialog + selection state live in the component where mutations are in scope. This avoids converting `getColumns` to a hook.
- Strategy `id` and `legKey` come from plan 2 (`strategy:${underlyingKey}:${legKey}`); this plan only reads `strategy.id` for expansion state and never constructs it.
- `accountId` for create/exclude overrides is taken from the first leg (`s.subRows[0].accountId` / `legs[0].accountId`) — strategies are single-account per spec section 9.
- Rename of an **auto** strategy creates a `mode:'group'` override (spec section 6); rename of an **override**-backed strategy updates it. Ungroup of an **auto** strategy creates a `mode:'exclude'` override; ungroup of an **override**-backed one deletes it.
- "Create strategy" always uses `strategyType:'custom'` and `defaultStrategyLabel('custom')` for the suggested name (spec: user-built groups are custom; name editable later via Rename).
- Mobile + dashboard are strictly read-only in v1 (spec section 8.2): they import only `useOptionStrategies` (read) plus `detectStrategies`/`isStrategyGroupRow`, never the mutation hooks.
