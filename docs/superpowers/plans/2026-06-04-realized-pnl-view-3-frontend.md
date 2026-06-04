# Realized P&L View — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `/realized` page (sidebar nav item) that lists realized gain/loss per underlying in both local and base currency, sourced from a new `getRealizedPnl` adapter calling `GET /api/v1/realized-pnl`.

**Architecture:** A new shared adapter `getRealizedPnl(filter)` calls the backend read endpoint via the existing `invoke` dispatcher; the web dispatcher maps the `get_realized_pnl` command to `GET /realized-pnl` (account-scope aware, mirroring `get_income_summary`). The page component is modeled on `income-page.tsx`: a `useQuery` keyed by `[QueryKeys.REALIZED_PNL, accountFilter]`, a base-currency total card, a per-underlying ranked list (avatar + local + base), `AccountScopeSelector`, and balance privacy via `AmountDisplay`. Dual-surface parity is satisfied because the shared adapter is re-exported on both Tauri and Web indexes and the backend plan registers the matching Tauri command.

**Tech Stack:** React 19, TypeScript, TanStack Query v5, react-router-dom v7, Vitest + React Testing Library, `@wealthfolio/ui` components.

---

## File Structure

| File | Create/Modify | Responsibility |
| --- | --- | --- |
| `apps/frontend/src/lib/types.ts` | Modify | Add `RealizedPnlEntry`, `RealizedPnl` response types matching backend `RealizedPnlResponse`. |
| `apps/frontend/src/lib/query-keys.ts` | Modify | Add `REALIZED_PNL` query key. |
| `apps/frontend/src/adapters/shared/portfolio.ts` | Modify | Add `getRealizedPnl(filter?)` shared adapter that invokes `get_realized_pnl`. |
| `apps/frontend/src/adapters/web/core.ts` | Modify | Register `get_realized_pnl` in `COMMANDS` + add account-scope routing case (GET with `accountId`). |
| `apps/frontend/src/adapters/web/index.ts` | Modify | Re-export `getRealizedPnl` from `../shared/portfolio` (Tauri index already uses `export *`, no change there). |
| `apps/frontend/src/adapters/shared/portfolio.realized-pnl.test.ts` | Create (Test) | Unit test: `getRealizedPnl` invokes `get_realized_pnl` with the filter. |
| `apps/frontend/src/adapters/adapter-command-parity.test.ts` | (covers) | Existing parity test now also exercises `get_realized_pnl` (web COMMANDS + Tauri registry). No edit; must stay green. |
| `apps/frontend/src/pages/realized/realized-pnl-page.tsx` | Create | `RealizedPnlPage` component (default export): total card + per-underlying list + `AccountScopeSelector` + privacy. |
| `apps/frontend/src/pages/realized/realized-pnl-page.test.tsx` | Create (Test) | RTL test: renders base total + a row per underlying (incl. an HKD one), sorted by `|base|`. |
| `apps/frontend/src/routes.tsx` | Modify | Import + register `<Route path="realized" element={<RealizedPnlPage />} />`. |
| `apps/frontend/src/pages/layouts/navigation/app-navigation.tsx` | Modify | Add "Realized P&L" → `/realized` primary nav item. |

---

### Task 1: Types + query key for the realized response

**Files:**
- Modify `apps/frontend/src/lib/types.ts` (insert after the `IncomeSummary` interface, which ends at line 902)
- Modify `apps/frontend/src/lib/query-keys.ts` (after `INCOME_SUMMARY` at line 30)

- [ ] **Step 1: Add the `RealizedPnl` response types.**
  In `apps/frontend/src/lib/types.ts`, immediately after the closing brace of `IncomeSummary` (line 902, before the `// Define custom DateRange type` comment at line 904), insert:
  ```ts
  export interface RealizedPnlEntry {
    underlying: string;
    currency: string;
    realized: {
      local: number;
      base: number;
    };
  }

  export interface RealizedPnl {
    /** Base currency the `base` amounts are expressed in (a user setting; not
     *  assumed USD). Used to label base-currency amounts. */
    baseCurrency: string;
    entries: RealizedPnlEntry[];
    total: {
      base: number;
    };
  }
  ```
  (`local`/`base` are bare JSON numbers — the backend serializes `Decimal` via serde-float, same as `marketValue.local`/`.base` on `Holding`.)

- [ ] **Step 2: Add the `REALIZED_PNL` query key.**
  In `apps/frontend/src/lib/query-keys.ts`, after line 30 (`INCOME_SUMMARY: "incomeSummary",`), insert:
  ```ts
  REALIZED_PNL: "realizedPnl",
  ```

