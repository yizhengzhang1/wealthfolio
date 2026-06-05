import { DashboardCard } from "@/components/dashboard-card";
import { TickerAvatar } from "@/components/ticker-avatar";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { HoldingType, isAlternativeAssetKind, type AssetKind } from "@/lib/constants";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { Holding } from "@/lib/types";
import {
  groupHoldingsByUnderlying,
  isHoldingGroupRow,
  type HoldingGroupRow,
  type HoldingRow as HoldingRowItem,
} from "@/pages/holdings/utils/group-by-underlying";
import { isStrategyGroupRow, type StrategyGroupRow } from "@/pages/holdings/utils/detect-strategies";
import { useOptionStrategies } from "@/hooks/use-option-strategies";
import { cn } from "@/lib/utils";
import {
  AmountDisplay,
  Button,
  GainAmount,
  GainPercent,
  Icons,
  usePersistentState,
} from "@wealthfolio/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";

const MAX_DISPLAYED_HOLDINGS = 10;
const MAX_STACKED_AVATARS = 5;
const SHOW_TOTAL_RETURN_KEY = "dashboard-holdings-widget-show-total-return";

interface TopHoldingsProps {
  holdings: Holding[];
  isLoading: boolean;
  baseCurrency: string;
}

interface HoldingRowProps {
  holding: Holding;
  baseCurrency: string;
  isHidden?: boolean;
  showTotalReturn: boolean;
  showName: boolean;
  onClick?: () => void;
}

function HoldingRow({
  holding,
  baseCurrency,
  isHidden,
  showTotalReturn,
  showName,
  onClick,
}: HoldingRowProps) {
  const symbol = holding.instrument?.symbol ?? holding.id;
  const parsedOption = parseOccSymbol(symbol);
  const symbolLabel = parsedOption ? parsedOption.underlying : symbol.split(".")[0];
  const nameLabel = holding.instrument?.name?.trim() || symbolLabel;
  const title = showName ? nameLabel : symbolLabel;
  const subtitle = parsedOption
    ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
    : `${(holding.quantity ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 })} shares`;
  const avatarSymbol = parsedOption ? parsedOption.underlying : symbol;
  const marketValue = holding.marketValue?.base ?? 0;
  const gainAmount = showTotalReturn
    ? (holding.totalGain?.base ?? holding.unrealizedGain?.base ?? 0)
    : (holding.dayChange?.base ?? 0);
  const gainPercent = showTotalReturn
    ? (holding.totalGainPct ?? holding.unrealizedGainPct ?? 0)
    : (holding.dayChangePct ?? 0);

  return (
    <div
      className="border-border hover:bg-muted/30 group flex cursor-pointer items-center justify-between gap-3 border-b py-3 transition-colors last:border-0"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* Chevron-width spacer so leaf rows align with expandable group/strategy rows */}
        <span className="h-4 w-4 shrink-0" />
        <TickerAvatar symbol={avatarSymbol} className="size-9 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="text-muted-foreground text-xs">{subtitle}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <AmountDisplay
          value={marketValue}
          currency={baseCurrency}
          isHidden={isHidden}
          className="text-sm font-semibold"
        />
        <div className="flex items-center gap-2">
          <GainAmount
            value={gainAmount}
            currency={baseCurrency}
            displayCurrency={false}
            className="text-xs"
          />
          <GainPercent
            value={gainPercent}
            variant="badge"
            className="min-w-[60px] justify-center text-xs"
          />
        </div>
      </div>
    </div>
  );
}

interface GroupHoldingRowProps {
  group: HoldingGroupRow;
  baseCurrency: string;
  isHidden?: boolean;
  showTotalReturn: boolean;
  showName: boolean;
  expanded: boolean;
  onClick?: () => void;
}

