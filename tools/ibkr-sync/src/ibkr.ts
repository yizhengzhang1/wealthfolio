/**
 * IBKR MCP response types + parsers.
 *
 * This module never calls MCP at runtime. The orchestrator (S6) invokes the
 * MCP tools inside a Claude Code session and pipes the raw JSON through these
 * parsers. Keeping the parsers as pure functions lets us unit-test them
 * against captured fixtures.
 *
 * Field names are snake_case to mirror the IBKR MCP payload verbatim — see
 * docs/ibkr-sync/CONTEXT.md "IBKR MCP — Data Inventory".
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ibkrPositionSchema = z.object({
  contract_id: z.number(),
  contract_description: z.string(),
  position: z.number(),
  market_price: z.number(),
  market_value: z.number(),
  currency: z.string(),
  average_price: z.number(),
  unrealized_pnl: z.number(),
  asset_class: z.string().optional(),
});

const ibkrPositionsResponseSchema = z.object({
  positions: z.array(ibkrPositionSchema),
});

export const ibkrTradeSchema = z.object({
  trade_id: z.string(),
  symbol: z.string(),
  company_name: z.string().optional(),
  sec_type: z.enum(['STK', 'OPT', 'CASH']),
  currency: z.string(),
  side: z.enum(['BUY', 'SELL']),
  size: z.number(),
  price: z.number(),
  stop_price: z.number().optional(),
  formatted_price: z.string().optional(),
  order_type: z.string(),
  tif: z.string().optional(),
  description: z.string().optional(),
  trade_time: z.string(),
  exchange: z.string().optional(),
  commission: z.number(),
  net_amount: z.number(),
  realized_pnl: z.number(),
  order_id: z.number(),
});

const ibkrTradesResponseSchema = z.object({
  trades: z.array(ibkrTradeSchema),
});

export const ibkrBalanceSchema = z.object({
  currency: z.string(),
  cash_balance: z.number(),
  settled_cash: z.number().optional(),
  net_liquidation_value: z.number().optional(),
  stock_market_value: z.number().optional(),
  unrealized_pnl: z.number().optional(),
  realized_pnl: z.number().optional(),
  exchange_rate: z.number().optional(),
});

const ibkrBalancesResponseSchema = z.object({
  balances: z.array(ibkrBalanceSchema),
});

export const ibkrSummarySchema = z.object({
  currency: z.string(),
  net_liquidation: z.number(),
  equity_with_loan_value: z.number(),
  buying_power: z.number(),
  gross_position_value: z.number(),
  total_cash_value: z.number(),
  available_funds: z.number(),
  initial_margin: z.number(),
  maintenance_margin: z.number(),
  excess_liquidity: z.number(),
  dividends: z.number().optional(),
  day_trades_remaining: z.string().optional(),
  day_trades_remaining_t1: z.string().optional(),
  day_trades_remaining_t2: z.string().optional(),
  day_trades_remaining_t3: z.string().optional(),
  day_trades_remaining_t4: z.string().optional(),
  leverage: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types (derived from schemas)
// ---------------------------------------------------------------------------

export type IbkrPosition = z.infer<typeof ibkrPositionSchema>;
export type IbkrTrade = z.infer<typeof ibkrTradeSchema>;
export type IbkrSummary = z.infer<typeof ibkrSummarySchema>;
export type IbkrBalance = z.infer<typeof ibkrBalanceSchema>;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse `get_account_positions` MCP response. Accepts either the full
 * envelope `{positions: [...]}` or a bare array. Returns all positions
 * unchanged — option filtering happens at the mapping layer if/when needed,
 * since the snapshot path may still want OPT for display.
 */
export function parsePositions(raw: unknown): IbkrPosition[] {
  if (Array.isArray(raw)) {
    return z.array(ibkrPositionSchema).parse(raw);
  }
  return ibkrPositionsResponseSchema.parse(raw).positions;
}

/**
 * Parse `get_account_trades` MCP response. Accepts either the full envelope
 * `{trades: [...]}` or a bare array. Filters out `sec_type: CASH` (FX) and
 * `sec_type: OPT` (deferred to post-MVP per PLAN.md S3).
 */
export function parseTrades(raw: unknown): IbkrTrade[] {
  const trades = Array.isArray(raw)
    ? z.array(ibkrTradeSchema).parse(raw)
    : ibkrTradesResponseSchema.parse(raw).trades;
  return trades.filter((t) => t.sec_type === 'STK');
}

/**
 * Parse `get_account_trades` for the realized ledger. Unlike `parseTrades`
 * (STK-only, legacy), this keeps STK + OPT and drops only CASH/FX, because
 * realized P&L accrues on option closes too. Accepts envelope or bare array.
 */
export function parseTradesForRealized(raw: unknown): IbkrTrade[] {
  const trades = Array.isArray(raw)
    ? z.array(ibkrTradeSchema).parse(raw)
    : ibkrTradesResponseSchema.parse(raw).trades;
  return trades.filter((t) => t.sec_type !== 'CASH');
}

/** Parse `get_account_summary` MCP response. */
export function parseSummary(raw: unknown): IbkrSummary {
  return ibkrSummarySchema.parse(raw);
}

/**
 * Parse `get_account_balances` MCP response. Accepts envelope or array.
 * Drops the `BASE` pseudo-row (synthetic base-currency aggregate IBKR adds)
 * and any rows with `cash_balance === 0` (no point reporting empty wallets).
 */
export function parseBalances(raw: unknown): IbkrBalance[] {
  const all = Array.isArray(raw)
    ? z.array(ibkrBalanceSchema).parse(raw)
    : ibkrBalancesResponseSchema.parse(raw).balances;
  return all.filter((b) => b.currency !== 'BASE' && b.cash_balance !== 0);
}

/**
 * Count live orders from a `get_account_orders` response. We do NOT store
 * orders in Wealthfolio (no entity exists) — the count goes in the sync log.
 * Accepts an `{orders: []}` envelope or a bare array; 0 on anything unexpected.
 */
export function parseOrdersCount(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { orders?: unknown }).orders)) {
    return ((raw as { orders: unknown[] }).orders).length;
  }
  return 0;
}