- [ ] **Step 3: Type-check passes (no test yet — these are pure type additions).**
  Run:
  ```bash
  pnpm --filter frontend type-check
  ```
  Expected: exits 0, no errors. (If it fails, the new interfaces have a syntax error — fix before continuing.)

- [ ] **Step 4: Commit.**
  ```bash
  git add apps/frontend/src/lib/types.ts apps/frontend/src/lib/query-keys.ts
  git commit -m "feat(frontend): add RealizedPnl types and REALIZED_PNL query key

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 2: `getRealizedPnl` shared adapter + web command routing

The shared adapter mirrors `getIncomeSummary` (`apps/frontend/src/adapters/shared/portfolio.ts:32-34`): a one-liner that calls `invoke<...>("get_realized_pnl", { filter })`. Both surfaces resolve it because Tauri's `adapters/tauri/index.ts:86` does `export * from "../shared/portfolio"` (auto-includes new exports) and the backend plan registers the `get_realized_pnl` Tauri command; for web we add it to `COMMANDS` and the explicit re-export list.

**Files:**
- Create `apps/frontend/src/adapters/shared/portfolio.realized-pnl.test.ts`
- Modify `apps/frontend/src/adapters/shared/portfolio.ts` (imports at lines 2-16; add export after `getIncomeSummary` at line 34)
- Modify `apps/frontend/src/adapters/web/core.ts` (`COMMANDS` map — add near `get_income_summary` at line 67; routing `switch` — add a case modeled on `get_income_summary` at lines 682-691)
- Modify `apps/frontend/src/adapters/web/index.ts` (named re-export list at lines 155-172)

- [ ] **Step 1: Write the failing adapter unit test.**
  Create `apps/frontend/src/adapters/shared/portfolio.realized-pnl.test.ts`:
  ```ts
  import { afterEach, describe, expect, it, vi } from "vitest";

  const invokeMock = vi.hoisted(() => vi.fn());

  vi.mock("./platform", () => ({
    invoke: invokeMock,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  }));

  import { getRealizedPnl } from "./portfolio";

  describe("getRealizedPnl", () => {
    afterEach(() => {
      invokeMock.mockReset();
    });

    it("invokes get_realized_pnl with the provided filter", async () => {
      const response = { baseCurrency: "USD", entries: [], total: { base: 0 } };
      invokeMock.mockResolvedValue(response);

      const result = await getRealizedPnl({ type: "account", accountId: "acc_1" });

      expect(invokeMock).toHaveBeenCalledWith("get_realized_pnl", {
        filter: { type: "account", accountId: "acc_1" },
      });
      expect(result).toBe(response);
    });

    it("invokes with undefined filter when none is given", async () => {
      invokeMock.mockResolvedValue({ baseCurrency: "USD", entries: [], total: { base: 0 } });

      await getRealizedPnl();

      expect(invokeMock).toHaveBeenCalledWith("get_realized_pnl", { filter: undefined });
    });
  });
  ```

- [ ] **Step 2: Run the test, see it fail (the export does not exist yet).**
  ```bash
  pnpm --filter frontend exec vitest run src/adapters/shared/portfolio.realized-pnl.test.ts
  ```
  Expected: FAIL — `getRealizedPnl` is not exported from `./portfolio` (TypeScript/import error, "No known export" / `getRealizedPnl is not a function`).

- [ ] **Step 3: Add the `RealizedPnl` import and `getRealizedPnl` adapter.**
  In `apps/frontend/src/adapters/shared/portfolio.ts`, add `RealizedPnl` to the type import block (it ends at line 16 with `AssetLotView,`). Change line 15-16:
  ```ts
    AssetLotView,
    RealizedPnl,
  } from "@/lib/types";
  ```
  Then, immediately after the `getIncomeSummary` export (line 34), insert:
  ```ts

  export const getRealizedPnl = async (filter?: AccountScope): Promise<RealizedPnl> => {
    return invoke<RealizedPnl>("get_realized_pnl", { filter });
  };
  ```
  (`AccountScope` is already imported at line 4.)

- [ ] **Step 4: Run the adapter test, see it pass.**
  ```bash
  pnpm --filter frontend exec vitest run src/adapters/shared/portfolio.realized-pnl.test.ts
  ```
  Expected: PASS — both tests green.

- [ ] **Step 5: Register `get_realized_pnl` in the web `COMMANDS` map and routing switch (makes the parity test pass).**
  In `apps/frontend/src/adapters/web/core.ts`, after the `get_income_summary` entry (line 67):
  ```ts
    get_realized_pnl: { method: "GET", path: "/realized-pnl" },
  ```
  Then add a routing case after the `get_income_summary` case (which ends at line 691, just before `case "get_goal":` at line 692). Insert:
  ```ts
      case "get_realized_pnl": {
        const p = payload as { filter?: { type: string; accountId?: string } };
        // The backend exposes ONLY GET /realized-pnl?accountId=... (no /query route).
        // Single-account scope -> ?accountId=<id>; all/portfolio -> no accountId,
        // and the backend merges across all holdings accounts.
        url =
          p?.filter?.type === "account" && p.filter.accountId
            ? `${API_PREFIX}/realized-pnl?accountId=${encodeURIComponent(p.filter.accountId)}`
            : `${API_PREFIX}/realized-pnl`;
        method = "GET";
        break;
      }
  ```
  (Unlike `get_income_summary` (which uses a POST `/income/summary/query` for non-account scopes), the realized read endpoint is GET-only — the backend plan exposes `GET /api/v1/realized-pnl?accountId=...` with `accountId` optional. So **every** scope routes to GET: a single account passes `?accountId=`, while all/portfolio omit it and the backend returns all holdings accounts merged. Portfolio-subset is treated as "all" — a documented MVP simplification; the user's realized data is a single account.)

- [ ] **Step 6: Add the named web re-export.**
  In `apps/frontend/src/adapters/web/index.ts`, inside the alphabetized block re-exporting from `"../shared/portfolio"` (lines 155-172), add `getRealizedPnl,` after `getPortfolioAllocations,` (line 165):
  ```ts
    getPortfolioAllocations,
    getRealizedPnl,
    getSnapshotByDate,
  ```

- [ ] **Step 7: Run the parity test + adapter test, see them pass.**
  ```bash
  pnpm --filter frontend exec vitest run src/adapters/adapter-command-parity.test.ts src/adapters/shared/portfolio.realized-pnl.test.ts
  ```
  Expected: PASS. The parity test's "registers every command reachable from the web adapter" check now finds `get_realized_pnl` in `COMMANDS`; the "Tauri adapter" check finds it in `apps/tauri/src/lib.rs` (registered by the backend plan). **If the Tauri-parity assertion fails with `get_realized_pnl: apps/frontend/src/adapters/shared/portfolio.ts`, the backend plan's Tauri command registration is not yet on this branch — that is the backend plan's deliverable; coordinate sequencing (see Open Question 2). Do not delete the adapter to make the test pass.**

- [ ] **Step 8: Type-check + lint.**
  ```bash
  pnpm --filter frontend type-check && pnpm --filter frontend lint
  ```
  Expected: both exit 0.

- [ ] **Step 9: Commit.**
  ```bash
  git add apps/frontend/src/adapters/shared/portfolio.ts apps/frontend/src/adapters/shared/portfolio.realized-pnl.test.ts apps/frontend/src/adapters/web/core.ts apps/frontend/src/adapters/web/index.ts
  git commit -m "feat(frontend): add getRealizedPnl adapter + web command routing

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 3: `RealizedPnlPage` component

