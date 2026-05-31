# Holdings 按标的归组(P1)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在自托管 Web 版持仓页(Investments 表),把同一标的的正股 + 期权腿折叠进一个可展开的父行,展示合计市值/成本/盈亏;提供「按标的归组」开关(默认开),纯前端实现。

**Architecture:** ① 加法式扩展共享 `DataTable`,使其支持可选子行/展开(不传 `getSubRows` 时零行为变化);② 新增纯函数 `group-by-underlying.ts` 把 `Holding[]` 归组为 `HoldingRow[]`(分组行带 `subRows` + base 货币合计);③ `holdings-table.tsx` 加开关、按需归组、列定义按行类型分支并传 `getSubRows`。排序交给 TanStack(默认 symbol 升序,因 OCC 前缀性质天然得到「正股在前→到期→行权价」)。

**Tech Stack:** React 18 + TypeScript、@tanstack/react-table v8、`@wealthfolio/ui`(shadcn/Radix)、Vitest + @testing-library/react(jsdom)、`usePersistentState`(localStorage)。

参考设计:`docs/superpowers/specs/2026-05-31-holdings-underlying-grouping-design.md`

测试命令(全仓):`pnpm --filter frontend test`(等价 `pnpm test`);类型检查 `pnpm type-check`;lint `pnpm lint`。

---

## Task 1: 给共享 DataTable 加可选子行/展开支持

**Files:**
- Modify: `packages/ui/src/components/ui/data-table/index.tsx`
- Test: `apps/frontend/src/pages/holdings/components/data-table-expansion.test.tsx`

加法式改造:新增可选 props `getSubRows`、`defaultExpanded`、`filterFromLeafRows`,内部加 `getExpandedRowModel` 与 `expanded` 状态。**不传 `getSubRows` 时行为与现状完全一致。**

- [ ] **Step 1: 写失败测试**

新建 `apps/frontend/src/pages/holdings/components/data-table-expansion.test.tsx`:

```tsx
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

interface Row {
  name: string;
  subRows?: Row[];
}

const columns: ColumnDef<Row>[] = [
  {
    id: "name",
    header: () => <span>Name</span>,
    cell: ({ row }) => (
      <button
        type="button"
        data-testid={`row-${row.original.name}`}
        onClick={row.getToggleExpandedHandler()}
        disabled={!row.getCanExpand()}
      >
        {row.original.name}
      </button>
    ),
  },
];

describe("DataTable opt-in sub-rows", () => {
  it("hides children until parent expanded, then shows them", async () => {
    const data: Row[] = [{ name: "Parent", subRows: [{ name: "Child" }] }];
    render(
      <DataTable
        data={data}
        columns={columns}
        getSubRows={(row) => row.subRows}
        defaultExpanded={{}}
      />,
    );

    expect(screen.getByText("Parent")).toBeInTheDocument();
    expect(screen.queryByText("Child")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("row-Parent"));
    expect(screen.getByText("Child")).toBeInTheDocument();
  });

  it("expands all when defaultExpanded is true", () => {
    const data: Row[] = [{ name: "Parent", subRows: [{ name: "Child" }] }];
    render(
      <DataTable data={data} columns={columns} getSubRows={(row) => row.subRows} defaultExpanded={true} />,
    );
    expect(screen.getByText("Child")).toBeInTheDocument();
  });

  it("renders flat (no expansion) when getSubRows not provided", () => {
    const data: Row[] = [{ name: "A" }, { name: "B" }];
    render(<DataTable data={data} columns={columns} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter frontend test -- data-table-expansion`
Expected: FAIL —— `getSubRows`/`defaultExpanded` 不是 DataTable 的 prop(TS 报错或子行不渲染)。

- [ ] **Step 3: 改 DataTable 的 import**

在 `packages/ui/src/components/ui/data-table/index.tsx` 顶部 import 中加入 `ExpandedState` 与 `getExpandedRowModel`:

```ts
import {
  ColumnDef,
  ColumnFiltersState,
  ExpandedState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
```

- [ ] **Step 4: 给 props 接口加 3 个可选字段**

在 `interface DataTableProps<TData, TValue>` 内追加:

```ts
  getSubRows?: (originalRow: TData, index: number) => TData[] | undefined;
  defaultExpanded?: ExpandedState;
  filterFromLeafRows?: boolean;
```

- [ ] **Step 5: 解构新 props**

在 `export function DataTable<TData, TValue>({ ... })` 的解构参数里追加:

