import type { HoldingsPositionInput, NewAssetInput } from "./wealthfolio.js";
import type { ObservedPosition, ClosingPosition } from "./state.js";
import type { OptionPosition, EquityPosition, Holdings } from "./snaptrade.js";

const CCY = "USD";

export function optionMultiplier(p: OptionPosition): number {
  return p.symbol.option_symbol.is_mini_option ? 10 : 100;
}

export function buildOptionAssetSpec(p: OptionPosition): NewAssetInput {
  const o = p.symbol.option_symbol;
  const occ = o.ticker;
  return {
    kind: "INVESTMENT",
    quoteMode: "MANUAL",
    quoteCcy: CCY,
    instrumentType: "OPTION",
    instrumentSymbol: occ,
    displayCode: occ,
    metadata: {
      option: {
        underlyingAssetId: o.underlying_symbol.symbol,
        expiration: o.expiration_date,
        right: o.option_type,
        strike: String(o.strike_price),
        multiplier: String(optionMultiplier(p)),
        occSymbol: occ,
      },
    },
  };
}

export function optionPositionToHoldingsPosition(p: OptionPosition, assetId?: string): HoldingsPositionInput {
  return {
    assetId,
    symbol: p.symbol.option_symbol.ticker,
    quantity: String(p.units),
    avgCost: p.average_purchase_price == null ? undefined : String(p.average_purchase_price),
    currency: CCY,
    instrumentType: "OPTION",
  };
}

export function equityPositionToHoldingsPosition(p: EquityPosition): HoldingsPositionInput {
  return {
    symbol: p.symbol.symbol.symbol,
    quantity: String(p.units),
    avgCost: p.average_purchase_price == null ? undefined : String(p.average_purchase_price),
    currency: CCY,
    instrumentType: "EQUITY",
    exchangeMic: p.symbol.symbol.exchange?.mic_code ?? undefined,
  };
}

export function balancesToCashBalances(balances: Holdings["balances"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of balances) out[b.currency.code] = String(b.cash);
  return out;
}

export function reinjectionToHoldingsPosition(c: ClosingPosition): HoldingsPositionInput {
  return {
    symbol: c.occSymbol ?? c.contractDescription,
    quantity: c.quantity,
    avgCost: c.kind === "EXPIRED" ? c.avgCost : "0",
    currency: c.currency,
    instrumentType: c.instrumentType,
  };
}

export function snaptradePositionToObserved(
  p: OptionPosition | EquityPosition,
  key: string,
): ObservedPosition {
  const sym = p.symbol as Record<string, unknown>;
  if ("option_symbol" in sym) {
    const o = (p as OptionPosition).symbol.option_symbol;
    return {
      key,
      contractDescription: o.ticker,
      occSymbol: o.ticker,
      instrumentType: "OPTION",
      expiration: o.expiration_date,
      quantity: String(p.units),
      avgCost: p.average_purchase_price == null ? "0" : String(p.average_purchase_price),
      currency: CCY,
    };
  }
  const e = p as EquityPosition;
  return {
    key,
    contractDescription: e.symbol.symbol.symbol,
    occSymbol: null,
    instrumentType: "EQUITY",
    expiration: null,
    quantity: String(p.units),
    avgCost: p.average_purchase_price == null ? "0" : String(p.average_purchase_price),
    currency: CCY,
  };
}
