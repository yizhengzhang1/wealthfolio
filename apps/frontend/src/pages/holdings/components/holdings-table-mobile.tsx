import { TickerAvatar } from "@/components/ticker-avatar";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { Account, AccountScope, Holding } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AmountDisplay, Badge, GainPercent, Input, Separator } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { groupHoldingsByUnderlying, isHoldingGroupRow, type HoldingRow } from "../utils/group-by-underlying";
import { isStrategyGroupRow, type StrategyGroupRow } from "../utils/detect-strategies";
import { useOptionStrategies } from "@/hooks/use-option-strategies";
import { HoldingsMobileFilterSheet } from "./holdings-mobile-filter-sheet";

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
  showTotalReturn: controlledShowTotalReturn,
  setShowTotalReturn: controlledSetShowTotalReturn,
  typeOptions,
}: HoldingsTableMobileProps) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  // Internal state for uncontrolled mode
  const [internalSortBy, setInternalSortBy] = useState<"symbol" | "marketValue">("marketValue");
  const [internalShowTotalReturn, setInternalShowTotalReturn] = useState(true);

  const sortBy = controlledSortBy ?? internalSortBy;
  const setSortBy = controlledSetSortBy ?? setInternalSortBy;
  const showTotalReturn = controlledShowTotalReturn ?? internalShowTotalReturn;
  const setShowTotalReturn = controlledSetShowTotalReturn ?? setInternalShowTotalReturn;

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
    // Use instrument.id (asset ID) for navigation, not symbol (which may be stripped)
    const assetId = holding.instrument?.id;
    if (assetId && !assetId.startsWith("$CASH")) {
      navigate(`/holdings/${encodeURIComponent(assetId)}`, { state: { holding } });
    }
  };

  const renderLeafCard = (holding: Holding) => {
    const symbol = holding.instrument?.symbol ?? holding.id;
    const isCash = symbol.startsWith("$CASH");
    const parsedOption = isCash ? null : parseOccSymbol(symbol);
    const avatarSymbol = isCash ? "$CASH" : parsedOption ? parsedOption.underlying : symbol;
    const displaySymbol = isCash
      ? symbol.split("-")[0]
      : parsedOption
        ? parsedOption.underlying
        : symbol;
    const subtitle = parsedOption
      ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
      : (holding.instrument?.name ?? null);
    const isNavigable = !isCash && holding.instrument?.symbol;

    return (
      <Card
        key={holding.id}
        className={cn("p-3", isNavigable && "hover:bg-muted/50 cursor-pointer transition-colors")}
        onClick={() => isNavigable && handleNavigate(holding)}
      >
        <div className="flex items-center justify-between">
          <div className="flex flex-1 items-center gap-3 overflow-hidden">
            <TickerAvatar symbol={avatarSymbol} className="h-10 w-10" />
            <div className="flex-1 overflow-hidden">
              <div className="flex items-center gap-1.5">
                <p className="truncate font-semibold">{displaySymbol}</p>
              </div>
              {subtitle && <p className="text-muted-foreground truncate text-sm">{subtitle}</p>}
            </div>
          </div>
          <div className="ml-2 text-right">
            <AmountDisplay
              value={holding.marketValue?.local ?? 0}
              currency={holding.localCurrency}
              isHidden={isBalanceHidden}
              className="font-medium"
            />
            <div className="flex items-center justify-end gap-1">
              <AmountDisplay
                value={
                  showTotalReturn ? (holding.totalGain?.local ?? 0) : (holding.dayChange?.local ?? 0)
                }
                currency={holding.localCurrency}
                isHidden={isBalanceHidden}
                colorFormat
                className="text-xs"
              />
              <Separator orientation="vertical" className="mx-1 h-4" />
              <GainPercent
                value={showTotalReturn ? (holding.totalGainPct ?? 0) : (holding.dayChangePct ?? 0)}
                className="text-xs"
              />
            </div>
          </div>
        </div>
      </Card>
    );
  };

  const renderStrategyCard = (strategy: StrategyGroupRow) => {
    const expanded = expandedStrategies.includes(strategy.id);
    return (
      <div key={strategy.id} className="space-y-2">
        <Card
          className="hover:bg-muted/50 cursor-pointer p-3 transition-colors"
          onClick={() => toggleStrategy(strategy.id)}
        >
          <div className="flex items-center justify-between">
            <div className="flex flex-1 items-center gap-2 overflow-hidden">
              <Icons.ChevronRight
                className={cn("h-4 w-4 shrink-0 transition-transform", expanded && "rotate-90")}
              />
              <div className="flex-1 overflow-hidden">
                <div className="flex items-center gap-1.5">
                  <p className="truncate font-semibold">{strategy.name}</p>
                  <Badge variant="secondary">{strategy.memberCount}</Badge>
                </div>
                <p className="text-muted-foreground truncate text-sm">
                  {strategy.netCashBase >= 0
                    ? `Net debit ${strategy.baseCurrency} ${Math.abs(strategy.netCashBase).toFixed(2)}`
                    : `Net credit ${strategy.baseCurrency} ${Math.abs(strategy.netCashBase).toFixed(2)}`}
                </p>
              </div>
            </div>
            <div className="ml-2 text-right">
              <AmountDisplay
                value={strategy.marketValueBase}
                currency={strategy.baseCurrency}
                isHidden={isBalanceHidden}
                className="font-medium"
              />
              <div className="flex items-center justify-end gap-1">
                <AmountDisplay
                  value={showTotalReturn ? strategy.totalGainBase : strategy.dayChangeBase}
                  currency={strategy.baseCurrency}
                  isHidden={isBalanceHidden}
                  colorFormat
                  className="text-xs"
                />
                <Separator orientation="vertical" className="mx-1 h-4" />
                <GainPercent
                  value={(showTotalReturn ? strategy.totalGainPct : strategy.dayChangePct) ?? 0}
                  className="text-xs"
                />
              </div>
            </div>
          </div>
        </Card>
        {expanded && (
          <div className="ml-4 space-y-2 border-l pl-2">
            {strategy.subRows.map((leg) => renderLeafCard(leg))}
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
      <div className="space-y-2">
        {rows.length > 0 ? (
          rows.map((row) => {
            if (isHoldingGroupRow(row)) {
              const expanded = expandedKeys.includes(row.underlyingKey);
              return (
                <div key={row.id} className="space-y-2">
                  <Card
                    className="hover:bg-muted/50 cursor-pointer p-3 transition-colors"
                    onClick={() => toggleExpand(row.underlyingKey)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex flex-1 items-center gap-2 overflow-hidden">
                        <Icons.ChevronRight
                          className={cn(
                            "h-4 w-4 shrink-0 transition-transform",
                            expanded && "rotate-90",
                          )}
                        />
                        <TickerAvatar symbol={row.underlyingSymbol} className="h-10 w-10" />
                        <div className="flex-1 overflow-hidden">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate font-semibold">{row.underlyingSymbol}</p>
                            <Badge variant="secondary">{row.memberCount}</Badge>
                          </div>
                          {row.underlyingName && (
                            <p className="text-muted-foreground truncate text-sm">
                              {row.underlyingName}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="ml-2 text-right">
                        <AmountDisplay
                          value={row.marketValueBase}
                          currency={row.baseCurrency}
                          isHidden={isBalanceHidden}
                          className="font-medium"
                        />
                        <div className="flex items-center justify-end gap-1">
                          <AmountDisplay
                            value={showTotalReturn ? row.totalGainBase : row.dayChangeBase}
                            currency={row.baseCurrency}
                            isHidden={isBalanceHidden}
                            colorFormat
                            className="text-xs"
                          />
                          <Separator orientation="vertical" className="mx-1 h-4" />
                          <GainPercent
                            value={(showTotalReturn ? row.totalGainPct : row.dayChangePct) ?? 0}
                            className="text-xs"
                          />
                        </div>
                      </div>
                    </div>
                  </Card>
                  {expanded && (
                    <div className="ml-4 space-y-2 border-l pl-2">
                      {row.subRows.map((sub) =>
                        isStrategyGroupRow(sub)
                          ? renderStrategyCard(sub)
                          : renderLeafCard(sub),
                      )}
                    </div>
                  )}
                </div>
              );
            }
            if (isStrategyGroupRow(row)) return null;
            return renderLeafCard(row);
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
        showTotalReturn={showTotalReturn}
        setShowTotalReturn={setShowTotalReturn}
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