function GroupHoldingRow({
  group,
  baseCurrency,
  isHidden,
  showTotalReturn,
  showName,
  expanded,
  onClick,
}: GroupHoldingRowProps) {
  const title = showName ? (group.underlyingName ?? group.underlyingSymbol) : group.underlyingSymbol;
  const subtitle = `${group.memberCount} positions`;
  const marketValue = group.marketValueBase;
  const gainAmount = showTotalReturn ? group.totalGainBase : group.dayChangeBase;
  const gainPercent = showTotalReturn ? (group.totalGainPct ?? 0) : (group.dayChangePct ?? 0);

  return (
    <div
      className="border-border hover:bg-muted/30 group flex cursor-pointer items-center justify-between gap-3 border-b py-3 transition-colors last:border-0"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Icons.ChevronRight
          className={cn(
            "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
        <TickerAvatar symbol={group.underlyingSymbol} className="size-9 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="text-muted-foreground text-xs">{subtitle}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <AmountDisplay
          value={marketValue}
          currency={baseCurrency}
          isHidden={isHidden}
          className="text-sm font-semibold"
        />
        <div className="flex items-center gap-2">
          <GainAmount
            value={gainAmount}
            currency={baseCurrency}
            displayCurrency={false}
            className="text-xs"
          />
          <GainPercent
            value={gainPercent}
            variant="badge"
            className="min-w-[60px] justify-center text-xs"
          />
        </div>
      </div>
    </div>
  );
}

interface StrategyHoldingRowProps {
  strategy: StrategyGroupRow;
  baseCurrency: string;
  isHidden?: boolean;
  showTotalReturn: boolean;
  expanded: boolean;
  showName: boolean;
  onToggle: () => void;
  onLegClick: (leg: Holding) => void;
}

function StrategyHoldingRow({
  strategy,
  baseCurrency,
  isHidden,
  showTotalReturn,
  expanded,
  showName,
  onToggle,
  onLegClick,
}: StrategyHoldingRowProps) {
  const gainAmount = showTotalReturn ? strategy.totalGainBase : strategy.dayChangeBase;
  const gainPercent = showTotalReturn ? (strategy.totalGainPct ?? 0) : (strategy.dayChangePct ?? 0);
  return (
    <div>
      <div
        className="border-border hover:bg-muted/30 group flex cursor-pointer items-center justify-between gap-3 border-b py-3 transition-colors last:border-0"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onToggle()}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Icons.ChevronRight
            className={cn(
              "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{strategy.name}</span>
            <span className="text-muted-foreground text-xs">
              {strategy.netCashBase >= 0
                ? `Net debit ${Math.abs(strategy.netCashBase).toFixed(2)}`
                : `Net credit ${Math.abs(strategy.netCashBase).toFixed(2)}`}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <AmountDisplay
            value={strategy.marketValueBase}
            currency={baseCurrency}
            isHidden={isHidden}
            className="text-sm font-semibold"
          />
          <div className="flex items-center gap-2">
            <GainAmount
              value={gainAmount}
              currency={baseCurrency}
              displayCurrency={false}
              className="text-xs"
            />
            <GainPercent
              value={gainPercent}
              variant="badge"
              className="min-w-[60px] justify-center text-xs"
            />
          </div>
        </div>
      </div>
      {expanded && (
        <div className="border-border ml-3 border-l pl-3">
          {strategy.subRows.map((leg) => (
            <HoldingRow
              key={leg.id}
              holding={leg}
              baseCurrency={baseCurrency}
              isHidden={isHidden}
              showTotalReturn={showTotalReturn}
              showName={showName}
              onClick={() => onLegClick(leg)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface StackedAvatarsProps {
  holdings: HoldingRowItem[];
  totalRemaining: number;
  onClick?: () => void;
}

function StackedAvatars({ holdings, totalRemaining, onClick }: StackedAvatarsProps) {
  const displayedHoldings = holdings.slice(0, MAX_STACKED_AVATARS);
  const extraCount = totalRemaining - displayedHoldings.length;

  return (
    <div
      className="hover:bg-muted/50 border-border flex cursor-pointer items-center gap-2 border-t py-3 transition-colors"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
    >
      <div className="flex items-center">
        {displayedHoldings.map((holding, index) => {
          const avatarSym = isHoldingGroupRow(holding)
            ? holding.underlyingSymbol
            : isStrategyGroupRow(holding)
              ? holding.underlyingKey
              : (() => {
                  const s = holding.instrument?.symbol ?? holding.id;
                  const parsed = parseOccSymbol(s);
                  return parsed ? parsed.underlying : s;
                })();
          return (
            <div
              key={holding.id}
              className={cn("relative", index > 0 && "-ml-2")}
              style={{ zIndex: displayedHoldings.length - index }}
            >
              <TickerAvatar symbol={avatarSym} className="ring-background size-8 ring-2" />
            </div>
          );
        })}
      </div>
      <span className="text-muted-foreground text-xs">
        {extraCount > 0 ? `+${totalRemaining} more holdings` : `+${totalRemaining} more`}
      </span>
      <Icons.ChevronRight className="text-muted-foreground ml-auto h-3 w-3" />
    </div>
  );
}

function TopHoldingsSkeleton() {
  return (
    <DashboardCard title="Holdings" elevated>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="border-border border-b py-3 last:border-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-full" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-12" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <Skeleton className="h-3.5 w-24" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-5 w-[60px] rounded-md" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </DashboardCard>
  );
}

function TopHoldingsEmptyState() {
  return (
    <DashboardCard title="Holdings" elevated>
      <div className="py-2 text-center">
        <p className="text-sm">No holdings yet.</p>
        <Link
          to="/activities/manage"
          className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          Add your first transaction
          <Icons.ChevronRight className="h-3 w-3" />
        </Link>
      </div>
    </DashboardCard>
  );
}

export function TopHoldings({ holdings, isLoading, baseCurrency }: TopHoldingsProps) {
  const navigate = useNavigate();
  const { isBalanceHidden } = useBalancePrivacy();
  const [showTotalReturn, setShowTotalReturn] = usePersistentState<boolean>(
    SHOW_TOTAL_RETURN_KEY,
    true,
  );
  const [sortBy, setSortBy] = usePersistentState<"value" | "gain">(
    "holdings-widget-sort-by",
    "value",
  );
  const [displayMode, setDisplayMode] = usePersistentState<"symbol" | "name">(
    "holdings-widget-display-mode",
    "symbol",
  );
  const [groupByUnderlying, setGroupByUnderlying] = usePersistentState<boolean>(
    "dashboard-holdings-widget-group-by-underlying",
    true,
  );
  const [expandedKeys, setExpandedKeys] = usePersistentState<string[]>(
    "dashboard-holdings-widget-expanded",
    [],
  );
  const toggleExpand = (key: string) =>
    setExpandedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  const [groupByStrategy, setGroupByStrategy] = usePersistentState<boolean>(
    "dashboard-holdings-widget-group-by-strategy",
    true,
  );
  const [expandedStrategies, setExpandedStrategies] = usePersistentState<string[]>(
    "dashboard-holdings-widget-expanded-strategies",
    [],
  );
  const toggleStrategy = (id: string) =>
    setExpandedStrategies((prev) =>
      prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id],
    );
  const accountIds = Array.from(new Set(holdings.map((h) => h.accountId).filter(Boolean)));
  const { data: overrides = [] } = useOptionStrategies(accountIds);

  // Filter out cash holdings and alternative assets, optionally group same-underlying
  // positions into one summary row, then sort by market value or gain.
  // Dashboard shows only investment holdings (securities, crypto, etc.)
  const sortedHoldings = useMemo<HoldingRowItem[]>(() => {
    const filtered = holdings.filter((h) => {
      // Exclude cash holdings
      if (h.holdingType === HoldingType.CASH) return false;
      // Exclude alternative assets (properties, vehicles, liabilities, etc.)
      if (h.assetKind && isAlternativeAssetKind(h.assetKind as AssetKind)) return false;
      return true;
    });

    const base: HoldingRowItem[] = groupByUnderlying
      ? groupHoldingsByUnderlying(filtered, { groupByStrategy, overrides })
      : filtered;

    const valueOf = (it: HoldingRowItem) =>
      isHoldingGroupRow(it) || isStrategyGroupRow(it)
        ? it.marketValueBase
        : (it.marketValue?.base ?? 0);
    const gainOf = (it: HoldingRowItem) =>
      isHoldingGroupRow(it) || isStrategyGroupRow(it)
        ? showTotalReturn
          ? it.totalGainBase
          : it.dayChangeBase
        : showTotalReturn
          ? (it.totalGain?.base ?? it.unrealizedGain?.base ?? 0)
          : (it.dayChange?.base ?? 0);

    return [...base].sort((a, b) =>
      sortBy === "gain" ? gainOf(b) - gainOf(a) : valueOf(b) - valueOf(a),
    );
  }, [holdings, sortBy, showTotalReturn, groupByUnderlying, groupByStrategy, overrides]);

  // Show one extra holding directly rather than displaying "+1 more"
  const displayCount =
    sortedHoldings.length === MAX_DISPLAYED_HOLDINGS + 1
      ? MAX_DISPLAYED_HOLDINGS + 1
      : MAX_DISPLAYED_HOLDINGS;
  const topHoldings = sortedHoldings.slice(0, displayCount);
  const remainingHoldings = sortedHoldings.slice(displayCount);
  const hasRemainingHoldings = remainingHoldings.length > 0;

  if (isLoading) {
    return <TopHoldingsSkeleton />;
  }

  if (sortedHoldings.length === 0) {
    return <TopHoldingsEmptyState />;
  }

  return (
    <DashboardCard
      title="Holdings"
      elevated
      action={
        <div className="flex items-center gap-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:bg-success/10 h-8 w-8 p-0"
              >
                <Icons.ListFilter className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="border-border/50 bg-card min-w-[200px] rounded-2xl border p-2 shadow-lg backdrop-blur-xl"
            >
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Grouping
              </p>
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setGroupByUnderlying(v)}
                >
                  {v ? "Grouped" : "Flat"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      groupByUnderlying === v
                        ? "border-primary bg-primary"
                        : "border-muted-foreground",
                    )}
                  >
                    {groupByUnderlying === v && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
              <div className="bg-border/70 mx-2 my-1.5 h-px" />
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Strategy sub-grouping
              </p>
              {([true, false] as const).map((v) => (
                <button
                  key={`strat-${String(v)}`}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setGroupByStrategy(v)}
                >
                  {v ? "Strategy" : "Legs"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      groupByStrategy === v ? "border-primary bg-primary" : "border-muted-foreground",
                    )}
                  >
                    {groupByStrategy === v && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
              <div className="bg-border/70 mx-2 my-1.5 h-px" />
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Show
              </p>
              {(["total", "daily"] as const).map((v) => (
                <button
                  key={v}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setShowTotalReturn(v === "total")}
                >
                  {v === "total" ? "Total Return" : "Daily Change"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      (v === "total") === showTotalReturn
                        ? "border-primary bg-primary"
                        : "border-muted-foreground",
                    )}
                  >
                    {(v === "total") === showTotalReturn && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
              <div className="bg-border/70 mx-2 my-1.5 h-px" />
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Sort by
              </p>
              {(["value", "gain"] as const).map((v) => (
                <button
                  key={v}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setSortBy(v)}
                >
                  {v === "value" ? "Total Value" : "Gain"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      sortBy === v ? "border-primary bg-primary" : "border-muted-foreground",
                    )}
                  >
                    {sortBy === v && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
              <div className="bg-border/70 mx-2 my-1.5 h-px" />
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Display
              </p>
              {(["symbol", "name"] as const).map((v) => (
                <button
                  key={v}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setDisplayMode(v)}
                >
                  {v === "symbol" ? "Symbol" : "Name"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      displayMode === v ? "border-primary bg-primary" : "border-muted-foreground",
                    )}
                  >
                    {displayMode === v && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-success/10 text-xs"
            onClick={() => navigate("/holdings")}
          >
            View All
            <Icons.ChevronRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      }
    >
      {topHoldings.map((item) => {
        if (isHoldingGroupRow(item)) {
          const expanded = expandedKeys.includes(item.underlyingKey);
          return (
            <div key={item.id}>
              <GroupHoldingRow
                group={item}
                baseCurrency={baseCurrency}
                isHidden={isBalanceHidden}
                showTotalReturn={showTotalReturn}
                showName={displayMode === "name"}
                expanded={expanded}
                onClick={() => toggleExpand(item.underlyingKey)}
              />
              {expanded && (
                <div className="border-border ml-3 border-l pl-3">
                  {item.subRows.map((sub) =>
                    isStrategyGroupRow(sub) ? (
                      <StrategyHoldingRow
                        key={sub.id}
                        strategy={sub}
                        baseCurrency={baseCurrency}
                        isHidden={isBalanceHidden}
                        showTotalReturn={showTotalReturn}
                        expanded={expandedStrategies.includes(sub.id)}
                        onToggle={() => toggleStrategy(sub.id)}
                        onLegClick={(leg) =>
                          navigate(`/holdings/${encodeURIComponent(leg.instrument?.id ?? leg.id)}`)
                        }
                        showName={displayMode === "name"}
                      />
                    ) : (
                      <HoldingRow
                        key={sub.id}
                        holding={sub}
                        baseCurrency={baseCurrency}
                        isHidden={isBalanceHidden}
                        showTotalReturn={showTotalReturn}
                        showName={displayMode === "name"}
                        onClick={() =>
                          navigate(`/holdings/${encodeURIComponent(sub.instrument?.id ?? sub.id)}`)
                        }
                      />
                    ),
                  )}
                </div>
              )}
            </div>
          );
        }
        if (isStrategyGroupRow(item)) return null;
        const assetId = item.instrument?.id ?? item.id;
        return (
          <HoldingRow
            key={item.id}
            holding={item}
            baseCurrency={baseCurrency}
            isHidden={isBalanceHidden}
            showTotalReturn={showTotalReturn}
            showName={displayMode === "name"}
            onClick={() => navigate(`/holdings/${encodeURIComponent(assetId)}`)}
          />
        );
      })}
      {hasRemainingHoldings && (
        <StackedAvatars
          holdings={remainingHoldings}
          totalRemaining={remainingHoldings.length}
          onClick={() => navigate("/holdings")}
        />
      )}
    </DashboardCard>
  );
}

export default TopHoldings;