```ts
  getSubRows,
  defaultExpanded,
  filterFromLeafRows = false,
```

- [ ] **Step 6: 加 expanded 状态(沿用现有 usePersistentState 模式)**

在 `const [sorting, setSorting] = ...` 之后新增(与现有条件式 hook 写法一致):

```ts
  const [expanded, setExpanded] = storageKey
    ? usePersistentState<ExpandedState>(`${storageKey}:expanded`, defaultExpanded ?? {})
    : React.useState<ExpandedState>(defaultExpanded ?? {});
```

- [ ] **Step 7: 把新选项接到 useReactTable**

在 `useReactTable({ ... })` 配置中:
1. 顶层加 `getSubRows,` 和 `filterFromLeafRows,`
2. `state` 对象内加 `expanded,`
3. 回调区加 `onExpandedChange: setExpanded,`
4. row model 区加 `getExpandedRowModel: getExpandedRowModel(),`

改后关键片段:

```ts
  const table = useReactTable({
    data,
    columns,
    manualPagination: true,
    getSubRows,
    filterFromLeafRows,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      expanded,
      pagination: manualPagination
        ? undefined
        : {
            pageSize: 500,
            pageIndex: 0,
          },
    },

    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });
```

渲染循环(`table.getRowModel().rows.map(...)`)无需改动:展开的子行会自动出现在该列表中。

- [ ] **Step 8: 运行测试,确认通过**

Run: `pnpm --filter frontend test -- data-table-expansion`
Expected: PASS（3 个用例全过)。

- [ ] **Step 9: 类型检查 + lint**

Run: `pnpm type-check && pnpm lint`
Expected: 通过(无新错误)。

- [ ] **Step 10: 提交**

```bash
git add packages/ui/src/components/ui/data-table/index.tsx apps/frontend/src/pages/holdings/components/data-table-expansion.test.tsx
git commit -m "feat(ui): add opt-in sub-row expansion to DataTable"
```

---

## Task 2: 归组纯函数 group-by-underlying

