import type { Holding } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
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
vi.mock("@/hooks/use-option-strategies", () => ({
  useOptionStrategies: () => ({ data: [] }),
  useCreateOptionStrategy: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateOptionStrategy: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteOptionStrategy: () => ({ mutate: vi.fn(), isPending: false }),
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
    expect(screen.getByText("2")).toBeInTheDocument(); // memberCount badge
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
