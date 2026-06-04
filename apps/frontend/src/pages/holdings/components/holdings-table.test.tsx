import type { Holding } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HoldingsTable } from "./holdings-table";
import {
  useOptionStrategies,
  useCreateOptionStrategy,
  useUpdateOptionStrategy,
  useDeleteOptionStrategy,
} from "@/hooks/use-option-strategies";

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
  usePersistentState: <T,>(_key: string, initial: T) => useState<T>(initial),
}));
// The component imports these from their @wealthfolio/ui subpaths. Stub the
// subpaths so the strategy ⋯ menu, rename dialog, and leg checkboxes render
// synchronously (the real Radix dropdown/dialog stay collapsed in jsdom). The
// real DataTable imports its own dropdown/button via package-internal relative
// paths, so it is unaffected by these mocks — include every export it needs.
vi.mock("@wealthfolio/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  DropdownMenuCheckboxItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));
vi.mock("@wealthfolio/ui/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@wealthfolio/ui/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("@wealthfolio/ui/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
  }) => (
    <input type="checkbox" checked={!!checked} onChange={(e) => onCheckedChange?.(e.target.checked)} />
  ),
}));
vi.mock("@/hooks/use-option-strategies", () => ({
  useOptionStrategies: vi.fn(() => ({ data: [] })),
  useCreateOptionStrategy: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateOptionStrategy: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteOptionStrategy: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
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
    // The parent group row is the only collapsible toggle button; it carries the
    // underlying name and the memberCount badge.
    expect(screen.getByRole("button", { name: /AST SpaceMobile/i })).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0); // memberCount badge
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    // TSLA is an ungrouped single holding; symbol shows in both avatar and label.
    expect(screen.getAllByText("TSLA").length).toBeGreaterThan(0);
  });

  it("collapses a group when its toggle is clicked", async () => {
    renderTable([ASTS_STOCK, ASTS_CALL]);
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    const parentToggle = screen.getByRole("button", { name: /AST SpaceMobile/i });
    await userEvent.click(parentToggle);
    expect(screen.queryByText(/CALL/)).not.toBeInTheDocument();
  });

  it("renders flat when grouping toggle is turned off", async () => {
    renderTable([ASTS_STOCK, ASTS_CALL]);
    await userEvent.click(screen.getByText("Flat"));
    // No group: no memberCount badge and no collapsible parent toggle.
    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /AST SpaceMobile/i })).not.toBeInTheDocument();
    expect(screen.getAllByText("ASTS").length).toBeGreaterThan(0);
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
  });
});

const VERT_LONG = { ...makeHolding({ id: "vl", symbol: "ASTS260612C00100000", mv: 250 }), accountId: "vl" } as Holding;
const VERT_SHORT = (() => {
  const h = makeHolding({ id: "vs", symbol: "ASTS260612C00110000", mv: -80 });
  return { ...h, quantity: -1, accountId: "vl" } as Holding;
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

describe("HoldingsTable strategy editing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(useOptionStrategies).mockReturnValue({ data: [] } as never);
    vi.mocked(useCreateOptionStrategy).mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
    vi.mocked(useUpdateOptionStrategy).mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
    vi.mocked(useDeleteOptionStrategy).mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
  });

  it("renames a strategy via the context menu dialog (update for override-backed)", async () => {
    const updateMutate = vi.fn();
    vi.mocked(useUpdateOptionStrategy).mockReturnValue({ mutate: updateMutate, isPending: false } as never);
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
    const input = screen.getByPlaceholderText(/strategy name/i);
    await userEvent.clear(input); // dialog pre-fills the auto label; clear before typing
    await userEvent.type(input, "Auto Renamed");
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

describe("HoldingsTable create-strategy from selection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(useOptionStrategies).mockReturnValue({ data: [] } as never);
    vi.mocked(useCreateOptionStrategy).mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
    vi.mocked(useUpdateOptionStrategy).mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
    vi.mocked(useDeleteOptionStrategy).mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
  });

  it("creates a group override from checked legs with a suggested default name", async () => {
    const createMutate = vi.fn();
    vi.mocked(useCreateOptionStrategy).mockReturnValue({ mutate: createMutate, isPending: false } as never);
    vi.mocked(useOptionStrategies).mockReturnValue({ data: [] } as never);

    // Two unrelated legs (different expiries+types so plan 2 leaves them loose).
    const A = makeHolding({ id: "a", symbol: "ASTS260612C00100000", mv: 10 });
    const B = makeHolding({ id: "b", symbol: "ASTS260920P00050000", mv: 20 });
    renderTable([A, B]);

    await userEvent.click(screen.getByText("Select legs"));
    // Each leaf re-renders on selection (the column array is rebuilt), so the
    // first checkbox node is detached after the first click — re-query each time.
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getAllByRole("checkbox")[1]);
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

  it("clears leg selection when strategy sub-grouping is turned off", async () => {
    const A = makeHolding({ id: "a", symbol: "ASTS260612C00100000", mv: 10 });
    const B = makeHolding({ id: "b", symbol: "ASTS260920P00050000", mv: 20 });
    renderTable([A, B]);

    await userEvent.click(screen.getByText("Select legs"));
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByText(/Create strategy/i)).toBeInTheDocument();

    // Flipping Strategy -> Legs must reset selecting + selectedLegs, hiding the
    // floating button and the leg checkboxes.
    await userEvent.click(screen.getByText("Legs"));
    expect(screen.queryByText(/Create strategy/i)).not.toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);

    // Re-opening selection shows no pre-checked legs (selectedLegs was emptied,
    // not merely hidden).
    await userEvent.click(screen.getByText("Strategy"));
    await userEvent.click(screen.getByText("Select legs"));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((b) => !b.checked)).toBe(true);
  });

  it("clears leg selection when grouping is switched to Flat", async () => {
    const A = makeHolding({ id: "a", symbol: "ASTS260612C00100000", mv: 10 });
    const B = makeHolding({ id: "b", symbol: "ASTS260920P00050000", mv: 20 });
    renderTable([A, B]);

    await userEvent.click(screen.getByText("Select legs"));
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByText(/Create strategy/i)).toBeInTheDocument();

    // Switching off underlying grouping also unmounts the selection UI, so the
    // floating button (which only checks `selecting`) must not linger.
    await userEvent.click(screen.getByText("Flat"));
    expect(screen.queryByText(/Create strategy/i)).not.toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("HoldingsTable Futu columns", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders the default-visible metric column headers", () => {
    renderTable([TSLA]);
    expect(screen.getAllByText("MktVal / Qty", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Price / AvgCost", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Day", { exact: false }).length).toBeGreaterThan(0);
  });

  it("no longer renders the table Total/Daily toggle", () => {
    renderTable([TSLA]);
    expect(screen.queryByText("Daily")).not.toBeInTheDocument();
  });
});
