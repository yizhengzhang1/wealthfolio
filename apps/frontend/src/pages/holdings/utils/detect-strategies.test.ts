import { describe, expect, it } from "vitest";
import type { Holding, StrategyOverride } from "@/lib/types";
import { buildOccSymbol } from "@/lib/occ-symbol";
import { buildStrategyRow, detectStrategies } from "./detect-strategies";

// Minimal Holding factory (extends the P1 group-by-underlying factory with the
// fields detection needs: quantity sign, accountId, contractMultiplier).
function makeHolding(p: {
  id: string;
  symbol: string;
  accountId?: string;
  quantity?: number; // signed: >0 long, <0 short
  contractMultiplier?: number | null;
  mv?: number; // marketValue.base
  cost?: number; // costBasis.base
  gain?: number; // totalGain.base
  day?: number; // dayChange.base
  prevClose?: number; // prevCloseValue.base
  weight?: number;
}): Holding {
  return {
    id: p.id,
    accountId: p.accountId ?? "acct-1",
    instrument: { id: p.id, symbol: p.symbol, name: p.symbol, currency: "USD", quoteMode: "LIVE" },
    quantity: p.quantity ?? 1,
    contractMultiplier: p.contractMultiplier ?? null,
    price: null,
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

// OCC fixture builders (underlying fixed to ASTS unless overridden).
const EXP_A = "2026-06-12";
const EXP_B = "2026-07-17";
function call(strike: number, exp = EXP_A, u = "ASTS") {
  return buildOccSymbol(u, exp, "CALL", strike);
}
function put(strike: number, exp = EXP_A, u = "ASTS") {
  return buildOccSymbol(u, exp, "PUT", strike);
}

// shared helpers re-used across families
const NO_OVERRIDES: StrategyOverride[] = [];

describe("detectStrategies — baseline", () => {
  it("returns empty for empty input", () => {
    expect(detectStrategies([], NO_OVERRIDES)).toEqual({ strategies: [], looseLegs: [] });
  });

  it("leaves a lone short put as a loose leg (cash-secured put does not group)", () => {
    const leg = makeHolding({ id: "p1", symbol: put(100), quantity: -1 });
    const result = detectStrategies([leg], NO_OVERRIDES);
    expect(result.strategies).toHaveLength(0);
    expect(result.looseLegs).toEqual([leg]);
  });

  it("leaves a lone stock holding as a loose leg", () => {
    const leg = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const result = detectStrategies([leg], NO_OVERRIDES);
    expect(result.strategies).toHaveLength(0);
    expect(result.looseLegs).toEqual([leg]);
  });
});

describe("buildStrategyRow", () => {
  it("aggregates base-currency sums, netCashBase, sorted legKey id, and pct", () => {
    const c1 = makeHolding({
      id: "c1",
      symbol: call(110),
      quantity: -1,
      mv: -1264.56,
      cost: 313,
      gain: -300,
      day: 2,
      prevClose: -1266.56,
      weight: -0.3,
    });
    const c2 = makeHolding({
      id: "c2",
      symbol: call(100),
      quantity: 1,
      mv: 2028.15,
      cost: 578,
      gain: 1450,
      day: 3,
      prevClose: 2025.15,
      weight: 0.5,
    });
    const row = buildStrategyRow("ASTS", "vertical", "Bull Call Spread", "auto", [c2, c1]);
    expect(row.kind).toBe("strategy");
    expect(row.underlyingKey).toBe("ASTS");
    expect(row.strategyType).toBe("vertical");
    expect(row.name).toBe("Bull Call Spread");
    expect(row.source).toBe("auto");
    expect(row.overrideId).toBeUndefined();
    expect(row.memberCount).toBe(2);
    expect(row.baseCurrency).toBe("USD");
    expect(row.marketValueBase).toBeCloseTo(-1264.56 + 2028.15, 2);
    expect(row.costBasisBase).toBeCloseTo(313 + 578, 2);
    expect(row.totalGainBase).toBeCloseTo(-300 + 1450, 2);
    expect(row.dayChangeBase).toBeCloseTo(2 + 3, 2);
    expect(row.weight).toBeCloseTo(-0.3 + 0.5, 4);
    expect(row.netCashBase).toBeCloseTo(313 + 578, 2);
    expect(row.totalGainPct).toBeCloseTo((-300 + 1450) / Math.abs(313 + 578), 6);
    expect(row.dayChangePct).toBeCloseTo((2 + 3) / Math.abs(-1266.56 + 2025.15), 6);
    // id = strategy:ASTS:<sorted leg symbols join '|'>
    const sorted = [call(110), call(100)].sort().join("|");
    expect(row.id).toBe(`strategy:ASTS:${sorted}`);
    // legs preserved in the passed order
    expect(row.subRows).toEqual([c2, c1]);
  });

  it("returns null pct when cost basis / prevClose sums are zero", () => {
    const a = makeHolding({ id: "a", symbol: call(100), quantity: 1, cost: 0, prevClose: 0 });
    const b = makeHolding({ id: "b", symbol: call(110), quantity: -1, cost: 0, prevClose: 0 });
    const row = buildStrategyRow("ASTS", "vertical", "X", "auto", [a, b]);
    expect(row.totalGainPct).toBeNull();
    expect(row.dayChangePct).toBeNull();
  });

  it("sets source='override' with overrideId when provided", () => {
    const a = makeHolding({ id: "a", symbol: call(100), quantity: 1 });
    const b = makeHolding({ id: "b", symbol: call(110), quantity: -1 });
    const row = buildStrategyRow("ASTS", "vertical", "X", "override", [a, b], "ovr-9");
    expect(row.source).toBe("override");
    expect(row.overrideId).toBe("ovr-9");
  });
});

describe("two-leg: vertical / calendar / diagonal", () => {
  it("bull call vertical: same type, same expiry, long lower strike + short higher", () => {
    const long = makeHolding({ id: "L", symbol: call(100, EXP_A), quantity: 1, cost: 600 });
    const short = makeHolding({ id: "S", symbol: call(110, EXP_A), quantity: -1, cost: -200 });
    const { strategies, looseLegs } = detectStrategies([long, short], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(strategies[0].name).toBe("Bull Call Spread");
    expect(strategies[0].memberCount).toBe(2);
    expect(strategies[0].netCashBase).toBeCloseTo(400, 2);
  });

  it("bear put vertical: same type, same expiry, long higher strike", () => {
    const long = makeHolding({ id: "L", symbol: put(110, EXP_A), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: put(100, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(strategies[0].name).toBe("Bear Put Spread");
  });

  it("bull put vertical (credit): put, same expiry, long lower strike", () => {
    const long = makeHolding({ id: "L", symbol: put(100, EXP_A), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: put(110, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(strategies[0].name).toBe("Bull Put Spread");
  });

  it("bear call vertical: call, same expiry, long higher strike", () => {
    const long = makeHolding({ id: "L", symbol: call(110, EXP_A), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: call(100, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("vertical");
    expect(strategies[0].name).toBe("Bear Call Spread");
  });

  it("calendar: same type, same strike, different expiry, one long one short", () => {
    const long = makeHolding({ id: "L", symbol: call(100, EXP_B), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: call(100, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("calendar");
    expect(strategies[0].name).toBe("Calendar Spread");
  });

  it("diagonal: same type, different strike AND different expiry, one long one short", () => {
    const long = makeHolding({ id: "L", symbol: call(100, EXP_A), quantity: 1 });
    const short = makeHolding({ id: "S", symbol: call(110, EXP_B), quantity: -1 });
    const { strategies } = detectStrategies([long, short], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("diagonal");
    expect(strategies[0].name).toBe("Diagonal Spread");
  });

  it("two longs of same type do not form a vertical (ambiguous -> loose)", () => {
    const a = makeHolding({ id: "a", symbol: call(100, EXP_A), quantity: 1 });
    const b = makeHolding({ id: "b", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([a, b], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });
});

describe("two-leg: straddle / strangle", () => {
  it("long straddle: call + put, same strike, same expiry, both long", () => {
    const c = makeHolding({ id: "c", symbol: call(100, EXP_A), quantity: 1 });
    const p = makeHolding({ id: "p", symbol: put(100, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([c, p], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies[0].strategyType).toBe("straddle");
    expect(strategies[0].name).toBe("Straddle");
  });

  it("short strangle: call + put, different strike, same expiry, both short", () => {
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([c, p], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("strangle");
    expect(strategies[0].name).toBe("Strangle");
  });

  it("call + put same strike but opposite sides is NOT a straddle (-> diagonal/loose)", () => {
    // long call + short put, same strike same expiry: not same-side -> not straddle.
    const c = makeHolding({ id: "c", symbol: call(100, EXP_A), quantity: 1 });
    const p = makeHolding({ id: "p", symbol: put(100, EXP_A), quantity: -1 });
    const { strategies, looseLegs } = detectStrategies([c, p], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });

  it("call + put different expiry is not a strangle (-> loose)", () => {
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: 1 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_B), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([c, p], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });
});

describe("stock-based: covered-call / protective-put", () => {
  it("covered call: long 100 shares + short 1 call", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const { strategies, looseLegs } = detectStrategies([stock, c], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies[0].strategyType).toBe("covered-call");
    expect(strategies[0].name).toBe("Covered Call");
    expect(strategies[0].memberCount).toBe(2);
  });

  it("not covered if shares < 100 * short-call contracts (-> loose)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 50 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const { strategies, looseLegs } = detectStrategies([stock, c], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });

  it("protective put: long stock + long put", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([stock, p], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("protective-put");
    expect(strategies[0].name).toBe("Protective Put");
  });

  it("long stock + long call is not covered/protective (-> loose)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([stock, c], NO_OVERRIDES);
    expect(strategies).toHaveLength(0);
    expect(looseLegs).toHaveLength(2);
  });
});

describe("stock-based: collar", () => {
  it("collar: long stock + short call (high strike) + long put (low strike)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([stock, c, p], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("collar");
    expect(strategies[0].name).toBe("Collar");
    expect(strategies[0].memberCount).toBe(3);
  });

  it("collar takes priority over covered-call (does not split into covered + loose put)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(110, EXP_A), quantity: -1 });
    const p = makeHolding({ id: "p", symbol: put(90, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([p, c, stock], NO_OVERRIDES);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("collar");
  });

  it("call strike below put strike is not a collar (-> covered-call + loose put or loose)", () => {
    const stock = makeHolding({ id: "s", symbol: "ASTS", quantity: 100 });
    const c = makeHolding({ id: "c", symbol: call(90, EXP_A), quantity: -1 });
    const p = makeHolding({ id: "p", symbol: put(110, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([stock, c, p], NO_OVERRIDES);
    expect(strategies.some((s) => s.strategyType === "collar")).toBe(false);
  });
});

describe("three-leg: butterfly", () => {
  it("long call butterfly: long 1x K1, short 2x K2, long 1x K3, equidistant", () => {
    const w1 = makeHolding({ id: "w1", symbol: call(90, EXP_A), quantity: 1 });
    const mid = makeHolding({ id: "mid", symbol: call(100, EXP_A), quantity: -2 });
    const w2 = makeHolding({ id: "w2", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies, looseLegs } = detectStrategies([w1, mid, w2], NO_OVERRIDES);
    expect(looseLegs).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategyType).toBe("butterfly");
    expect(strategies[0].name).toBe("Butterfly");
    expect(strategies[0].memberCount).toBe(3);
  });

  it("short put butterfly: short 1x K1, long 2x K2, short 1x K3", () => {
    const w1 = makeHolding({ id: "w1", symbol: put(90, EXP_A), quantity: -1 });
    const mid = makeHolding({ id: "mid", symbol: put(100, EXP_A), quantity: 2 });
    const w2 = makeHolding({ id: "w2", symbol: put(110, EXP_A), quantity: -1 });
    const { strategies } = detectStrategies([w1, mid, w2], NO_OVERRIDES);
    expect(strategies[0].strategyType).toBe("butterfly");
  });

  it("non-equidistant strikes are not a butterfly (-> loose / partial)", () => {
    const w1 = makeHolding({ id: "w1", symbol: call(90, EXP_A), quantity: 1 });
    const mid = makeHolding({ id: "mid", symbol: call(95, EXP_A), quantity: -2 });
    const w2 = makeHolding({ id: "w2", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([w1, mid, w2], NO_OVERRIDES);
    expect(strategies.some((s) => s.strategyType === "butterfly")).toBe(false);
  });

  it("wrong ratio 1:1:1 is not a butterfly", () => {
    const w1 = makeHolding({ id: "w1", symbol: call(90, EXP_A), quantity: 1 });
    const mid = makeHolding({ id: "mid", symbol: call(100, EXP_A), quantity: -1 });
    const w2 = makeHolding({ id: "w2", symbol: call(110, EXP_A), quantity: 1 });
    const { strategies } = detectStrategies([w1, mid, w2], NO_OVERRIDES);
    expect(strategies.some((s) => s.strategyType === "butterfly")).toBe(false);
  });
});

export { makeHolding, call, put, EXP_A, EXP_B, NO_OVERRIDES };
