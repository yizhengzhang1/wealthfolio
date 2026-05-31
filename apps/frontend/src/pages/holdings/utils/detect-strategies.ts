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

/** Build the sorted leg key: leg OCC/symbols sorted then join('|'). */
function legKeyOf(legs: Holding[]): string {
  return legs
    .map((h) => h.instrument?.symbol ?? h.id)
    .sort()
    .join("|");
}

/**
 * Aggregate a set of legs into a StrategyGroupRow (spec section 7).
 * Base-currency sums; pct = sum / |denom|, null when denom is 0;
 * netCashBase = Σ costBasisBase.
 */
export function buildStrategyRow(
  underlyingKey: string,
  strategyType: StrategyType,
  name: string,
  source: "auto" | "override",
  legs: Holding[],
  overrideId?: string,
): StrategyGroupRow {
  let marketValueBase = 0;
  let costBasisBase = 0;
  let totalGainBase = 0;
  let dayChangeBase = 0;
  let prevCloseBase = 0;
  let weight = 0;
  for (const h of legs) {
    marketValueBase += h.marketValue?.base ?? 0;
    costBasisBase += h.costBasis?.base ?? 0;
    totalGainBase += h.totalGain?.base ?? 0;
    dayChangeBase += h.dayChange?.base ?? 0;
    prevCloseBase += h.prevCloseValue?.base ?? 0;
    weight += h.weight ?? 0;
  }

  return {
    kind: "strategy",
    id: `strategy:${underlyingKey}:${legKeyOf(legs)}`,
    underlyingKey,
    strategyType,
    name,
    source,
    overrideId,
    memberCount: legs.length,
    baseCurrency: legs[0].baseCurrency,
    marketValueBase,
    costBasisBase,
    totalGainBase,
    totalGainPct: costBasisBase !== 0 ? totalGainBase / Math.abs(costBasisBase) : null,
    dayChangeBase,
    dayChangePct: prevCloseBase !== 0 ? dayChangeBase / Math.abs(prevCloseBase) : null,
    weight,
    netCashBase: costBasisBase,
    subRows: legs,
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

function isOptionPairOppositeSides(a: LegFeature, b: LegFeature): boolean {
  return a.isOption && b.isOption && ((a.isLong && b.isShort) || (a.isShort && b.isLong));
}

/** Direction label for a vertical: uniform for call/put — long lower=bull, long higher=bear. */
function verticalLabel(a: LegFeature, b: LegFeature): string {
  const long = a.isLong ? a : b;
  const short = a.isLong ? b : a;
  const isCall = long.occ!.optionType === "CALL";
  const bull = long.occ!.strikePrice < short.occ!.strikePrice;
  if (isCall) return bull ? "Bull Call Spread" : "Bear Call Spread";
  return bull ? "Bull Put Spread" : "Bear Put Spread";
}

/** Try to classify a same-type, opposite-side option pair. Returns null if not a 2-leg spread. */
function classifyVerticalFamily(
  a: LegFeature,
  b: LegFeature,
): { type: StrategyType; name: string } | null {
  if (!isOptionPairOppositeSides(a, b)) return null;
  if (a.occ!.optionType !== b.occ!.optionType) return null;
  const sameStrike = a.occ!.strikePrice === b.occ!.strikePrice;
  const sameExpiry = a.occ!.expiration === b.occ!.expiration;
  if (!sameStrike && sameExpiry) return { type: "vertical", name: verticalLabel(a, b) };
  if (sameStrike && !sameExpiry) return { type: "calendar", name: defaultStrategyLabel("calendar") };
  if (!sameStrike && !sameExpiry) return { type: "diagonal", name: defaultStrategyLabel("diagonal") };
  return null; // same strike & same expiry of same type & opposite sides => degenerate, skip
}

function bothSameSide(a: LegFeature, b: LegFeature): boolean {
  return (a.isLong && b.isLong) || (a.isShort && b.isShort);
}

/** Try call+put same-side pair -> straddle / strangle. */
function classifyStraddleFamily(
  a: LegFeature,
  b: LegFeature,
): { type: StrategyType; name: string } | null {
  if (!a.isOption || !b.isOption) return null;
  if (a.occ!.optionType === b.occ!.optionType) return null; // need one call + one put
  if (!bothSameSide(a, b)) return null;
  if (a.occ!.expiration !== b.occ!.expiration) return null; // both straddle & strangle need same expiry
  const sameStrike = a.occ!.strikePrice === b.occ!.strikePrice;
  return sameStrike
    ? { type: "straddle", name: defaultStrategyLabel("straddle") }
    : { type: "strangle", name: defaultStrategyLabel("strangle") };
}

/** Try long-stock + 1 option -> covered-call / protective-put. */
function classifyStockPlusOne(
  stock: LegFeature,
  opt: LegFeature,
): { type: StrategyType; name: string } | null {
  if (!stock.isStock || !stock.isLong || !opt.isOption) return null;
  const sharesPerContract = opt.multiplier; // 100 by default
  const requiredShares = sharesPerContract * Math.abs(opt.quantity);
  if (opt.occ!.optionType === "CALL" && opt.isShort && stock.quantity >= requiredShares) {
    return { type: "covered-call", name: defaultStrategyLabel("covered-call") };
  }
  if (opt.occ!.optionType === "PUT" && opt.isLong) {
    return { type: "protective-put", name: defaultStrategyLabel("protective-put") };
  }
  return null;
}

/** Try long-stock + short-call(high) + long-put(low) -> collar. */
function classifyCollar(
  stock: LegFeature,
  callLeg: LegFeature,
  putLeg: LegFeature,
): boolean {
  if (!stock.isStock || !stock.isLong) return false;
  if (!callLeg.isOption || callLeg.occ!.optionType !== "CALL" || !callLeg.isShort) return false;
  if (!putLeg.isOption || putLeg.occ!.optionType !== "PUT" || !putLeg.isLong) return false;
  return callLeg.occ!.strikePrice > putLeg.occ!.strikePrice;
}

/** Try 3 same-type same-expiry options -> butterfly (1:2:1, equidistant, mid opposite sign). */
function classifyButterfly(legs: LegFeature[]): boolean {
  if (legs.length !== 3) return false;
  if (!legs.every((f) => f.isOption)) return false;
  const type = legs[0].occ!.optionType;
  if (!legs.every((f) => f.occ!.optionType === type)) return false;
  const exp = legs[0].occ!.expiration;
  if (!legs.every((f) => f.occ!.expiration === exp)) return false;
  const sorted = [...legs].sort((a, b) => a.occ!.strikePrice - b.occ!.strikePrice);
  const [k1, k2, k3] = sorted.map((f) => f.occ!.strikePrice);
  if (k1 === k2 || k2 === k3) return false; // need 3 distinct strikes
  if (k2 - k1 !== k3 - k2) return false; // equidistant
  const [q1, q2, q3] = sorted.map((f) => f.quantity);
  // 1:2:1 with middle opposite-signed: q1 == q3, q2 == -2*q1, |q1| == 1 ratio.
  if (q1 !== q3) return false;
  if (q1 === 0) return false;
  return q2 === -2 * q1;
}

/** Try 4 same-expiry options -> iron-condor / iron-butterfly. Returns the type or null. */
function classifyIron(legs: LegFeature[]): StrategyType | null {
  if (legs.length !== 4) return null;
  if (!legs.every((f) => f.isOption)) return null;
  const exp = legs[0].occ!.expiration;
  if (!legs.every((f) => f.occ!.expiration === exp)) return null;

  const puts = legs.filter((f) => f.occ!.optionType === "PUT");
  const calls = legs.filter((f) => f.occ!.optionType === "CALL");
  if (puts.length !== 2 || calls.length !== 2) return null;

  const longPut = puts.find((f) => f.isLong);
  const shortPut = puts.find((f) => f.isShort);
  const longCall = calls.find((f) => f.isLong);
  const shortCall = calls.find((f) => f.isShort);
  if (!longPut || !shortPut || !longCall || !shortCall) return null;

  // long put is the lowest, long call the highest; shorts in the middle.
  if (!(longPut.occ!.strikePrice < shortPut.occ!.strikePrice)) return null;
  if (!(shortCall.occ!.strikePrice < longCall.occ!.strikePrice)) return null;
  // all put strikes < all call strikes
  const maxPut = Math.max(longPut.occ!.strikePrice, shortPut.occ!.strikePrice);
  const minCall = Math.min(longCall.occ!.strikePrice, shortCall.occ!.strikePrice);
  if (!(maxPut <= minCall)) return null;

  // iron butterfly: short put and short call share the same middle strike
  if (shortPut.occ!.strikePrice === shortCall.occ!.strikePrice) return "iron-butterfly";
  // iron condor: strict separation (short put < short call)
  if (shortPut.occ!.strikePrice < shortCall.occ!.strikePrice) return "iron-condor";
  return null;
}

export function detectStrategies(
  legs: Holding[],
  _overrides: StrategyOverride[],
): { strategies: StrategyGroupRow[]; looseLegs: Holding[] } {
  if (legs.length === 0) return { strategies: [], looseLegs: [] };
  const underlyingKey = deriveUnderlyingKey(legs);
  const pool: LegFeature[] = legs.map((h) => extractFeature(h, underlyingKey));
  const consumed = new Set<LegFeature>();
  const strategies: StrategyGroupRow[] = [];

  const avail = () => pool.filter((f) => !consumed.has(f));

  // ---- iron-condor / iron-butterfly: 4 same-expiry options ------------
  {
    const opts = avail().filter((f) => f.isOption);
    outerIron: for (let a = 0; a < opts.length; a++) {
      for (let b = a + 1; b < opts.length; b++) {
        for (let c = b + 1; c < opts.length; c++) {
          for (let d = c + 1; d < opts.length; d++) {
            const quad = [opts[a], opts[b], opts[c], opts[d]];
            if (quad.some((f) => consumed.has(f))) continue;
            const type = classifyIron(quad);
            if (type) {
              quad.forEach((f) => consumed.add(f));
              strategies.push(
                buildStrategyRow(
                  underlyingKey,
                  type,
                  defaultStrategyLabel(type),
                  "auto",
                  quad.map((f) => f.holding),
                ),
              );
              continue outerIron;
            }
          }
        }
      }
    }
  }

  // ---- butterfly: 3 same-type same-expiry options, 1:2:1 equidistant ---
  {
    const opts = avail().filter((f) => f.isOption);
    outer: for (let i = 0; i < opts.length; i++) {
      for (let j = i + 1; j < opts.length; j++) {
        for (let k = j + 1; k < opts.length; k++) {
          const trio = [opts[i], opts[j], opts[k]];
          if (trio.some((f) => consumed.has(f))) continue;
          if (classifyButterfly(trio)) {
            trio.forEach((f) => consumed.add(f));
            strategies.push(
              buildStrategyRow(
                underlyingKey,
                "butterfly",
                defaultStrategyLabel("butterfly"),
                "auto",
                trio.map((f) => f.holding),
              ),
            );
            continue outer;
          }
        }
      }
    }
  }

  // ---- 2-leg verticals / calendars / diagonals -------------------------
  for (let i = 0; i < pool.length; i++) {
    if (consumed.has(pool[i])) continue;
    for (let j = i + 1; j < pool.length; j++) {
      if (consumed.has(pool[j])) continue;
      const hit = classifyVerticalFamily(pool[i], pool[j]) ?? classifyStraddleFamily(pool[i], pool[j]);
      if (hit) {
        consumed.add(pool[i]);
        consumed.add(pool[j]);
        strategies.push(
          buildStrategyRow(
            underlyingKey,
            hit.type,
            hit.name,
            "auto",
            [pool[i].holding, pool[j].holding],
          ),
        );
        break;
      }
    }
  }

  // ---- collar: stock + short call(high) + long put(low) ----------------
  for (let i = 0; i < pool.length; i++) {
    if (consumed.has(pool[i]) || !pool[i].isStock || !pool[i].isLong) continue;
    const calls = pool.filter((f) => !consumed.has(f) && f.isOption && f.occ!.optionType === "CALL" && f.isShort);
    const puts = pool.filter((f) => !consumed.has(f) && f.isOption && f.occ!.optionType === "PUT" && f.isLong);
    let matched = false;
    for (const c of calls) {
      for (const p of puts) {
        if (classifyCollar(pool[i], c, p)) {
          consumed.add(pool[i]);
          consumed.add(c);
          consumed.add(p);
          strategies.push(
            buildStrategyRow(underlyingKey, "collar", defaultStrategyLabel("collar"), "auto", [
              pool[i].holding,
              c.holding,
              p.holding,
            ]),
          );
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  // ---- stock + 1 option: covered-call / protective-put ----------------
  for (let i = 0; i < pool.length; i++) {
    if (consumed.has(pool[i]) || !pool[i].isStock || !pool[i].isLong) continue;
    for (let j = 0; j < pool.length; j++) {
      if (j === i || consumed.has(pool[j]) || !pool[j].isOption) continue;
      const hit = classifyStockPlusOne(pool[i], pool[j]);
      if (hit) {
        consumed.add(pool[i]);
        consumed.add(pool[j]);
        strategies.push(
          buildStrategyRow(underlyingKey, hit.type, hit.name, "auto", [
            pool[i].holding,
            pool[j].holding,
          ]),
        );
        break;
      }
    }
  }

  const looseLegs = avail().map((f) => f.holding);
  return { strategies, looseLegs };
}
