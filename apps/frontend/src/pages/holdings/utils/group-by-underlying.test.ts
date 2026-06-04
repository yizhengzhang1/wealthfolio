import { describe, expect, it } from "vitest";
import type { Holding } from "@/lib/types";
import {
  getUnderlyingKey,
  groupHoldingsByUnderlying,
  isHoldingGroupRow,
  type HoldingGroupRow,
} from "./group-by-underlying";
import { isStrategyGroupRow } from "./detect-strategies";

// 最小 Holding 工厂(只填测试用到的字段,其余以 as Holding 跳过)
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
    unrealizedGain: { local: p.unreal ?? 0, base: p.unreal ?? 0 },
    realizedGain: { local: p.real ?? 0, base: p.real ?? 0 },
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
  it("returns an empty array for empty input", () => {
    expect(groupHoldingsByUnderlying([])).toEqual([]);
  });

  it("keeps a single-member underlying flat (not a group)", () => {
    const rows = groupHoldingsByUnderlying([makeHolding({ id: "1", symbol: "TSLA" })]);
    expect(rows).toHaveLength(1);
    expect(isHoldingGroupRow(rows[0])).toBe(false);
  });

  it("groups a stock + its option legs into one group row with aggregates", () => {
    const rows = groupHoldingsByUnderlying([
      makeHolding({ id: "s", symbol: "ASTS", name: "AST SpaceMobile", price: 113.41, mv: 113.41, cost: 123, gain: -9.59, unreal: -9.59, real: 0, day: 1, prevClose: 112.41, weight: 0.1 }),
      makeHolding({ id: "c1", symbol: OCC_CALL, mv: -1264.56, cost: 313, gain: -300, unreal: -340, real: 40, day: 2, prevClose: -1266.56, weight: -0.3 }),
      makeHolding({ id: "c2", symbol: OCC_CALL2, mv: 2028.15, cost: 578, gain: 1450, unreal: 1400, real: 50, day: 3, prevClose: 2025.15, weight: 0.5 }),
    ]);

    expect(rows).toHaveLength(1);
    const group = rows[0] as HoldingGroupRow;
    expect(isHoldingGroupRow(group)).toBe(true);
    expect(group.underlyingSymbol).toBe("ASTS");
    expect(group.underlyingName).toBe("AST SpaceMobile");
    expect(group.memberCount).toBe(3);
    expect(group.underlyingPrice).toBe(113.41);
    expect(group.subRows).toHaveLength(3);
    expect(group.marketValueBase).toBeCloseTo(113.41 - 1264.56 + 2028.15, 2);
    expect(group.costBasisBase).toBeCloseTo(123 + 313 + 578, 2);
    expect(group.totalGainBase).toBeCloseTo(-9.59 - 300 + 1450, 2);
    expect(group.unrealizedGainBase).toBeCloseTo(-9.59 - 340 + 1400, 2);
    expect(group.realizedGainBase).toBeCloseTo(0 + 40 + 50, 2);
    expect(group.dayChangeBase).toBeCloseTo(1 + 2 + 3, 2);
    expect(group.weight).toBeCloseTo(0.1 - 0.3 + 0.5, 4);
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

  it("returns null dayChangePct when prevClose legs cancel to zero", () => {
    const rows = groupHoldingsByUnderlying([
      makeHolding({ id: "c1", symbol: OCC_CALL, mv: 10, day: 1, prevClose: 100 }),
      makeHolding({ id: "c2", symbol: OCC_CALL2, mv: 20, day: 2, prevClose: -100 }),
    ]);
    const group = rows[0] as HoldingGroupRow;
    expect(group.dayChangePct).toBeNull();
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
