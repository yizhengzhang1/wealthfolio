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
