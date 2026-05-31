import { describe, expect, it } from "vitest";
import type { Holding, StrategyOverride } from "@/lib/types";
import { buildOccSymbol } from "@/lib/occ-symbol";
import { detectStrategies } from "./detect-strategies";

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

export { makeHolding, call, put, EXP_A, EXP_B, NO_OVERRIDES };