**Files:**
- Create: `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts`
- Test: `apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Holding } from "@/lib/types";
import {
  getUnderlyingKey,
  groupHoldingsByUnderlying,
  isHoldingGroupRow,
  type HoldingGroupRow,
} from "./group-by-underlying";

// 最小 Holding 工厂(只填测试用到的字段,其余以 as Holding 跳过)
function makeHolding(p: {
  id: string;
  symbol: string;
  name?: string;
  price?: number;
  mv?: number; // marketValue.base
  cost?: number; // costBasis.base
  gain?: number; // totalGain.base
  day?: number; // dayChange.base
  prevClose?: number; // prevCloseValue.base
  weight?: number;
}): Holding {
  return {
    id: p.id,
    instrument: { id: p.id, symbol: p.symbol, name: p.name ?? p.symbol, currency: "USD", quoteMode: "LIVE" },
    quantity: 1,
    price: p.price ?? null,
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

const OCC_CALL = "ASTS260612C00110000"; // ASTS 2026-06-12 Call 110
const OCC_CALL2 = "ASTS260618C00100000"; // ASTS 2026-06-18 Call 100

describe("getUnderlyingKey", () => {
  it("returns underlying for an OCC option symbol", () => {
    expect(getUnderlyingKey(makeHolding({ id: "1", symbol: OCC_CALL }))).toBe("ASTS");
  });
  it("returns the symbol itself for a stock", () => {
    expect(getUnderlyingKey(makeHolding({ id: "2", symbol: "TSLA" }))).toBe("TSLA");
  });
});

describe("groupHoldingsByUnderlying", () => {
  it("keeps a single-member underlying flat (not a group)", () => {
    const rows = groupHoldingsByUnderlying([makeHolding({ id: "1", symbol: "TSLA" })]);
    expect(rows).toHaveLength(1);
    expect(isHoldingGroupRow(rows[0])).toBe(false);
  });

  it("groups a stock + its option legs into one group row with aggregates", () => {
    const rows = groupHoldingsByUnderlying([
      makeHolding({ id: "s", symbol: "ASTS", name: "AST SpaceMobile", price: 113.41, mv: 113.41, cost: 123, gain: -9.59, day: 1, prevClose: 112.41, weight: 0.1 }),
      makeHolding({ id: "c1", symbol: OCC_CALL, mv: -1264.56, cost: 313, gain: -300, day: 2, prevClose: -1266.56, weight: -0.3 }),
      makeHolding({ id: "c2", symbol: OCC_CALL2, mv: 2028.15, cost: 578, gain: 1450, day: 3, prevClose: 2025.15, weight: 0.5 }),
    ]);

    expect(rows).toHaveLength(1);
    const group = rows[0] as HoldingGroupRow;
    expect(isHoldingGroupRow(group)).toBe(true);
    expect(group.underlyingSymbol).toBe("ASTS");
    expect(group.underlyingName).toBe("AST SpaceMobile");
    expect(group.memberCount).toBe(3);
    expect(group.underlyingPrice).toBe(113.41);
    expect(group.subRows).toHaveLength(3);
    // 合计(含空头负腿净额)
    expect(group.marketValueBase).toBeCloseTo(113.41 - 1264.56 + 2028.15, 2);
    expect(group.costBasisBase).toBeCloseTo(123 + 313 + 578, 2);
    expect(group.totalGainBase).toBeCloseTo(-9.59 - 300 + 1450, 2);
    expect(group.dayChangeBase).toBeCloseTo(1 + 2 + 3, 2);
    expect(group.weight).toBeCloseTo(0.1 - 0.3 + 0.5, 4);
    // 百分比
    expect(group.totalGainPct).toBeCloseTo(group.totalGainBase / Math.abs(group.costBasisBase), 6);
    expect(group.dayChangePct).toBeCloseTo(group.dayChangeBase / Math.abs(-1266.56 + 2025.15 + 112.41), 6);
  });

  it("returns null pct when cost basis or prevClose sum is zero", () => {
    const rows = groupHoldingsByUnderlying([
      makeHolding({ id: "c1", symbol: OCC_CALL, mv: 10, cost: 0, gain: 10, day: 1, prevClose: 0 }),
      makeHolding({ id: "c2", symbol: OCC_CALL2, mv: 20, cost: 0, gain: 20, day: 2, prevClose: 0 }),
    ]);
    const group = rows[0] as HoldingGroupRow;
    expect(group.totalGainPct).toBeNull();
    expect(group.dayChangePct).toBeNull();
  });

  it("group with only option legs has null underlyingPrice and name", () => {
    const rows = groupHoldingsByUnderlying([
      makeHolding({ id: "c1", symbol: OCC_CALL, mv: 10 }),
      makeHolding({ id: "c2", symbol: OCC_CALL2, mv: 20 }),
    ]);
    const group = rows[0] as HoldingGroupRow;
    expect(group.underlyingPrice).toBeNull();
    expect(group.underlyingName).toBeNull();
  });

  it("preserves first-seen order and mixes groups with standalone holdings", () => {
    const rows = groupHoldingsByUnderlying([
      makeHolding({ id: "a", symbol: "AAPL", mv: 100 }),
      makeHolding({ id: "ac", symbol: "AAPL260618C00100000", mv: 50 }),
      makeHolding({ id: "t", symbol: "TSLA", mv: 200 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(isHoldingGroupRow(rows[0])).toBe(true);
    expect((rows[0] as HoldingGroupRow).underlyingSymbol).toBe("AAPL");
    expect(isHoldingGroupRow(rows[1])).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter frontend test -- group-by-underlying`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

新建 `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts`:

```ts
import { parseOccSymbol } from "@/lib/occ-symbol";
import type { Holding } from "@/lib/types";

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
  subRows: Holding[];
}

export type HoldingRow = HoldingGroupRow | Holding;

export function isHoldingGroupRow(row: HoldingRow): row is HoldingGroupRow {
  return (row as HoldingGroupRow).kind === "group";
}

export function getUnderlyingKey(holding: Holding): string {
  const symbol = holding.instrument?.symbol ?? holding.id;
  const parsed = parseOccSymbol(symbol);
  return parsed ? parsed.underlying : symbol;
}

export function groupHoldingsByUnderlying(holdings: Holding[]): HoldingRow[] {
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
      rows.push(buildGroupRow(key, members));
    }
  }
  return rows;
}

function buildGroupRow(underlyingKey: string, members: Holding[]): HoldingGroupRow {
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

  return {
    kind: "group",
    id: `group:${underlyingKey}`,
    underlyingKey,
    underlyingSymbol: underlyingKey,
    underlyingName: stock?.instrument?.name ?? null,
    memberCount: members.length,
    underlyingPrice: stock?.price ?? null,
    baseCurrency: members[0].baseCurrency,
    marketValueBase,
    costBasisBase,
    totalGainBase,
    totalGainPct: costBasisBase !== 0 ? totalGainBase / Math.abs(costBasisBase) : null,
    dayChangeBase,
    dayChangePct: prevCloseBase !== 0 ? dayChangeBase / Math.abs(prevCloseBase) : null,
    weight,
    subRows: members,
  };
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm --filter frontend test -- group-by-underlying`
Expected: PASS（全部用例)。