Modeled on `income-page.tsx` but simpler: one base-currency total card + a per-underlying ranked list. Uses `useQuery<RealizedPnl, Error>` keyed `[QueryKeys.REALIZED_PNL, accountFilter]`, `AccountScopeSelector`, `useBalancePrivacy`, `AmountDisplay`, `TickerAvatar`, `EmptyPlaceholder`, `Skeleton`. The endpoint returns entries pre-sorted by `|base|` desc, but the component re-sorts defensively so the test does not depend on server ordering.

**Files:**
- Create `apps/frontend/src/pages/realized/realized-pnl-page.tsx`
- Create `apps/frontend/src/pages/realized/realized-pnl-page.test.tsx`

- [ ] **Step 1: Write the failing component test.**
  Create `apps/frontend/src/pages/realized/realized-pnl-page.test.tsx`:
  ```tsx
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { render, screen, waitFor } from "@testing-library/react";
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
  import type { RealizedPnl } from "@/lib/types";

  const getRealizedPnlMock = vi.hoisted(() => vi.fn());

  vi.mock("@/adapters", () => ({
    getRealizedPnl: getRealizedPnlMock,
  }));

  vi.mock("@/hooks/use-balance-privacy", () => ({
    useBalancePrivacy: () => ({ isBalanceHidden: false }),
  }));

  vi.mock("@/components/ticker-avatar", () => ({
    TickerAvatar: ({ symbol }: { symbol: string }) => <span data-testid="avatar">{symbol}</span>,
  }));

  vi.mock("@/components/account-filter-selector", () => ({
    AccountScopeSelector: () => <div data-testid="account-scope-selector" />,
  }));

  import RealizedPnlPage from "./realized-pnl-page";

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RealizedPnlPage />
      </QueryClientProvider>,
    );
  }

  const SAMPLE: RealizedPnl = {
    baseCurrency: "USD",
    entries: [
      { underlying: "TSLA", currency: "USD", realized: { local: -16923, base: -16923 } },
      { underlying: "2015", currency: "HKD", realized: { local: -57350, base: -7318 } },
      { underlying: "AAPL", currency: "USD", realized: { local: 4200, base: 4200 } },
    ],
    total: { base: -20041 },
  };

  describe("RealizedPnlPage", () => {
    beforeEach(() => {
      getRealizedPnlMock.mockResolvedValue(SAMPLE);
    });
    afterEach(() => {
      getRealizedPnlMock.mockReset();
    });

    it("renders the account scope selector", async () => {
      renderPage();
      expect(await screen.findByTestId("account-scope-selector")).toBeInTheDocument();
    });

    it("renders the base-currency total", async () => {
      renderPage();
      // -20041 formatted as currency contains the magnitude digits.
      expect(await screen.findByText(/20,041/)).toBeInTheDocument();
    });

    it("renders a row per underlying including the HKD one", async () => {
      renderPage();
      expect(await screen.findByText("TSLA")).toBeInTheDocument();
      expect(screen.getByText("2015")).toBeInTheDocument();
      expect(screen.getByText("AAPL")).toBeInTheDocument();
    });

    it("shows the HKD local currency for the Li Auto underlying", async () => {
      renderPage();
      // local HKD magnitude 57,350 is displayed alongside the base amount.
      expect(await screen.findByText(/57,350/)).toBeInTheDocument();
    });

    it("orders underlyings by absolute base descending (TSLA before 2015 before AAPL)", async () => {
      renderPage();
      await screen.findByText("TSLA");
      const rows = screen.getAllByTestId("realized-row");
      const order = rows.map((r) => r.getAttribute("data-underlying"));
      expect(order).toEqual(["TSLA", "2015", "AAPL"]);
    });
  });
  ```

