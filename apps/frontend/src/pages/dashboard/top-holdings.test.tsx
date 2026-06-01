import type { Holding } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TopHoldings } from "./top-holdings";

vi.mock("@/hooks/use-balance-privacy", () => ({ useBalancePrivacy: () => ({ isBalanceHidden: false }) }));
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: ({ symbol }: { symbol: string }) => <span>{symbol}</span> }));
vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) => (
    <div>{action}{children}</div>
  ),
}));
vi.mock("@/hooks/use-option-strategies", () => ({
  useOptionStrategies: () => ({ data: [] }),
}));

function makeHolding(p: { id: string; symbol: string; name?: string; mv?: number }): Holding {
  return {
    id: p.id,
    instrument: { id: p.id, symbol: p.symbol, name: p.name ?? p.symbol, currency: "USD", quoteMode: "LIVE" },
    quantity: 1, price: 100, localCurrency: "USD", baseCurrency: "USD", fxRate: 1,
    holdingType: "SECURITY",
    marketValue: { local: p.mv ?? 100, base: p.mv ?? 100 },
    costBasis: { local: 50, base: 50 },
    totalGain: { local: 50, base: 50 }, totalGainPct: 1,
    dayChange: { local: 1, base: 1 }, dayChangePct: 0.01,
    prevCloseValue: { local: 99, base: 99 }, weight: 0.1,
  } as unknown as Holding;
}
const ASTS_C = makeHolding({ id: "c1", symbol: "ASTS  260702C00140000", mv: 100 });
const ASTS_P = makeHolding({ id: "c2", symbol: "ASTS  260702P00070000", mv: 200 });
const IBKR = makeHolding({ id: "k", symbol: "IBKR", name: "Interactive Brokers", mv: 300 });

function renderWidget(holdings: Holding[]) {
  return render(<MemoryRouter><TopHoldings holdings={holdings} isLoading={false} baseCurrency="USD" /></MemoryRouter>);
}

// Fixtures for strategy layer test (standard OCC 21-char format)
function makeOptionHolding(p: { id: string; symbol: string; qty?: number; mv?: number }): Holding {
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

const VERT_LONG = makeOptionHolding({ id: "vl", symbol: "ASTS260612C00100000", qty: 1, mv: 250 });
const VERT_SHORT = makeOptionHolding({ id: "vs", symbol: "ASTS260612C00110000", qty: -1, mv: -80 });

describe("TopHoldings strategy layer", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders a strategy sub-row under an expanded underlying group", async () => {
    render(
      <MemoryRouter>
        <TopHoldings holdings={[VERT_LONG, VERT_SHORT]} isLoading={false} baseCurrency="USD" />
      </MemoryRouter>,
    );
    // Expand the underlying group, revealing the strategy sub-row.
    await userEvent.click(screen.getByText(/2 positions/i));
    expect(screen.getByText(/Spread/i)).toBeInTheDocument();
  });
});

describe("TopHoldings grouping", () => {
  beforeEach(() => window.localStorage.clear());
  it("collapses same-underlying holdings into one summary row by default", () => {
    renderWidget([ASTS_C, ASTS_P, IBKR]);
    // ASTS appears as both the avatar (mocked) and the summary row title.
    expect(screen.getAllByText("ASTS").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 positions/i)).toBeInTheDocument();
    // individual option legs are not shown as separate rows
    expect(screen.queryByText(/CALL/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PUT/)).not.toBeInTheDocument();
    // IBKR stays as its own row (avatar + title both render the symbol).
    expect(screen.getAllByText("IBKR").length).toBeGreaterThan(0);
  });
  it("shows individual legs when grouping disabled (persisted)", () => {
    window.localStorage.setItem("dashboard-holdings-widget-group-by-underlying", "false");
    renderWidget([ASTS_C, ASTS_P]);
    expect(screen.queryByText(/2 positions/i)).not.toBeInTheDocument();
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    expect(screen.getByText(/PUT/)).toBeInTheDocument();
  });
  it("expands a group in place on click to reveal legs", async () => {
    window.localStorage.setItem("dashboard-holdings-widget-group-by-strategy", "false");
    const user = userEvent.setup();
    renderWidget([ASTS_C, ASTS_P]);
    expect(screen.queryByText(/CALL/)).not.toBeInTheDocument();
    await user.click(screen.getByText(/2 positions/i));
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    expect(screen.getByText(/PUT/)).toBeInTheDocument();
  });
});