- [ ] **Step 5: 提交**

```bash
git add apps/frontend/src/pages/holdings/utils/group-by-underlying.ts apps/frontend/src/pages/holdings/utils/group-by-underlying.test.ts
git commit -m "feat(holdings): add group-by-underlying pure helper"
```

---

## Task 3: 接入 holdings-table(开关 + 归组 + 列分支)

**Files:**
- Modify: `apps/frontend/src/pages/holdings/components/holdings-table.tsx`
- Test: `apps/frontend/src/pages/holdings/components/holdings-table.test.tsx`

- [ ] **Step 1: 写失败测试(组件)**

新建 `apps/frontend/src/pages/holdings/components/holdings-table.test.tsx`:

```tsx
import type { Holding } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HoldingsTable } from "./holdings-table";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/components/ticker-avatar", () => ({
  TickerAvatar: ({ symbol }: { symbol: string }) => <span data-testid="avatar">{symbol}</span>,
}));
// Stub 根包 @wealthfolio/ui 的导出(动画/格式组件),保持子路径 DataTable 真实可测。
vi.mock("@wealthfolio/ui", () => ({
  AnimatedToggleGroup: ({
    items,
    onValueChange,
  }: {
    items: { value: string; label: string }[];
    onValueChange: (v: string) => void;
  }) => (
    <div>
      {items.map((it) => (
        <button key={it.value} type="button" onClick={() => onValueChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  ),
  AmountDisplay: ({ value }: { value: number }) => <span>{value}</span>,
  QuantityDisplay: ({ value }: { value: number }) => <span>{value}</span>,
  GainPercent: ({ value }: { value: number }) => <span>{value}</span>,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

function makeHolding(p: { id: string; symbol: string; name?: string; mv?: number }): Holding {
  return {
    id: p.id,
    instrument: { id: p.id, symbol: p.symbol, name: p.name ?? p.symbol, currency: "USD", quoteMode: "LIVE" },
    quantity: 1,
    price: 100,
    localCurrency: "USD",
    baseCurrency: "USD",
    fxRate: 1,
    marketValue: { local: p.mv ?? 100, base: p.mv ?? 100 },
    costBasis: { local: 50, base: 50 },
    totalGain: { local: 50, base: 50 },
    totalGainPct: 1,
    dayChange: { local: 1, base: 1 },
    dayChangePct: 0.01,
    prevCloseValue: { local: 99, base: 99 },
    weight: 0.1,
  } as unknown as Holding;
}

const ASTS_STOCK = makeHolding({ id: "s", symbol: "ASTS", name: "AST SpaceMobile", mv: 113 });
const ASTS_CALL = makeHolding({ id: "c", symbol: "ASTS260612C00110000", mv: 2028 });
const TSLA = makeHolding({ id: "t", symbol: "TSLA", name: "Tesla", mv: 435 });

function renderTable(holdings: Holding[]) {
  return render(
    <MemoryRouter>
      <HoldingsTable holdings={holdings} isLoading={false} />
    </MemoryRouter>,
  );
}

describe("HoldingsTable grouping", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("groups same-underlying holdings under one parent row by default", () => {
    renderTable([ASTS_STOCK, ASTS_CALL, TSLA]);
    // 父行显示标的 + 成员数徽标
    expect(screen.getByText("AST SpaceMobile")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // memberCount badge
    // 默认展开 → 期权腿副标题可见
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    // 单条 TSLA 平铺
    expect(screen.getByText("TSLA")).toBeInTheDocument();
  });

  it("collapses a group when its toggle is clicked", async () => {
    renderTable([ASTS_STOCK, ASTS_CALL]);
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    // 点父行展开器折叠(父行 Position 列是按钮)
    const parentToggle = screen.getByRole("button", { name: /AST SpaceMobile/i });
    await userEvent.click(parentToggle);
    expect(screen.queryByText(/CALL/)).not.toBeInTheDocument();
  });

  it("renders flat when grouping toggle is turned off", async () => {
    renderTable([ASTS_STOCK, ASTS_CALL]);
    await userEvent.click(screen.getByText("Flat"));
    // 关闭后无成员数徽标(无父行)
    expect(screen.queryByText("2")).not.toBeInTheDocument();
    // 两条都在
    expect(screen.getByText("ASTS")).toBeInTheDocument();
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
  });
});
```

