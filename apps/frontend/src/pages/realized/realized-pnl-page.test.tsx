import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealizedPnl } from "@/lib/types";

const getRealizedPnlMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters", () => ({
  getRealizedPnl: getRealizedPnlMock,
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@/components/ticker-avatar", () => ({
  TickerAvatar: ({ symbol }: { symbol: string }) => <span data-testid="avatar">{symbol}</span>,
}));

vi.mock("@/components/account-filter-selector", () => ({
  AccountScopeSelector: () => <div data-testid="account-scope-selector" />,
}));

import RealizedPnlPage from "./realized-pnl-page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RealizedPnlPage />
    </QueryClientProvider>,
  );
}

const SAMPLE: RealizedPnl = {
  baseCurrency: "USD",
  entries: [
    { underlying: "TSLA", currency: "USD", realized: { local: -16923, base: -16923 } },
    { underlying: "2015", currency: "HKD", realized: { local: -57350, base: -7318 } },
    { underlying: "AAPL", currency: "USD", realized: { local: 4200, base: 4200 } },
  ],
  total: { base: -20041 },
};

describe("RealizedPnlPage", () => {
  beforeEach(() => {
    getRealizedPnlMock.mockResolvedValue(SAMPLE);
  });
  afterEach(() => {
    getRealizedPnlMock.mockReset();
  });

  it("renders the account scope selector", async () => {
    renderPage();
    const selectors = await screen.findAllByTestId("account-scope-selector");
    expect(selectors.length).toBeGreaterThan(0);
  });

  it("renders the base-currency total", async () => {
    renderPage();
    expect(await screen.findByText(/20,041/)).toBeInTheDocument();
  });

  it("renders a row per underlying including the HKD one", async () => {
    renderPage();
    await screen.findAllByTestId("realized-row");
    expect(screen.getAllByText("TSLA").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2015").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AAPL").length).toBeGreaterThan(0);
  });

  it("shows the HKD local currency for the Li Auto underlying", async () => {
    renderPage();
    expect(await screen.findByText(/57,350/)).toBeInTheDocument();
  });

  it("orders underlyings by absolute base descending (TSLA before 2015 before AAPL)", async () => {
    renderPage();
    const rows = await screen.findAllByTestId("realized-row");
    const order = rows.map((r) => r.getAttribute("data-underlying"));
    expect(order).toEqual(["TSLA", "2015", "AAPL"]);
  });
});
