import { TickerAvatar } from "@/components/ticker-avatar";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { Account, AccountScope, Holding } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AmountDisplay, Badge, GainPercent, Input } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { groupHoldingsByUnderlying, isHoldingGroupRow, type HoldingGroupRow, type HoldingRow } from "../utils/group-by-underlying";
import { isStrategyGroupRow, type StrategyGroupRow } from "../utils/detect-strategies";
import { useOptionStrategies } from "@/hooks/use-option-strategies";
import { HoldingsMobileFilterSheet } from "./holdings-mobile-filter-sheet";
import { HOLDING_METRIC_COLUMNS, type MetricColumn } from "../utils/holdings-metrics";

interface HoldingsTableMobileProps {
  holdings: Holding[];
  isLoading: boolean;
  selectedTypes: string[];
  setSelectedTypes: (types: string[]) => void;
  accountFilter: AccountScope;
  onAccountScopeChange: (filter: AccountScope) => void;
  accounts: Account[];
  portfolios: { id: string; name: string }[];
  showAccountScope?: boolean;
  showSearch?: boolean;
  showFilterButton?: boolean;
  sortBy?: "symbol" | "marketValue";
  setSortBy?: (value: "symbol" | "marketValue") => void;
  showTotalReturn?: boolean;
  setShowTotalReturn?: (value: boolean) => void;
  typeOptions?: { value: string; label: string }[];
}

interface MetricValues { top: number | null; bottom?: number | null; pct?: number | null }