> 注:断言以文本为主,允许执行者按真实渲染微调选择器(如 badge 文本、按钮可访问名)。核心验证不变:默认归组、可折叠、可关。

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter frontend test -- holdings-table`
Expected: FAIL —— 当前为扁平表,无父行/徽标/Flat 开关。

- [ ] **Step 3: 用以下完整内容替换 `holdings-table.tsx`**

```tsx
import { Button } from "@wealthfolio/ui/components/ui/button";
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import { DataTableColumnHeader } from "@wealthfolio/ui/components/ui/data-table/data-table-column-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { safeDivide } from "@/lib/utils";
import type { ColumnDef } from "@tanstack/react-table";
import { GainPercent, Badge } from "@wealthfolio/ui";

import { TickerAvatar } from "@/components/ticker-avatar";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useSettingsContext } from "@/lib/settings-provider";
import { Holding } from "@/lib/types";
import { AmountDisplay, QuantityDisplay } from "@wealthfolio/ui";
import { useNavigate } from "react-router-dom";

import { AnimatedToggleGroup } from "@wealthfolio/ui";
import {
  groupHoldingsByUnderlying,
  isHoldingGroupRow,
  type HoldingRow,
} from "../utils/group-by-underlying";

// Helper function to get display value and currency based on toggle state
const getDisplayValueAndCurrency = (
  holding: Holding,
  valueInBase: number | null | undefined,
  showConvertedToBase: boolean,
): { value: number; currency: string } => {
  const fxRate = holding.fxRate ?? 1; // Use fxRate from Holding

  if (showConvertedToBase) {
    return {
      value: valueInBase ?? 0,
      currency: holding.baseCurrency,
    };
  } else {
    const valueInOriginal = safeDivide(valueInBase ?? 0, fxRate);
    return {
      value: valueInOriginal,
      currency: holding.localCurrency,
    };
  }
};

