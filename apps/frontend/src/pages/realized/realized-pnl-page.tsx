import { getRealizedPnl } from "@/adapters";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import { TickerAvatar } from "@/components/ticker-avatar";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { QueryKeys } from "@/lib/query-keys";
import type { AccountScope, RealizedPnl } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { AmountDisplay } from "@wealthfolio/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { EmptyPlaceholder } from "@wealthfolio/ui/components/ui/empty-placeholder";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useState } from "react";

export default function RealizedPnlPage() {
  const { isBalanceHidden } = useBalancePrivacy();
  const [accountFilter, setAccountScope] = useState<AccountScope>({ type: "all" });

  const { data, isLoading, error } = useQuery<RealizedPnl, Error>({
    queryKey: [QueryKeys.REALIZED_PNL, accountFilter],
    queryFn: () => getRealizedPnl(accountFilter),
  });

  if (isLoading) {
    return <RealizedPnlSkeleton />;
  }

  if (error || !data) {
    return <div>Failed to load realized P&L: {error?.message || "Unknown error"}</div>;
  }

  const entries = [...data.entries].sort(
    (a, b) => Math.abs(b.realized.base) - Math.abs(a.realized.base),
  );

  return (
    <>
      <div className="pointer-events-auto fixed right-2 top-4 z-20 hidden items-center gap-2 md:flex lg:right-4">
        <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-end gap-2 md:hidden">
          <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />
        </div>

        <Card className="border-yellow-500/10 bg-yellow-500/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Realized P&L (YTD)</CardTitle>
            <Icons.TrendingUp className="text-muted-foreground h-4 w-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <AmountDisplay
                value={data.total.base}
                currency={data.baseCurrency}
                isHidden={isBalanceHidden}
                colorFormat
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Total realized gain/loss across all underlyings, in base currency
            </p>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Realized by Underlying</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {entries.length === 0 ? (
              <EmptyPlaceholder
                className="mx-auto flex h-[300px] max-w-[420px] items-center justify-center"
                icon={<Icons.TrendingUp className="h-10 w-10" />}
                title="No realized P&L recorded"
                description="There is no realized gain or loss for the selected accounts. Check back after closing positions."
              />
            ) : (
              <div className="space-y-4">
                {entries.map((entry) => (
                  <div
                    key={`${entry.underlying}:${entry.currency}`}
                    data-testid="realized-row"
                    data-underlying={entry.underlying}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2">
                      <TickerAvatar symbol={entry.underlying} className="size-8" />
                      <span className="text-sm font-medium">{entry.underlying}</span>
                    </div>
                    <div className="text-right">
                      <div className="text-sm">
                        <AmountDisplay
                          value={entry.realized.base}
                          currency={data.baseCurrency}
                          isHidden={isBalanceHidden}
                          colorFormat
                        />
                      </div>
                      {entry.currency !== data.baseCurrency && (
                        <div className="text-muted-foreground text-xs">
                          <AmountDisplay
                            value={entry.realized.local}
                            currency={entry.currency}
                            isHidden={isBalanceHidden}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function RealizedPnlSkeleton() {
  return (
    <div className="bg-background flex h-full flex-col">
      <main className="flex-1 space-y-6 px-4 py-6 md:px-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Skeleton className="h-4 w-[120px]" />
            <Skeleton className="h-4 w-4" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-[150px]" />
            <Skeleton className="mt-2 h-4 w-[200px]" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-[180px]" />
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="flex items-center justify-between">
                  <Skeleton className="h-8 w-[120px]" />
                  <Skeleton className="h-4 w-[80px]" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
