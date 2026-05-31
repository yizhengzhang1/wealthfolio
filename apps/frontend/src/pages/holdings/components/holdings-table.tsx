import { Button } from "@wealthfolio/ui/components/ui/button";
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import { DataTableColumnHeader } from "@wealthfolio/ui/components/ui/data-table/data-table-column-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { safeDivide } from "@/lib/utils";
import type { ColumnDef } from "@tanstack/react-table";
import { GainPercent, Badge } from "@wealthfolio/ui";

import { TickerAvatar } from "@/components/ticker-avatar";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useSettingsContext } from "@/lib/settings-provider";
import { Holding } from "@/lib/types";
import { AmountDisplay, QuantityDisplay } from "@wealthfolio/ui";
import { useNavigate } from "react-router-dom";

import { AnimatedToggleGroup } from "@wealthfolio/ui";
import {
  groupHoldingsByUnderlying,
  isHoldingGroupRow,
  type HoldingRow,
} from "../utils/group-by-underlying";
import {
  isStrategyGroupRow,
} from "../utils/detect-strategies";
import { useOptionStrategies } from "@/hooks/use-option-strategies";

// Helper function to get display value and currency based on toggle state
const getDisplayValueAndCurrency = (
  holding: Holding,
  valueInBase: number | null | undefined,
  showConvertedToBase: boolean,
): { value: number; currency: string } => {
  const fxRate = holding.fxRate ?? 1; // Use fxRate from Holding

  if (showConvertedToBase) {
    // Show value in Base Currency
    return {
      value: valueInBase ?? 0,
      currency: holding.baseCurrency, // Use baseCurrency from Holding
    };
  } else {
    // Show value in Asset's Original Currency
    const valueInOriginal = safeDivide(valueInBase ?? 0, fxRate);
    return {
      value: valueInOriginal,
      currency: holding.localCurrency, // Use localCurrency from Holding
    };
  }
};