function MetricStrip({
  resolve,
  currency,
  isHidden,
  showHeader,
}: {
  resolve: (m: MetricColumn) => MetricValues;
  currency: string;
  isHidden: boolean;
  showHeader: boolean;
}) {
  return (
    <div className="flex">
      {HOLDING_METRIC_COLUMNS.map((m) => {
        const v = resolve(m);
        return (
          <div key={m.id} className="flex min-w-[88px] flex-col items-end px-2 text-right">
            {showHeader && <span className="text-muted-foreground text-[10px]">{m.label}</span>}
            {v.top == null ? (
              <span className="text-xs text-transparent">-</span>
            ) : (
              <AmountDisplay value={v.top} currency={currency} colorFormat={m.colorFormat} isHidden={isHidden} className="text-sm" />
            )}
            {m.showPct && v.pct != null ? (
              <GainPercent className="text-[10px]" value={v.pct} />
            ) : v.bottom != null ? (
              <span className="text-muted-foreground text-[10px]">{v.bottom}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export const HoldingsTableMobile = ({
  holdings,
  isLoading,
  selectedTypes,
  setSelectedTypes,
  accountFilter,
  onAccountScopeChange,
  accounts,
  portfolios,
  showAccountScope = true,
  showSearch = true,
  showFilterButton = true,
  sortBy: controlledSortBy,
  setSortBy: controlledSetSortBy,
  showTotalReturn: _showTotalReturn,
  setShowTotalReturn: _setShowTotalReturn,
  typeOptions,
}: HoldingsTableMobileProps) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  // Internal state for uncontrolled mode
  const [internalSortBy, setInternalSortBy] = useState<"symbol" | "marketValue">("marketValue");

  const sortBy = controlledSortBy ?? internalSortBy;
  const setSortBy = controlledSetSortBy ?? setInternalSortBy;

  const [groupByUnderlying, setGroupByUnderlying] = usePersistentState<boolean>(
    "holdings-mobile:group-by-underlying",
    true,
  );
  const [expandedKeys, setExpandedKeys] = usePersistentState<string[]>("holdings-mobile:expanded", []);
  const toggleExpand = (key: string) =>
    setExpandedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const [groupByStrategy, setGroupByStrategy] = usePersistentState<boolean>(
    "holdings-mobile:group-by-strategy",
    true,
  );
  const [expandedStrategies, setExpandedStrategies] = usePersistentState<string[]>(
    "holdings-mobile:expanded-strategies",
    [],
  );
  const toggleStrategy = (id: string) =>
    setExpandedStrategies((prev) =>
      prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id],
    );
  const accountIds = useMemo(
    () => Array.from(new Set(holdings.map((h) => h.accountId).filter(Boolean) as string[])),
    [holdings],
  );
  const { data: overrides = [] } = useOptionStrategies(accountIds);

  const hasActiveFilters = useMemo(() => {
    const hasAccountScope = showAccountScope && accountFilter.type !== "all";
    const hasTypeFilter = selectedTypes.length > 0;
    return hasAccountScope || hasTypeFilter;
  }, [accountFilter, selectedTypes, showAccountScope]);

  const filteredHoldings = useMemo(() => {
    let result = [...holdings];

    if (selectedTypes.length > 0) {
      result = result.filter((holding) => {
        const assetType = holding.instrument?.classifications?.assetType?.name;
        return assetType && selectedTypes.includes(assetType);
      });
    }

    if (searchQuery) {
      const lowercasedQuery = searchQuery.toLowerCase();
      result = result.filter((holding) => {
        const nameMatch = holding.instrument?.name?.toLowerCase().includes(lowercasedQuery);
        const symbolMatch = holding.instrument?.symbol?.toLowerCase().includes(lowercasedQuery);

        return nameMatch || symbolMatch;
      });
    }

    return result.sort((a, b) => {
      if (sortBy === "marketValue") {
        const valA = a.marketValue?.base ?? 0;
        const valB = b.marketValue?.base ?? 0;
        return valB - valA; // Descending
      }

      const symbolA = a.instrument?.symbol?.toLowerCase() ?? "";
      const symbolB = b.instrument?.symbol?.toLowerCase() ?? "";
      if (symbolA && symbolB) {
        return symbolA.localeCompare(symbolB);
      }
      if (symbolA) {
        return -1;
      }
      if (symbolB) {
        return 1;
      }
      return 0;
    });
  }, [holdings, selectedTypes, searchQuery, sortBy]);

  const rows: HoldingRow[] = useMemo(() => {
    if (!groupByUnderlying) return filteredHoldings;
    const grouped = groupHoldingsByUnderlying(filteredHoldings, { groupByStrategy, overrides });
    const marketValueOf = (r: HoldingRow) =>
      isHoldingGroupRow(r) || isStrategyGroupRow(r) ? r.marketValueBase : (r.marketValue?.base ?? 0);
    const symbolOf = (r: HoldingRow) =>
      isHoldingGroupRow(r)
        ? r.underlyingSymbol
        : isStrategyGroupRow(r)
          ? r.underlyingKey
          : (r.instrument?.symbol ?? r.id);
    const sorted = [...grouped].sort((a, b) => {
      if (sortBy === "marketValue") {
        return marketValueOf(b) - marketValueOf(a);
      }
      return symbolOf(a).toLowerCase().localeCompare(symbolOf(b).toLowerCase());
    });
    for (const r of sorted) {
      if (isHoldingGroupRow(r)) {
        r.subRows.sort((x, y) => {
          const sx = isStrategyGroupRow(x) ? x.name : x.instrument?.symbol ?? x.id;
          const sy = isStrategyGroupRow(y) ? y.name : y.instrument?.symbol ?? y.id;
          return sx.localeCompare(sy);
        });
      }
    }
    return sorted;
  }, [filteredHoldings, groupByUnderlying, sortBy, groupByStrategy, overrides]);

  const handleNavigate = (holding: Holding) => {
    const assetId = holding.instrument?.id;
    if (assetId && !assetId.startsWith("$CASH")) {
      navigate(`/holdings/${encodeURIComponent(assetId)}`, { state: { holding } });
    }
  };

  const resolveLeaf = (h: Holding) => (m: MetricColumn): MetricValues => ({
    top: m.leafTop(h),
    bottom: m.leafBottom?.(h),
    pct: m.leafPct?.(h),
  });
  const resolveGroup = (g: HoldingGroupRow) => (m: MetricColumn): MetricValues => ({
    top: m.groupTop ? m.groupTop(g) : null,
    pct: m.groupPct?.(g),
  });
  const resolveStrategy = (s: StrategyGroupRow) => (m: MetricColumn): MetricValues => ({
    top: m.strategyTop ? m.strategyTop(s) : null,
    pct: m.strategyPct?.(s),
  });

  const renderLeafRow = (holding: Holding) => {
    const symbol = holding.instrument?.symbol ?? holding.id;
    const isCash = symbol.startsWith("$CASH");
    const parsedOption = isCash ? null : parseOccSymbol(symbol);
    const avatarSymbol = isCash ? "$CASH" : parsedOption ? parsedOption.underlying : symbol;
    const displaySymbol = isCash ? symbol.split("-")[0] : parsedOption ? parsedOption.underlying : symbol;
    const subtitle = parsedOption
      ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
      : (holding.instrument?.name ?? null);
    const isNavigable = !isCash && holding.instrument?.symbol;

    return (
      <div key={holding.id} className="flex items-stretch border-b">
        <button
          type="button"
          className={cn(
            "bg-background sticky left-0 z-10 flex min-w-[140px] items-center gap-2 p-2 text-left",
            isNavigable && "hover:bg-muted/50",
          )}
          onClick={() => isNavigable && handleNavigate(holding)}
        >
          <span className="h-4 w-4 shrink-0" />
          <TickerAvatar symbol={avatarSymbol} className="h-8 w-8" />
          <div className="overflow-hidden">
            <p className="truncate text-sm font-semibold">{displaySymbol}</p>
            {subtitle && <p className="text-muted-foreground truncate text-[11px]">{subtitle}</p>}
          </div>
        </button>
        <MetricStrip
          resolve={resolveLeaf(holding)}
          currency={holding.localCurrency}
          isHidden={isBalanceHidden}
          showHeader={false}
        />
      </div>
    );
  };

  const renderStrategyRow = (strategy: StrategyGroupRow) => {
    const expanded = expandedStrategies.includes(strategy.id);
    return (
      <div key={strategy.id}>
        <div className="flex items-stretch border-b">
          <button
            type="button"
            className="bg-background hover:bg-muted/50 sticky left-0 z-10 flex min-w-[140px] items-center gap-2 p-2 text-left"
            onClick={() => toggleStrategy(strategy.id)}
          >
            <Icons.ChevronRight
              className={cn("h-4 w-4 shrink-0 transition-transform", expanded && "rotate-90")}
            />
            <div className="overflow-hidden">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-semibold">{strategy.name}</p>
                <Badge variant="secondary">{strategy.memberCount}</Badge>
              </div>
              <p className="text-muted-foreground truncate text-[11px]">
                {strategy.netCashBase >= 0
                  ? `Net debit ${strategy.baseCurrency} ${Math.abs(strategy.netCashBase).toFixed(2)}`
                  : `Net credit ${strategy.baseCurrency} ${Math.abs(strategy.netCashBase).toFixed(2)}`}
              </p>
            </div>
          </button>
          <MetricStrip
            resolve={resolveStrategy(strategy)}
            currency={strategy.baseCurrency}
            isHidden={isBalanceHidden}
            showHeader={false}
          />
        </div>
        {expanded && (
          <div className="border-l ml-4 pl-2">
            {strategy.subRows.map((leg) => renderLeafRow(leg))}
          </div>
        )}
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {(showSearch || showFilterButton) && (
        <div className="flex items-center gap-2">
          {showSearch && (
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-secondary/30 h-10 flex-1 rounded-full border-none"
            />
          )}
          {showFilterButton && (
            <Button
              variant="outline"
              size="icon"
              className="relative size-9 shrink-0"
              onClick={() => setIsFilterSheetOpen(true)}
            >
              <Icons.ListFilter className="h-4 w-4" />
              {hasActiveFilters && (
                <span className="bg-destructive absolute right-0 top-0.5 h-2 w-2 rounded-full" />
              )}
            </Button>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        {/* Header strip */}
        <div className="flex border-b">
          <div className="bg-background sticky left-0 z-10 min-w-[140px] p-2" />
          <MetricStrip
            resolve={() => ({ top: null })}
            currency=""
            isHidden={false}
            showHeader
          />
        </div>
        {rows.length > 0 ? (
          rows.map((row) => {
            if (isHoldingGroupRow(row)) {
              const expanded = expandedKeys.includes(row.underlyingKey);
              return (
                <div key={row.id}>
                  <div className="flex items-stretch border-b">
                    <button
                      type="button"
                      className="bg-background hover:bg-muted/50 sticky left-0 z-10 flex min-w-[140px] items-center gap-2 p-2 text-left"
                      onClick={() => toggleExpand(row.underlyingKey)}
                    >
                      <Icons.ChevronRight
                        className={cn(
                          "h-4 w-4 shrink-0 transition-transform",
                          expanded && "rotate-90",
                        )}
                      />
                      <TickerAvatar symbol={row.underlyingSymbol} className="h-8 w-8" />
                      <div className="overflow-hidden">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-semibold">{row.underlyingSymbol}</p>
                          <Badge variant="secondary">{row.memberCount}</Badge>
                        </div>
                        {row.underlyingName && (
                          <p className="text-muted-foreground truncate text-[11px]">
                            {row.underlyingName}
                          </p>
                        )}
                      </div>
                    </button>
                    <MetricStrip
                      resolve={resolveGroup(row)}
                      currency={row.baseCurrency}
                      isHidden={isBalanceHidden}
                      showHeader={false}
                    />
                  </div>
                  {expanded && (
                    <div className="ml-4 border-l pl-2">
                      {row.subRows.map((sub) =>
                        isStrategyGroupRow(sub)
                          ? renderStrategyRow(sub)
                          : renderLeafRow(sub),
                      )}
                    </div>
                  )}
                </div>
              );
            }
            if (isStrategyGroupRow(row)) return null;
            return renderLeafRow(row);
          })
        ) : (
          <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
            <h3 className="text-lg font-medium">No positions found</h3>
            <p className="text-muted-foreground text-sm">
              {holdings.length === 0
                ? "Add activities to see your positions here."
                : "Try adjusting your search or filter criteria."}
            </p>
          </div>
        )}
      </div>

      {/* Filter Sheet */}
      <HoldingsMobileFilterSheet
        open={isFilterSheetOpen}
        onOpenChange={setIsFilterSheetOpen}
        accountFilter={accountFilter}
        onAccountScopeChange={onAccountScopeChange}
        accounts={accounts}
        portfolios={portfolios}
        selectedTypes={selectedTypes}
        setSelectedTypes={setSelectedTypes}
        showAccountScope={showAccountScope}
        sortBy={sortBy}
        setSortBy={setSortBy}
        groupByUnderlying={groupByUnderlying}
        setGroupByUnderlying={setGroupByUnderlying}
        groupByStrategy={groupByStrategy}
        setGroupByStrategy={setGroupByStrategy}
        typeOptions={typeOptions}
      />
    </div>
  );
};

export default HoldingsTableMobile;
