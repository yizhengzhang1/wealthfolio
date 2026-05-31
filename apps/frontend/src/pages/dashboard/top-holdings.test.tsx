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
    const user = userEvent.setup();
    renderWidget([ASTS_C, ASTS_P]);
    expect(screen.queryByText(/CALL/)).not.toBeInTheDocument();
    await user.click(screen.getByText(/2 positions/i));
    expect(screen.getByText(/CALL/)).toBeInTheDocument();
    expect(screen.getByText(/PUT/)).toBeInTheDocument();
  });
});