export const HoldingsTable = ({
  holdings,
  isLoading,
  showTotalReturn = true,
  setShowTotalReturn,
  onClassify,
}: {
  holdings: Holding[];
  isLoading: boolean;
  showTotalReturn?: boolean;
  setShowTotalReturn?: (value: boolean) => void;
  onClassify?: (holding: Holding) => void;
}) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();
  const [showConvertedValues, setShowConvertedValues] = usePersistentState<boolean>(
    "holdings-table:show-converted",
    false,
  );
  const [groupByUnderlying, setGroupByUnderlying] = usePersistentState<boolean>(
    "holdings-table:group-by-underlying",
    true,
  );

  const baseCurrency = settings?.baseCurrency ?? holdings[0]?.baseCurrency;
  const hasMultipleCurrencies = holdings.some((holding) => {
    if (!baseCurrency || !holding.localCurrency) {
      return false;
    }
    return holding.localCurrency.toUpperCase() !== baseCurrency.toUpperCase();
  });

  if (isLoading) {
    return (
      <div className="space-y-4 pt-6">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const uniqueTypesSet = new Set();
  const assetsTypes: { label: string; value: string }[] = holdings.reduce(
    (result: { label: string; value: string }[], asset) => {
      const type = asset.instrument?.classifications?.assetType?.name;
      if (type && !uniqueTypesSet.has(type)) {
        uniqueTypesSet.add(type);
        result.push({ label: type.toUpperCase(), value: type });
      }
      return result;
    },
    [],
  );

  const filters = [
    {
      id: "holdingType",
      title: "Type",
      options: assetsTypes,
    },
  ];

  const tableData: HoldingRow[] = groupByUnderlying
    ? groupHoldingsByUnderlying(holdings)
    : holdings;

  return (
    <div className="flex h-full flex-col">
      <DataTable
        data={tableData}
        columns={getColumns(isBalanceHidden, showConvertedValues, showTotalReturn, onClassify)}
        searchBy="symbol"
        filters={filters}
        showColumnToggle={true}
        storageKey="holdings-table"
        getSubRows={(row) => (isHoldingGroupRow(row) ? row.subRows : undefined)}
        defaultExpanded={true}
        filterFromLeafRows={true}
        defaultColumnVisibility={{
          currency: false,
          symbolName: false,
          holdingType: false,
          bookValue: false,
        }}
        defaultSorting={[{ id: "symbol", desc: false }]}
        scrollable={true}
        toolbarActions={
          <div className="mr-2 flex items-center gap-2">
            <AnimatedToggleGroup
              value={groupByUnderlying ? "grouped" : "flat"}
              onValueChange={(value) => setGroupByUnderlying(value === "grouped")}
              items={[
                { value: "grouped", label: "Grouped" },
                { value: "flat", label: "Flat" },
              ]}
              size="xs"
              rounded="md"
            />
            {setShowTotalReturn && (
              <AnimatedToggleGroup
                value={showTotalReturn ? "total" : "daily"}
                onValueChange={(value) => setShowTotalReturn(value === "total")}
                items={[
                  { value: "total", label: "Total" },
                  { value: "daily", label: "Daily" },
                ]}
                size="xs"
                rounded="md"
              />
            )}
            {hasMultipleCurrencies && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setShowConvertedValues(!showConvertedValues)}
                    className="h-8 w-8 rounded-lg"
                  >
                    {showConvertedValues ? (
                      <Icons.Globe className="h-4 w-4" />
                    ) : (
                      <Icons.DollarSign className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Show values in {showConvertedValues ? "Asset Currency" : "Base Currency"}</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        }
      />
    </div>
  );
};

export default HoldingsTable;

const getColumns = (
  isHidden: boolean,
  showConvertedValues: boolean,
  showTotalReturn: boolean,
  onClassify?: (holding: Holding) => void,
): ColumnDef<HoldingRow>[] => [
  {
    id: "symbol",
    accessorFn: (row) =>
      isHoldingGroupRow(row) ? row.underlyingSymbol : row.instrument?.symbol ?? row.id,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Position" />,
    meta: {
      label: "Position",
    },
    cell: ({ row }) => {
      const navigate = useNavigate();
      const data = row.original;

      if (isHoldingGroupRow(data)) {
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
            <TickerAvatar symbol={data.underlyingSymbol} className="mr-2 h-8 w-8" />
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{data.underlyingSymbol}</span>
                <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px]">
                  {data.memberCount}
                </Badge>
              </div>
              <span className="text-muted-foreground line-clamp-1 text-xs">
                {data.underlyingName ?? ""}
              </span>
            </div>
          </button>
        );
      }

      const holding = data;
      const symbol = holding.instrument?.symbol ?? holding.id;
      const parsedOption = parseOccSymbol(symbol);
      const displaySymbol = parsedOption ? parsedOption.underlying : symbol;
      const optionSubtitle = parsedOption
        ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
        : null;

      const handleNavigate = () => {
        const navSymbol = holding.instrument?.id ?? holding.id;
        navigate(`/holdings/${encodeURIComponent(navSymbol)}`, { state: { holding } });
      };

      const isManual = holding.instrument?.quoteMode === "MANUAL";
      return (
        <div
          className="-m-1 cursor-pointer p-1"
          style={{ paddingLeft: row.depth > 0 ? `${row.depth * 1.5 + 0.25}rem` : undefined }}
          onClick={handleNavigate}
        >
          <div className="flex items-center">
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
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original;
      const b = rowB.original;
      const symbolA = isHoldingGroupRow(a) ? a.underlyingSymbol : a.instrument?.symbol ?? a.id;
      const symbolB = isHoldingGroupRow(b) ? b.underlyingSymbol : b.instrument?.symbol ?? b.id;
      return symbolA.localeCompare(symbolB);
    },
    filterFn: (row, _columnId, filterValue) => {
      const data = row.original;
      const lowerSearch = (filterValue as string).toLowerCase();
      if (isHoldingGroupRow(data)) {
        return (
          data.underlyingSymbol.toLowerCase().includes(lowerSearch) ||
          (data.underlyingName?.toLowerCase().includes(lowerSearch) ?? false)
        );
      }
      const holding = data;
      const nameMatch = holding.instrument?.name?.toLowerCase().includes(lowerSearch);
      const symbolMatch = holding.instrument?.symbol?.toLowerCase().includes(lowerSearch);
      const idMatch = holding.id.toLowerCase().includes(lowerSearch);
      const parsed = parseOccSymbol(holding.instrument?.symbol ?? "");
      const underlyingMatch = parsed?.underlying.toLowerCase().includes(lowerSearch);
      return !!(symbolMatch || nameMatch || idMatch || underlyingMatch);
    },
    enableHiding: false,
  },
  {
    id: "symbolName",
    accessorFn: (row) =>
      isHoldingGroupRow(row) ? row.underlyingName ?? row.underlyingSymbol : row.instrument?.name || row.id,
    meta: {
      label: "Symbol Name",
    },
    enableHiding: false,
  },
  {
    id: "quantity",
    accessorFn: (row) => (isHoldingGroupRow(row) ? 0 : row.quantity),
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end text-right" column={column} title="Qty" />
    ),
    meta: {
      label: "Quantity",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isHoldingGroupRow(data)) {
        return <div className="min-h-[40px] px-4" />;
      }
      const symbol = data.instrument?.symbol ?? data.id;
      const isOption = !!parseOccSymbol(symbol);
      const assetTypeKey = data.instrument?.classifications?.assetType?.key ?? "";
      const isBond =
        assetTypeKey.startsWith("BOND_") ||
        assetTypeKey === "DEBT_SECURITY" ||
        assetTypeKey === "MONEY_MARKET_DEBT";
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <QuantityDisplay value={data.quantity} isHidden={isHidden} />
          <span className="text-muted-foreground text-xs">
            {isOption ? "contracts" : isBond ? "bonds" : "shares"}
          </span>
        </div>
      );
    },
  },
  {
    id: "marketPrice",
    accessorFn: (row) => (isHoldingGroupRow(row) ? row.underlyingPrice ?? 0 : row.price ?? 0),
    enableHiding: true,
    enableSorting: true,
    header: ({ column }) => (
      <DataTableColumnHeader
        className="justify-end text-right"
        column={column}
        title="Today's Price"
      />
    ),
    meta: {
      label: "Today's Price",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isHoldingGroupRow(data)) {
        if (data.underlyingPrice == null) {
          return <div className="min-h-[40px] px-4" />;
        }
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.underlyingPrice} currency={data.baseCurrency} />
            <GainPercent className="text-xs" value={data.dayChangePct || 0} />
          </div>
        );
      }
      const price = data.price ?? 0;
      const currency = data.localCurrency;
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={price} currency={currency} />
          <GainPercent className="text-xs" value={data.dayChangePct || 0} />
        </div>
      );
    },
  },
  {
    id: "bookValue",
    accessorFn: (row) => (isHoldingGroupRow(row) ? row.costBasisBase : row.costBasis?.local ?? 0),
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Book Cost" />
    ),
    meta: {
      label: "Book Cost",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isHoldingGroupRow(data)) {
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.costBasisBase} currency={data.baseCurrency} isHidden={isHidden} />
            <div className="text-xs text-transparent">-</div>
          </div>
        );
      }
      const value = data.costBasis?.local ?? 0;
      const currency = data.localCurrency;
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} isHidden={isHidden} />
          <div className="text-xs text-transparent">-</div>
        </div>
      );
    },
  },
  {
    id: "marketValue",
    accessorFn: (row) => (isHoldingGroupRow(row) ? row.marketValueBase : row.marketValue.base ?? 0),
    enableHiding: false,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Total Value" />
    ),
    meta: {
      label: "Total Value",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isHoldingGroupRow(data)) {
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.marketValueBase} currency={data.baseCurrency} isHidden={isHidden} />
            <div className="text-muted-foreground text-xs">{data.baseCurrency}</div>
          </div>
        );
      }
      const { value, currency } = getDisplayValueAndCurrency(
        data,
        data.marketValue.base,
        showConvertedValues,
      );
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} isHidden={isHidden} />
          <div className="text-muted-foreground text-xs">{currency}</div>
        </div>
      );
    },
  },
  {
    id: "performance",
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? (showTotalReturn ? row.totalGainBase : row.dayChangeBase)
        : (showTotalReturn ? row.totalGain?.base : row.dayChange?.base) ?? 0,
    enableHiding: false,
    header: ({ column }) => (
      <DataTableColumnHeader
        className="justify-end"
        column={column}
        title={showTotalReturn ? "Unrealized Gain" : "Day Change"}
      />
    ),
    meta: {
      label: "Unrealized Gain",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isHoldingGroupRow(data)) {
        const value = showTotalReturn ? data.totalGainBase : data.dayChangeBase;
        const pct = showTotalReturn ? data.totalGainPct : data.dayChangePct;
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={value} currency={data.baseCurrency} colorFormat={true} isHidden={isHidden} />
            <GainPercent className="text-xs" value={pct || 0} />
          </div>
        );
      }
      const valueBase = showTotalReturn ? data.totalGain?.base : data.dayChange?.base;
      const pct = showTotalReturn ? data.totalGainPct : data.dayChangePct;
      const { value, currency } = getDisplayValueAndCurrency(data, valueBase, showConvertedValues);
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} colorFormat={true} isHidden={isHidden} />
          <GainPercent className="text-xs" value={pct || 0} />
        </div>
      );
    },
  },
  {
    id: "holdingType",
    accessorFn: (row) =>
      isHoldingGroupRow(row) ? undefined : row.instrument?.classifications?.assetType?.name,
    meta: {
      label: "Asset Type",
    },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Asset Type" />,
    filterFn: "arrIncludesSome",
  },
  {
    id: "currency",
    accessorFn: (row) => (isHoldingGroupRow(row) ? row.baseCurrency : row.localCurrency),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Currency" />,
    meta: {
      label: "Currency",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isHoldingGroupRow(data)) {
        return <div className="text-muted-foreground">{data.baseCurrency}</div>;
      }
      return <div className="text-muted-foreground">{data.localCurrency}</div>;
    },
    filterFn: (row, id, value) => {
      return value.includes(row.getValue(id));
    },
  },
  {
    id: "actions",
    enableHiding: false,
    header: () => null,
    cell: ({ row }) => {
      const navigate = useNavigate();
      const data = row.original;

      if (isHoldingGroupRow(data)) {
        return <div className="flex items-center justify-end" />;
      }

      const holding = data;
      const hasInstrument = !!holding.instrument;

      const handleNavigate = () => {
        const navSymbol = holding.instrument?.id ?? holding.id;
        navigate(`/holdings/${encodeURIComponent(navSymbol)}`, {
          state: { holding },
        });
      };

      return (
        <div className="flex items-center justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Icons.MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hasInstrument && onClassify && (
                <DropdownMenuItem onClick={() => onClassify(holding)}>
                  <Icons.Tag className="mr-2 h-4 w-4" />
                  Classify
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleNavigate}>
                <Icons.ChevronRight className="mr-2 h-4 w-4" />
                View Details
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    },
  },
];
```

> 说明:本次顺手把 `showConvertedValues` 也改为 `usePersistentState`(原为 `useState`),与新开关一致地持久化;若想最小化改动,可保留原 `useState`,但需补回 `import { useState }`。执行者二选一即可,测试不依赖该项。

- [ ] **Step 4: 运行组件测试,确认通过**

Run: `pnpm --filter frontend test -- holdings-table`
Expected: PASS（3 个用例)。失败时按真实渲染调整测试选择器(badge/按钮名),不改实现语义。

- [ ] **Step 5: 跑相关单测 + 类型 + lint**

Run: `pnpm --filter frontend test -- group-by-underlying data-table-expansion holdings-table && pnpm type-check && pnpm lint`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/frontend/src/pages/holdings/components/holdings-table.tsx apps/frontend/src/pages/holdings/components/holdings-table.test.tsx
git commit -m "feat(holdings): group holdings by underlying with collapsible parent rows"
```