- [ ] **Step 2: Run the test, see it fail (component does not exist).**
  ```bash
  pnpm --filter frontend exec vitest run src/pages/realized/realized-pnl-page.test.tsx
  ```
  Expected: FAIL — cannot resolve `./realized-pnl-page` (module not found).

- [ ] **Step 3: Implement `RealizedPnlPage`.**
  Create `apps/frontend/src/pages/realized/realized-pnl-page.tsx`:
  ```tsx
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

    const {
      data,
      isLoading,
      error,
    } = useQuery<RealizedPnl, Error>({
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
                {[...Array(8)].map((_, index) => (
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
  ```
  Notes: `AmountDisplay` is the barrel export from `@wealthfolio/ui` (confirmed: `packages/ui/src/index.ts:72` re-exports `./components/financial` which exports `AmountDisplay`). Base-currency amounts (the total card and each row's base value) use `data.baseCurrency` from the response — NOT a hard-coded `"USD"` — so a non-USD base setting renders correctly. The per-row local amount is shown only when `entry.currency !== data.baseCurrency` (so a same-as-base row doesn't duplicate). The HKD entry in the fixture exercises that differing-currency branch.

- [ ] **Step 4: Run the component test, see it pass.**
  ```bash
  pnpm --filter frontend exec vitest run src/pages/realized/realized-pnl-page.test.tsx
  ```
  Expected: PASS — all 5 assertions green (selector, total, three rows, HKD local, ordering).

- [ ] **Step 5: Type-check + lint.**
  ```bash
  pnpm --filter frontend type-check && pnpm --filter frontend lint
  ```
  Expected: both exit 0.

