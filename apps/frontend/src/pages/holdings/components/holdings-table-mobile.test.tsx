import type { Account, Holding } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HoldingsTableMobile } from "./holdings-table-mobile";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/components/ticker-avatar", () => ({
  TickerAvatar: ({ symbol }: { symbol: string }) => <span data-testid="avatar">{symbol}</span>,
}));
// Stub the mobile filter sheet (separate concern; opened via button).
vi.mock("./holdings-mobile-filter-sheet", () => ({
  HoldingsMobileFilterSheet: () => null,
}));
// Stub @wealthfolio/ui root exports used by the mobile table.
vi.mock("@/hooks/use-option-strategies", () => ({
  useOptionStrategies: () => ({ data: [] }),
}));

vi.mock("@wealthfolio/ui", () => ({
  AmountDisplay: ({ value }: { value: number }) => <span>{value}</span>,
  GainPercent: ({ value }: { value: number }) => <span>{value}</span>,
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Separator: () => <span />,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  // Minimal localStorage-backed stand-in so grouping/expand persistence works under jsdom.
  usePersistentState: <T,>(key: string, initial: T) => {
    const [value, setValue] = useState<T>(() => {
      const stored = window.localStorage.getItem(key);
      return stored != null ? (JSON.parse(stored) as T) : initial;
    });
    const set = (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        window.localStorage.setItem(key, JSON.stringify(resolved));
        return resolved;
      });
    return [value, set] as const;
  },
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

const ASTS_C = makeHolding({ id: "c1", symbol: "ASTS  260702C00140000", mv: 100 });
const ASTS_P = makeHolding({ id: "c2", symbol: "ASTS  260702P00070000", mv: 200 });
const IBKR = makeHolding({ id: "k", symbol: "IBKR", name: "Interactive Brokers", mv: 300 });

// The avatar stub renders its symbol as text too, so scope symbol lookups to the
// card's <p> label to avoid duplicate-text matches.
const labelMatcher = (text: string) => (content: string, el: Element | null) =>
  el?.tagName === "P" && content === text;

const noop = () => {};
function renderMobile(holdings: Holding[]) {
  return render(
    <MemoryRouter>
      <HoldingsTableMobile
        holdings={holdings}
        isLoading={false}
        selectedTypes={[]}
        setSelectedTypes={noop}
        accountFilter={{ type: "all" }}
        onAccountScopeChange={noop}
        accounts={[] as Account[]}
        portfolios={[]}
      />
    </MemoryRouter>,
  );
}

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
    expect(screen.getAllByText(/CALL/).length).toBeGreaterThan(0);
  });

  it("flattens legs when strategy sub-grouping is disabled (persisted)", () => {
    window.localStorage.setItem("holdings-mobile:group-by-strategy", "false");
    renderMobile([VERT_LONG, VERT_SHORT]);
    // No strategy label; legs hidden until underlying expanded (collapsed default).
    expect(screen.queryByText(/Spread/i)).not.toBeInTheDocument();
  });
});

describe("HoldingsTableMobile grouping", () => {
  beforeEach(() => window.localStorage.clear());

  it("groups same-underlying holdings into a collapsed parent card by default", () => {
    renderMobile([ASTS_C, ASTS_P, IBKR]);
    // Parent card present with member count; legs hidden (collapsed by default)
    expect(screen.getByText(labelMatcher("ASTS"))).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText(/CALL/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PUT/)).not.toBeInTheDocument();
    // Single holding flat
    expect(screen.getByText(labelMatcher("IBKR"))).toBeInTheDocument();
  });

  it("expands a group on tap to reveal legs", async () => {
    window.localStorage.setItem("holdings-mobile:group-by-strategy", "false");
    renderMobile([ASTS_C, ASTS_P]);
    await userEvent.click(screen.getByText(labelMatcher("ASTS")));
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    expect(screen.getByText(/PUT/)).toBeInTheDocument();
  });

  it("renders flat when grouping is disabled (persisted state)", () => {
    window.localStorage.setItem("holdings-mobile:group-by-underlying", "false");
    renderMobile([ASTS_C, ASTS_P]);
    // No member-count badge; both legs shown directly
    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    expect(screen.getByText(/PUT/)).toBeInTheDocument();
  });
});
