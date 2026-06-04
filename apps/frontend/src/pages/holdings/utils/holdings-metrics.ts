import { parseOccSymbol } from "@/lib/occ-symbol";
import type { Holding } from "@/lib/types";
import type { HoldingGroupRow } from "./group-by-underlying";
import type { StrategyGroupRow } from "./detect-strategies";

export type MetricColumnId =
  | "marketValue"
  | "priceAvgCost"
  | "day"
  | "unrealized"
  | "realized"
  | "holding"
  | "weight";

export interface MetricColumn {
  id: MetricColumnId;
  /** Short header label (Futu-style). */
  label: string;
  /** Whether the column is visible before the user opens the show/hide menu. */
  defaultVisible: boolean;
  /** Only the Unrealized column renders a percent under its amount. */
  showPct: boolean;
  /** Whether the top amount is colored green/red by sign (P&L columns only). */
  colorFormat: boolean;

  // Leaf-row (Holding) accessors. `leafTop` is required; bottom/pct optional.
  leafTop: (h: Holding) => number;
  leafBottom?: (h: Holding) => number;
  leafPct?: (h: Holding) => number | null;

  // Underlying group-row accessors (blank where the cell should be empty).
  groupTop?: (g: HoldingGroupRow) => number | null;
  groupPct?: (g: HoldingGroupRow) => number | null;

  // Strategy group-row accessors.
  strategyTop?: (s: StrategyGroupRow) => number | null;
  strategyPct?: (s: StrategyGroupRow) => number | null;
}

const local = (m: { local: number } | null | undefined): number => m?.local ?? 0;

/** Average cost per share/contract: costBasis.local / (quantity * (multiplier || 1)). */
export function leafAvgCost(h: Holding): number {
  const isOption = parseOccSymbol(h.instrument?.symbol ?? h.id) !== null;
  const multiplier = isOption ? (h.contractMultiplier ?? 100) : 1;
  const denom = h.quantity * multiplier;
  if (denom === 0) return 0;
  return local(h.costBasis) / denom;
}

const pctOrNull = (numer: number, denom: number): number | null =>
  denom !== 0 ? numer / Math.abs(denom) : null;

export const HOLDING_METRIC_COLUMNS: MetricColumn[] = [
  {
    id: "marketValue",
    label: "MktVal / Qty",
    defaultVisible: true,
    showPct: false,
    colorFormat: false,
    leafTop: (h) => local(h.marketValue),
    leafBottom: (h) => h.quantity,
    groupTop: (g) => g.marketValueBase,
    strategyTop: (s) => s.marketValueBase,
  },
  {
    id: "priceAvgCost",
    label: "Price / AvgCost",
    defaultVisible: true,
    showPct: false,
    colorFormat: false,
    leafTop: (h) => h.price ?? 0,
    leafBottom: (h) => leafAvgCost(h),
    // Underlying group shows the underlying price; strategy group is blank.
    groupTop: (g) => g.underlyingPrice,
    strategyTop: () => null,
  },
  {
    id: "day",
    label: "Day",
    defaultVisible: true,
    showPct: false,
    colorFormat: true,
    leafTop: (h) => local(h.dayChange),
    groupTop: (g) => g.dayChangeBase,
    strategyTop: (s) => s.dayChangeBase,
  },
  {
    id: "unrealized",
    label: "Unrealized",
    defaultVisible: false,
    showPct: true,
    colorFormat: true,
    leafTop: (h) => local(h.unrealizedGain),
    leafPct: (h) => pctOrNull(local(h.unrealizedGain), local(h.costBasis)),
    groupTop: (g) => g.unrealizedGainBase,
    groupPct: (g) => pctOrNull(g.unrealizedGainBase, g.costBasisBase),
    strategyTop: (s) => s.unrealizedGainBase,
    strategyPct: (s) => pctOrNull(s.unrealizedGainBase, s.costBasisBase),
  },
  {
    id: "realized",
    label: "Realized",
    defaultVisible: false,
    showPct: false,
    colorFormat: true,
    leafTop: (h) => local(h.realizedGain),
    groupTop: (g) => g.realizedGainBase,
    strategyTop: (s) => s.realizedGainBase,
  },
  {
    id: "holding",
    label: "Holding P&L",
    defaultVisible: false,
    showPct: false,
    colorFormat: true,
    leafTop: (h) => local(h.totalGain),
    groupTop: (g) => g.totalGainBase,
    strategyTop: (s) => s.totalGainBase,
  },
  {
    id: "weight",
    label: "Weight",
    defaultVisible: false,
    showPct: false,
    colorFormat: false,
    leafTop: (h) => h.weight,
    groupTop: (g) => g.weight,
    strategyTop: (s) => s.weight,
  },
];

const BY_ID = new Map<MetricColumnId, MetricColumn>(
  HOLDING_METRIC_COLUMNS.map((c) => [c.id, c]),
);

export function getMetricColumn(id: MetricColumnId): MetricColumn {
  const col = BY_ID.get(id);
  if (!col) throw new Error(`Unknown metric column: ${id}`);
  return col;
}
