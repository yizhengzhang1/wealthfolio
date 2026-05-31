import { parseOccSymbol } from "@/lib/occ-symbol";
import type { Holding, StrategyGroupRow, StrategyOverride, StrategyType } from "@/lib/types";

/** Per-leg features extracted once up front. */
interface LegFeature {
  holding: Holding;
  symbol: string;
  /** OCC parse result, or null for a stock leg. */
  occ: ReturnType<typeof parseOccSymbol>;
  isOption: boolean;
  isStock: boolean;
  /** signed: >0 long, <0 short. */
  quantity: number;
  isLong: boolean;
  isShort: boolean;
  /** contractMultiplier ?? 100 for options; 1 for stock. */
  multiplier: number;
}

/** Default display label per StrategyType (English; direction-aware vertical labels are produced separately). */
const STRATEGY_LABELS: Record<StrategyType, string> = {
  vertical: "Vertical Spread",
  calendar: "Calendar Spread",
  diagonal: "Diagonal Spread",
  straddle: "Straddle",
  strangle: "Strangle",
  "covered-call": "Covered Call",
  "protective-put": "Protective Put",
  collar: "Collar",
  butterfly: "Butterfly",
  "iron-condor": "Iron Condor",
  "iron-butterfly": "Iron Butterfly",
  custom: "Custom Strategy",
};

export function defaultStrategyLabel(type: StrategyType): string {
  return STRATEGY_LABELS[type];
}

function symbolOf(h: Holding): string {
  return h.instrument?.symbol ?? h.id;
}

export function extractFeature(h: Holding, underlyingKey: string): LegFeature {
  const symbol = symbolOf(h);
  const occ = parseOccSymbol(symbol);
  const isOption = occ !== null;
  const isStock = !isOption && symbol === underlyingKey;
  const quantity = h.quantity ?? 0;
  return {
    holding: h,
    symbol,
    occ,
    isOption,
    isStock,
    quantity,
    isLong: quantity > 0,
    isShort: quantity < 0,
    multiplier: isOption ? (h.contractMultiplier ?? 100) : 1,
  };
}

/** Derive the underlying key from the first parseable OCC leg, else the first symbol. */
function deriveUnderlyingKey(legs: Holding[]): string {
  for (const h of legs) {
    const occ = parseOccSymbol(symbolOf(h));
    if (occ) return occ.underlying;
  }
  return legs.length > 0 ? symbolOf(legs[0]) : "";
}

export function detectStrategies(
  legs: Holding[],
  _overrides: StrategyOverride[],
): { strategies: StrategyGroupRow[]; looseLegs: Holding[] } {
  if (legs.length === 0) return { strategies: [], looseLegs: [] };
  const underlyingKey = deriveUnderlyingKey(legs);
  void underlyingKey;
  // Stub: implemented incrementally in later tasks.
  return { strategies: [], looseLegs: [...legs] };
}