export const HoldingsTable = ({
  holdings,
  isLoading,
  showTotalReturn = true,
  setShowTotalReturn,
  onClassify,
}: {
  holdings: Holding[];
  isLoading: boolean;
  showTotalReturn?: boolean;
  setShowTotalReturn?: (value: boolean) => void;
  onClassify?: (holding: Holding) => void;
}) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();
  const [showConvertedValues, setShowConvertedValues] = usePersistentState<boolean>(
    "holdings-table:show-converted",
    false,
  );
  const [groupByUnderlying, setGroupByUnderlying] = usePersistentState<boolean>(
    "holdings-table:group-by-underlying",
    true,
  );
  const [groupByStrategy, setGroupByStrategy] = usePersistentState<boolean>(
    "holdings-table:group-by-strategy",
    true,
  );
  const accountIds = Array.from(
    new Set(holdings.map((h) => h.accountId).filter(Boolean)),
  );
  const { data: overrides = [] } = useOptionStrategies(accountIds);

  const baseCurrency = settings?.baseCurrency ?? holdings[0]?.baseCurrency;
  const hasMultipleCurrencies = holdings.some((holding) => {
    if (!baseCurrency || !holding.localCurrency) {
      return false;
    }

    return holding.localCurrency.toUpperCase() !== baseCurrency.toUpperCase();
  });

  if (isLoading) {
    return (
      <div className="space-y-4 pt-6">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const uniqueTypesSet = new Set();
  const assetsTypes: { label: string; value: string }[] = holdings.reduce(
    (result: { label: string; value: string }[], asset) => {
      // Use taxonomy-based assetType classification
      const type = asset.instrument?.classifications?.assetType?.name;
      if (type && !uniqueTypesSet.has(type)) {
        uniqueTypesSet.add(type);
        result.push({ label: type.toUpperCase(), value: type });
      }
      return result;
    },
    [],
  );

  const filters = [
    {
      id: "holdingType",
      title: "Type",
      options: assetsTypes,
    },
  ];

  const tableData: HoldingRow[] = groupByUnderlying
    ? groupHoldingsByUnderlying(holdings, { groupByStrategy, overrides })
    : holdings;

  return (
    <div className="flex h-full flex-col">
      <DataTable
        data={tableData}
        columns={getColumns(isBalanceHidden, showConvertedValues, showTotalReturn, onClassify)}
        searchBy="symbol"
        filters={filters}
        showColumnToggle={true}
        storageKey="holdings-table"
        getSubRows={(row) =>
          isHoldingGroupRow(row)
            ? row.subRows
            : isStrategyGroupRow(row)
              ? row.subRows
              : undefined
        }
        defaultExpanded={true}
        filterFromLeafRows={true}
        defaultColumnVisibility={{
          currency: false,
          symbolName: false,
          holdingType: false,
          bookValue: false,
        }}
        defaultSorting={[{ id: "symbol", desc: false }]}
        scrollable={true}
        toolbarActions={
          <div className="mr-2 flex items-center gap-2">
            <AnimatedToggleGroup
              value={groupByUnderlying ? "grouped" : "flat"}
              onValueChange={(value) => setGroupByUnderlying(value === "grouped")}
              items={[
                { value: "grouped", label: "Grouped" },
                { value: "flat", label: "Flat" },
              ]}
              size="xs"
              rounded="md"
            />
            {groupByUnderlying && (
              <AnimatedToggleGroup
                value={groupByStrategy ? "strategy" : "legs"}
                onValueChange={(value) => setGroupByStrategy(value === "strategy")}
                items={[
                  { value: "strategy", label: "Strategy" },
                  { value: "legs", label: "Legs" },
                ]}
                size="xs"
                rounded="md"
              />
            )}
            {setShowTotalReturn && (
              <AnimatedToggleGroup
                value={showTotalReturn ? "total" : "daily"}
                onValueChange={(value) => setShowTotalReturn(value === "total")}
                items={[
                  { value: "total", label: "Total" },
                  { value: "daily", label: "Daily" },
                ]}
                size="xs"
                rounded="md"
              />
            )}
            {hasMultipleCurrencies && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setShowConvertedValues(!showConvertedValues)}
                    className="h-8 w-8 rounded-lg"
                  >
                    {showConvertedValues ? (
                      <Icons.Globe className="h-4 w-4" />
                    ) : (
                      <Icons.DollarSign className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Show values in {showConvertedValues ? "Asset Currency" : "Base Currency"}</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        }
      />
    </div>
  );
};

export default HoldingsTable;

const getColumns = (
  isHidden: boolean,
  showConvertedValues: boolean,
  showTotalReturn: boolean,
  onClassify?: (holding: Holding) => void,
): ColumnDef<HoldingRow>[] => [
  {
    id: "symbol",
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.underlyingSymbol
        : isStrategyGroupRow(row)
          ? row.name
          : row.instrument?.symbol ?? row.id,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Position" />,
    meta: {
      label: "Position",
    },
    cell: ({ row }) => {
      const navigate = useNavigate();
      const data = row.original;

      if (isStrategyGroupRow(data)) {
        return (
          <button
            type="button"
            className="-m-1 flex w-full items-center p-1 text-left"
            style={{ paddingLeft: `${row.depth * 1.5}rem` }}
            onClick={row.getToggleExpandedHandler()}
          >
            {row.getIsExpanded() ? (
              <Icons.ChevronDown className="mr-1 h-4 w-4 shrink-0" />
            ) : (
              <Icons.ChevronRight className="mr-1 h-4 w-4 shrink-0" />
            )}
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{data.name}</span>
                <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px]">
                  {data.memberCount}
                </Badge>
              </div>
              <span className="text-muted-foreground line-clamp-1 text-xs">
                {data.netCashBase >= 0
                  ? `Net debit ${data.baseCurrency} ${Math.abs(data.netCashBase).toFixed(2)}`
                  : `Net credit ${data.baseCurrency} ${Math.abs(data.netCashBase).toFixed(2)}`}
              </span>
            </div>
          </button>
        );
      }

      if (isHoldingGroupRow(data)) {
        return (
          <button
            type="button"
            className="-m-1 flex w-full items-center p-1 text-left"
            style={{ paddingLeft: `${row.depth * 1.5}rem` }}
            onClick={row.getToggleExpandedHandler()}
          >
            {row.getIsExpanded() ? (
              <Icons.ChevronDown className="mr-1 h-4 w-4 shrink-0" />
            ) : (
              <Icons.ChevronRight className="mr-1 h-4 w-4 shrink-0" />
            )}
            <TickerAvatar symbol={data.underlyingSymbol} className="mr-2 h-8 w-8" />
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{data.underlyingSymbol}</span>
                <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px]">
                  {data.memberCount}
                </Badge>
              </div>
              <span className="text-muted-foreground line-clamp-1 text-xs">
                {data.underlyingName ?? ""}
              </span>
            </div>
          </button>
        );
      }

      const holding = data;
      const symbol = holding.instrument?.symbol ?? holding.id;
      const parsedOption = parseOccSymbol(symbol);
      const displaySymbol = parsedOption ? parsedOption.underlying : symbol;
      const optionSubtitle = parsedOption
        ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
        : null;

      const handleNavigate = () => {
        const navSymbol = holding.instrument?.id ?? holding.id;
        navigate(`/holdings/${encodeURIComponent(navSymbol)}`, { state: { holding } });
      };

      const isManual = holding.instrument?.quoteMode === "MANUAL";
      return (
        <div
          className="-m-1 cursor-pointer p-1"
          style={{ paddingLeft: row.depth > 0 ? `${row.depth * 1.5 + 0.25}rem` : undefined }}
          onClick={handleNavigate}
        >
          <div className="flex items-center">
            <TickerAvatar
              symbol={parsedOption ? parsedOption.underlying : symbol}
              className="mr-2 h-8 w-8"
            />
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{displaySymbol}</span>
                {isManual && (
                  <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px]">
                    Manual
                  </Badge>
                )}
              </div>
              <span className="text-muted-foreground line-clamp-1 text-xs">
                {optionSubtitle ?? holding.instrument?.name ?? null}
              </span>
            </div>
          </div>
        </div>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original;
      const b = rowB.original;
      const labelOf = (r: HoldingRow) =>
        isHoldingGroupRow(r)
          ? r.underlyingSymbol
          : isStrategyGroupRow(r)
            ? r.name
            : r.instrument?.symbol ?? r.id;
      return labelOf(a).localeCompare(labelOf(b));
    },
    filterFn: (row, _columnId, filterValue) => {
      const data = row.original;
      const lowerSearch = (filterValue as string).toLowerCase();
      if (isHoldingGroupRow(data)) {
        return (
          data.underlyingSymbol.toLowerCase().includes(lowerSearch) ||
          (data.underlyingName?.toLowerCase().includes(lowerSearch) ?? false)
        );
      }
      if (isStrategyGroupRow(data)) {
        return data.name.toLowerCase().includes(lowerSearch);
      }
      const holding = data;
      const nameMatch = holding.instrument?.name?.toLowerCase().includes(lowerSearch);
      const symbolMatch = holding.instrument?.symbol?.toLowerCase().includes(lowerSearch);
      const idMatch = holding.id.toLowerCase().includes(lowerSearch);
      const parsed = parseOccSymbol(holding.instrument?.symbol ?? "");
      const underlyingMatch = parsed?.underlying.toLowerCase().includes(lowerSearch);
      return !!(symbolMatch || nameMatch || idMatch || underlyingMatch);
    },
    enableHiding: false,
  },
  {
    id: "symbolName",
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.underlyingName ?? row.underlyingSymbol
        : isStrategyGroupRow(row)
          ? row.name
          : row.instrument?.name || row.id,
    meta: {
      label: "Symbol Name",
    },
    enableHiding: false,
  },
  {
    id: "quantity",
    accessorFn: (row) => (isHoldingGroupRow(row) || isStrategyGroupRow(row) ? 0 : row.quantity),
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end text-right" column={column} title="Qty" />
    ),
    meta: {
      label: "Quantity",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isHoldingGroupRow(data) || isStrategyGroupRow(data)) {
        return <div className="min-h-[40px] px-4" />;
      }
      const symbol = data.instrument?.symbol ?? data.id;
      const isOption = !!parseOccSymbol(symbol);
      const assetTypeKey = data.instrument?.classifications?.assetType?.key ?? "";
      const isBond =
        assetTypeKey.startsWith("BOND_") ||
        assetTypeKey === "DEBT_SECURITY" ||
        assetTypeKey === "MONEY_MARKET_DEBT";
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <QuantityDisplay value={data.quantity} isHidden={isHidden} />
          <span className="text-muted-foreground text-xs">
            {isOption ? "contracts" : isBond ? "bonds" : "shares"}
          </span>
        </div>
      );
    },
  },
  {
    id: "marketPrice",
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.underlyingPrice ?? 0
        : isStrategyGroupRow(row)
          ? 0
          : row.price ?? 0,
    enableHiding: true,
    enableSorting: true,
    header: ({ column }) => (
      <DataTableColumnHeader
        className="justify-end text-right"
        column={column}
        title="Today's Price"
      />
    ),
    meta: {
      label: "Today's Price",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isStrategyGroupRow(data)) {
        return <div className="min-h-[40px] px-4" />;
      }
      if (isHoldingGroupRow(data)) {
        if (data.underlyingPrice == null) {
          return <div className="min-h-[40px] px-4" />;
        }
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.underlyingPrice} currency={data.baseCurrency} />
            <GainPercent className="text-xs" value={data.dayChangePct || 0} />
          </div>
        );
      }
      const price = data.price ?? 0;
      const currency = data.localCurrency;
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={price} currency={currency} />
          <GainPercent className="text-xs" value={data.dayChangePct || 0} />
        </div>
      );
    },
  },
  {
    id: "bookValue",
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.costBasisBase
        : isStrategyGroupRow(row)
          ? row.costBasisBase
          : row.costBasis?.local ?? 0,
    enableHiding: true,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Book Cost" />
    ),
    meta: {
      label: "Book Cost",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isStrategyGroupRow(data)) {
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.costBasisBase} currency={data.baseCurrency} isHidden={isHidden} />
            <div className="text-xs text-transparent">-</div>
          </div>
        );
      }
      if (isHoldingGroupRow(data)) {
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.costBasisBase} currency={data.baseCurrency} isHidden={isHidden} />
            <div className="text-xs text-transparent">-</div>
          </div>
        );
      }
      const value = data.costBasis?.local ?? 0;
      const currency = data.localCurrency;
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} isHidden={isHidden} />
          <div className="text-xs text-transparent">-</div>
        </div>
      );
    },
  },
  {
    id: "marketValue",
    accessorFn: (row) =>
      isHoldingGroupRow(row)
        ? row.marketValueBase
        : isStrategyGroupRow(row)
          ? row.marketValueBase
          : row.marketValue.base ?? 0,
    enableHiding: false,
    header: ({ column }) => (
      <DataTableColumnHeader className="justify-end" column={column} title="Total Value" />
    ),
    meta: {
      label: "Total Value",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isStrategyGroupRow(data)) {
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.marketValueBase} currency={data.baseCurrency} isHidden={isHidden} />
            <div className="text-muted-foreground text-xs">{data.baseCurrency}</div>
          </div>
        );
      }
      if (isHoldingGroupRow(data)) {
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={data.marketValueBase} currency={data.baseCurrency} isHidden={isHidden} />
            <div className="text-muted-foreground text-xs">{data.baseCurrency}</div>
          </div>
        );
      }
      const { value, currency } = getDisplayValueAndCurrency(
        data,
        data.marketValue.base,
        showConvertedValues,
      );
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} isHidden={isHidden} />
          <div className="text-muted-foreground text-xs">{currency}</div>
        </div>
      );
    },
  },
  {
    id: "performance",
    accessorFn: (row) =>
      isHoldingGroupRow(row) || isStrategyGroupRow(row)
        ? (showTotalReturn ? row.totalGainBase : row.dayChangeBase)
        : (showTotalReturn ? row.totalGain?.base : row.dayChange?.base) ?? 0,
    enableHiding: false,
    header: ({ column }) => (
      <DataTableColumnHeader
        className="justify-end"
        column={column}
        title={showTotalReturn ? "Unrealized Gain" : "Day Change"}
      />
    ),
    meta: {
      label: "Unrealized Gain",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isStrategyGroupRow(data)) {
        const value = showTotalReturn ? data.totalGainBase : data.dayChangeBase;
        const pct = showTotalReturn ? data.totalGainPct : data.dayChangePct;
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={value} currency={data.baseCurrency} colorFormat={true} isHidden={isHidden} />
            <GainPercent className="text-xs" value={pct || 0} />
          </div>
        );
      }
      if (isHoldingGroupRow(data)) {
        const value = showTotalReturn ? data.totalGainBase : data.dayChangeBase;
        const pct = showTotalReturn ? data.totalGainPct : data.dayChangePct;
        return (
          <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
            <AmountDisplay value={value} currency={data.baseCurrency} colorFormat={true} isHidden={isHidden} />
            <GainPercent className="text-xs" value={pct || 0} />
          </div>
        );
      }
      const valueBase = showTotalReturn ? data.totalGain?.base : data.dayChange?.base;
      const pct = showTotalReturn ? data.totalGainPct : data.dayChangePct;
      const { value, currency } = getDisplayValueAndCurrency(data, valueBase, showConvertedValues);
      return (
        <div className="flex min-h-[40px] flex-col items-end justify-center px-4">
          <AmountDisplay value={value} currency={currency} colorFormat={true} isHidden={isHidden} />
          <GainPercent className="text-xs" value={pct || 0} />
        </div>
      );
    },
  },
  {
    id: "holdingType",
    accessorFn: (row) =>
      isHoldingGroupRow(row) || isStrategyGroupRow(row)
        ? undefined
        : row.instrument?.classifications?.assetType?.name,
    meta: {
      label: "Asset Type",
    },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Asset Type" />,
    filterFn: "arrIncludesSome",
  },
  {
    id: "currency",
    accessorFn: (row) =>
      isHoldingGroupRow(row) || isStrategyGroupRow(row) ? row.baseCurrency : row.localCurrency,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Currency" />,
    meta: {
      label: "Currency",
    },
    cell: ({ row }) => {
      const data = row.original;
      if (isHoldingGroupRow(data) || isStrategyGroupRow(data)) {
        return <div className="text-muted-foreground">{data.baseCurrency}</div>;
      }
      return <div className="text-muted-foreground">{data.localCurrency}</div>;
    },
    filterFn: (row, id, value) => {
      return value.includes(row.getValue(id));
    },
  },
  {
    id: "actions",
    enableHiding: false,
    header: () => null,
    cell: ({ row }) => {
      const navigate = useNavigate();
      const data = row.original;

      if (isHoldingGroupRow(data)) {
        return <div className="flex items-center justify-end" />;
      }

      if (isStrategyGroupRow(data)) {
        return <div className="flex items-center justify-end" />;
      }

      const holding = data;
      const hasInstrument = !!holding.instrument;

      const handleNavigate = () => {
        const navSymbol = holding.instrument?.id ?? holding.id;
        navigate(`/holdings/${encodeURIComponent(navSymbol)}`, {
          state: { holding },
        });
      };

      return (
        <div className="flex items-center justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Icons.MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hasInstrument && onClassify && (
                <DropdownMenuItem onClick={() => onClassify(holding)}>
                  <Icons.Tag className="mr-2 h-4 w-4" />
                  Classify
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleNavigate}>
                <Icons.ChevronRight className="mr-2 h-4 w-4" />
                View Details
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    },
  },
];