---

## Task 4: 全量校验 + Web 端人工验证

**Files:** 无(验证步骤)

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿,无回归(尤其其它 7 个 DataTable 消费方页面)。

- [ ] **Step 2: 类型检查 + lint + Web 构建**

Run: `pnpm type-check && pnpm lint && pnpm --filter frontend build`
Expected: 通过(`build` 即 `BUILD_TARGET=web` 构建)。

- [ ] **Step 3: 启动 Web 版人工验证**

Run: `pnpm run dev:web`(另起后端 `apps/server` 或用现有自托管实例)
人工核对(对照设计文档第 9 节验收标准):
1. Investments 表默认按标的归组:同标的(正股 + 期权腿)折叠在父行下,父行显示合计市值/成本/盈亏,价格列为标的现价,名称后有 `(n)` 徽标。
2. 仅单条持仓(如 TSLA)平铺为单行。
3. 点父行展开/折叠,刷新后折叠状态保留(localStorage `holdings-table:expanded`)。
4. 关闭「Grouped/Flat」开关 → 回到扁平表;刷新后开关状态保留。
5. 搜索某期权腿 → 其父组可见;按资产类型筛选同理。
6. 其它使用 DataTable 的页面(活动、资产、汇率、CSV 预览等)显示与行为无变化。

- [ ] **Step 4: 截图留证(可选)**

用 webapp-testing 或浏览器对持仓页截图,确认与 Futu「期权组合」外层形态一致(父行 + 折叠腿)。

- [ ] **Step 5: 标记 P1 完成**

P1 完成后,后续可进入 P2(命名策略组合)、P3(Greeks),各自走设计→计划→实现。
```
