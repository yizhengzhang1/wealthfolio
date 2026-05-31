import { parseOccSymbol } from "@/lib/occ-symbol";
import type { Holding } from "@/lib/types";

export interface HoldingGroupRow {
  kind: "group";
  id: string;
  underlyingKey: string;
  underlyingSymbol: string;
  underlyingName: string | null;
  memberCount: number;
  underlyingPrice: number | null;
  baseCurrency: string;
  marketValueBase: number;
  costBasisBase: number;
  totalGainBase: number;
  totalGainPct: number | null;
  dayChangeBase: number;
  dayChangePct: number | null;
  weight: number;
  subRows: Holding[];
}

export type HoldingRow = HoldingGroupRow | Holding;

export function isHoldingGroupRow(row: HoldingRow): row is HoldingGroupRow {
  return (row as HoldingGroupRow).kind === "group";
}

export function getUnderlyingKey(holding: Holding): string {
  const symbol = holding.instrument?.symbol ?? holding.id;
  const parsed = parseOccSymbol(symbol);
  return parsed ? parsed.underlying : symbol;
}

export function groupHoldingsByUnderlying(holdings: Holding[]): HoldingRow[] {
  // Map 保留首次出现顺序,输出确定。
  const buckets = new Map<string, Holding[]>();
  for (const holding of holdings) {
    const key = getUnderlyingKey(holding);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(holding);
    else buckets.set(key, [holding]);
  }

  const rows: HoldingRow[] = [];
  for (const [key, members] of buckets) {
    if (members.length < 2) {
      rows.push(members[0]);
    } else {
      rows.push(buildGroupRow(key, members));
    }
  }
  return rows;
}

function buildGroupRow(underlyingKey: string, members: Holding[]): HoldingGroupRow {
  const stock = members.find((h) => (h.instrument?.symbol ?? h.id) === underlyingKey);

  let marketValueBase = 0;
  let costBasisBase = 0;
  let totalGainBase = 0;
  let dayChangeBase = 0;
  let prevCloseBase = 0;
  let weight = 0;
  for (const h of members) {
    marketValueBase += h.marketValue?.base ?? 0;
    costBasisBase += h.costBasis?.base ?? 0;
    totalGainBase += h.totalGain?.base ?? 0;
    dayChangeBase += h.dayChange?.base ?? 0;
    prevCloseBase += h.prevCloseValue?.base ?? 0;
    weight += h.weight ?? 0;
  }

  return {
    kind: "group",
    id: `group:${underlyingKey}`,
    underlyingKey,
    underlyingSymbol: underlyingKey,
    underlyingName: stock?.instrument?.name ?? null,
    memberCount: members.length,
    underlyingPrice: stock?.price ?? null,
    // All holdings in a given scope share the same base currency, so taking the
    // first member's is safe; aggregates above are summed in base currency.
    baseCurrency: members[0].baseCurrency,
    marketValueBase,
    costBasisBase,
    totalGainBase,
    totalGainPct: costBasisBase !== 0 ? totalGainBase / Math.abs(costBasisBase) : null,
    dayChangeBase,
    dayChangePct: prevCloseBase !== 0 ? dayChangeBase / Math.abs(prevCloseBase) : null,
    weight,
    subRows: members,
  };
}
