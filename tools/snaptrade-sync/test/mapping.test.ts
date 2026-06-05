import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseHoldings } from "../src/snaptrade.js";
import {
  optionPositionToHoldingsPosition, buildOptionAssetSpec,
  equityPositionToHoldingsPosition, balancesToCashBalances, optionMultiplier,
  snaptradePositionToObserved, reinjectionToHoldingsPosition,
} from "../src/mapping.js";

const h = parseHoldings(JSON.parse(readFileSync(new URL("./fixtures/holdings.json", import.meta.url), "utf8")));
const call = h.option_positions.find(o => o.symbol.option_symbol.ticker.startsWith("MSFT"))!;
const shortPut = h.option_positions.find(o => o.symbol.option_symbol.ticker.startsWith("HSAI"))!;
const eq = h.positions[0];

describe("optionMultiplier", () => {
  it("100 standard, 10 mini", () => {
    expect(optionMultiplier(call)).toBe(100);
    expect(optionMultiplier({ ...call, symbol: { option_symbol: { ...call.symbol.option_symbol, is_mini_option: true } } } as any)).toBe(10);
  });
});

describe("optionPositionToHoldingsPosition", () => {
  it("maps OCC/qty/avgCost, signed short, binds assetId", () => {
    expect(optionPositionToHoldingsPosition(shortPut, "asset-uuid-1")).toMatchObject({
      assetId: "asset-uuid-1", symbol: "HSAI  260618P00020000",
      quantity: "-2", avgCost: "0.99335", currency: "USD", instrumentType: "OPTION",
    });
  });
});

describe("buildOptionAssetSpec", () => {
  it("builds option asset with metadata + multiplier", () => {
    const spec = buildOptionAssetSpec(call);
    expect(spec).toMatchObject({
      quoteMode: "MANUAL", quoteCcy: "USD", instrumentType: "OPTION",
      instrumentSymbol: "MSFT  270115C00500000",
    });
    expect(spec.metadata!.option).toMatchObject({
      underlyingAssetId: "MSFT", expiration: "2027-01-15", right: "CALL",
      strike: "500", multiplier: "100", occSymbol: "MSFT  270115C00500000",
    });
  });
});

describe("equityPositionToHoldingsPosition", () => {
  it("maps symbol/qty/avgCost/mic", () => {
    expect(equityPositionToHoldingsPosition(eq)).toMatchObject({
      symbol: "TSLA", quantity: "100", avgCost: "250.1", currency: "USD",
      instrumentType: "EQUITY", exchangeMic: "XNAS",
    });
  });
});

describe("balancesToCashBalances", () => {
  it("maps per-currency cash", () => {
    expect(balancesToCashBalances(h.balances)).toEqual({ USD: "46575.75" });
  });
});

describe("snaptradePositionToObserved", () => {
  it("option -> OPTION observed (key=OCC, occSymbol, expiry, signed qty)", () => {
    expect(snaptradePositionToObserved(shortPut, shortPut.symbol.option_symbol.ticker)).toMatchObject({
      key: "HSAI  260618P00020000", instrumentType: "OPTION",
      occSymbol: "HSAI  260618P00020000", expiration: "2026-06-18", quantity: "-2", currency: "USD",
    });
  });
  it("equity -> EQUITY observed (occSymbol null)", () => {
    expect(snaptradePositionToObserved(eq, eq.symbol.symbol.symbol)).toMatchObject({
      key: "TSLA", instrumentType: "EQUITY", occSymbol: null, expiration: null, quantity: "100",
    });
  });
});

describe("reinjectionToHoldingsPosition", () => {
  const base = {
    key: "X", contractDescription: "X", occSymbol: "MSFT  270115C00500000",
    instrumentType: "OPTION" as const, expiration: "2027-01-15",
    quantity: "1", avgCost: "30.0066", currency: "USD",
    lastSeenDate: "2026-06-04", closedDate: "2026-06-05",
  };
  it("EXPIRED keeps avgCost", () => {
    expect(reinjectionToHoldingsPosition({ ...base, kind: "EXPIRED" })).toMatchObject({
      symbol: "MSFT  270115C00500000", quantity: "1", avgCost: "30.0066", instrumentType: "OPTION",
    });
  });
  it("CLOSED zeroes avgCost", () => {
    expect(reinjectionToHoldingsPosition({ ...base, kind: "CLOSED" }).avgCost).toBe("0");
  });
});
