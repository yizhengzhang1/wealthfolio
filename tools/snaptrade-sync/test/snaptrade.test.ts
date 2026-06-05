import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseHoldings } from "../src/snaptrade.js";

const raw = JSON.parse(readFileSync(new URL("./fixtures/holdings.json", import.meta.url), "utf8"));

describe("parseHoldings", () => {
  it("parses positions, option_positions, balances", () => {
    const h = parseHoldings(raw);
    expect(h.positions).toHaveLength(1);
    expect(h.option_positions).toHaveLength(2);
    expect(h.balances[0].currency.code).toBe("USD");
  });
  it("keeps option metadata and signed units", () => {
    const h = parseHoldings(raw);
    const short = h.option_positions.find(o => o.symbol.option_symbol.ticker.startsWith("HSAI"))!;
    expect(short.units).toBe(-2);
    expect(short.symbol.option_symbol.option_type).toBe("PUT");
    expect(short.symbol.option_symbol.is_mini_option).toBe(false);
  });
  it("tolerates missing optional arrays", () => {
    expect(parseHoldings({ positions: [] }).option_positions).toEqual([]);
  });
});