- [ ] **Step 6: Commit.**
  ```bash
  git add apps/frontend/src/pages/realized/realized-pnl-page.tsx apps/frontend/src/pages/realized/realized-pnl-page.test.tsx
  git commit -m "feat(frontend): add RealizedPnlPage with per-underlying ranked list

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 4: Route registration + sidebar nav item

**Files:**
- Modify `apps/frontend/src/routes.tsx` (import block lines 14-22; route registration lines 100-102)
- Modify `apps/frontend/src/pages/layouts/navigation/app-navigation.tsx` (primary nav array lines 20-70)
- Create the route render test inside `apps/frontend/src/pages/realized/realized-pnl-page.test.tsx` (append a route-registration describe block)

- [ ] **Step 1: Write a failing route + nav test (append to the existing component test file).**
  Append to `apps/frontend/src/pages/realized/realized-pnl-page.test.tsx`:
  ```tsx

  describe("realized nav registration", () => {
    it("exposes a Realized P&L nav item pointing at /realized", async () => {
      const nav = await import("@/pages/layouts/navigation/app-navigation");
      // useNavigation is a hook; assert against the static source list it derives from.
      const mod = nav as unknown as { __TEST_ONLY__?: unknown };
      void mod;
      // The static primary list lives in the module; verify via a render of the hook.
    });
  });
  ```
  (Replace the placeholder body in Step 3 once the nav item exists; the meaningful assertion is added there.) First, write the real assertion — replace the block above with:
  ```tsx

  import { renderHook } from "@testing-library/react";
  import { useNavigation } from "@/pages/layouts/navigation/app-navigation";

  describe("realized nav registration", () => {
    it("exposes a Realized P&L nav item pointing at /realized", () => {
      const { result } = renderHook(() => useNavigation());
      const item = result.current.primary.find((link) => link.href === "/realized");
      expect(item).toBeDefined();
      expect(item?.title).toBe("Realized P&L");
    });
  });
  ```
  Move the two new imports (`renderHook`, `useNavigation`) to the top of the file with the other imports.

- [ ] **Step 2: Run the test, see it fail (nav item absent).**
  ```bash
  pnpm --filter frontend exec vitest run src/pages/realized/realized-pnl-page.test.tsx -t "nav registration"
  ```
  Expected: FAIL — `item` is `undefined` (`expect(item).toBeDefined()` fails).

- [ ] **Step 3: Add the "Realized P&L" nav item.**
  In `apps/frontend/src/pages/layouts/navigation/app-navigation.tsx`, inside the `primary` array, add a new item after the Holdings entry (which ends at line 41, `},`) and before the Activities entry (line 42):
  ```ts
      {
        icon: <Icons.TrendingUp className="size-6" />,
        title: "Realized P&L",
        href: "/realized",
        keywords: ["realized", "pnl", "gains", "losses", "closed", "sold"],
        label: "View Realized P&L",
      },
  ```
  (`Icons.TrendingUp` is confirmed present in `packages/ui/src/components/ui/icons.tsx`.)

- [ ] **Step 4: Run the nav test, see it pass.**
  ```bash
  pnpm --filter frontend exec vitest run src/pages/realized/realized-pnl-page.test.tsx -t "nav registration"
  ```
  Expected: PASS.

- [ ] **Step 5: Register the route.**
  In `apps/frontend/src/routes.tsx`, add the import alongside the other page imports (after line 17 `import IncomePage from "@/pages/income/income-page";`):
  ```ts
  import RealizedPnlPage from "@/pages/realized/realized-pnl-page";
  ```
  Then register the route after the `income` route (line 100) and before `performance` (line 101):
  ```tsx
            <Route path="realized" element={<RealizedPnlPage />} />
  ```

- [ ] **Step 6: Type-check + lint + full file test.**
  ```bash
  pnpm --filter frontend type-check && pnpm --filter frontend lint && pnpm --filter frontend exec vitest run src/pages/realized/realized-pnl-page.test.tsx
  ```
  Expected: type-check 0, lint 0, all tests in the file PASS.

- [ ] **Step 7: Commit.**
  ```bash
  git add apps/frontend/src/routes.tsx apps/frontend/src/pages/layouts/navigation/app-navigation.tsx apps/frontend/src/pages/realized/realized-pnl-page.test.tsx
  git commit -m "feat(frontend): register /realized route and sidebar nav item

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 5: Full-suite regression check

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite.**
  ```bash
  pnpm --filter frontend exec vitest run
  ```
  Expected: all tests PASS, including the pre-existing `adapter-command-parity.test.ts`. If the Tauri-parity assertion fails for `get_realized_pnl`, the backend plan's Tauri command (`commands::portfolio::get_realized_pnl` in `apps/tauri/src/lib.rs`) is not yet merged on this branch — see Open Question 2; this is the only acceptable failure and must be resolved by sequencing the backend work first, not by removing the adapter.

- [ ] **Step 2: Final type-check + lint.**
  ```bash
  pnpm --filter frontend type-check && pnpm --filter frontend lint
  ```
  Expected: both exit 0.

- [ ] **Step 3: No commit (verification only). If the suite is green, the frontend layer is complete.**

---

## Verification Summary

Primary test command (single source of truth for "is the frontend done"):
```bash
pnpm --filter frontend exec vitest run
```
Supporting checks:
```bash
pnpm --filter frontend type-check
pnpm --filter frontend lint
```
