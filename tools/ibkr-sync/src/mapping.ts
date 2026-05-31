// Pure IBKR -> Wealthfolio mapping functions.
//
// No I/O, no logging — callers decide what to do with `null` returns.
// Mapping rules: docs/ibkr-sync/CONTEXT.md "Field Mapping" + API-NOTES.md
// (Wealthfolio JSON is camelCase, IBKR JSON is snake_case).

import type { IbkrTrade, IbkrPosition } from './ibkr.js';
import type {
  ActivityInput,
  HoldingsPositionInput,
} from './wealthfolio.js';

// ---------------------------------------------------------------------------
// Trades → Activities (legacy, kept for the test suite and ad-hoc use)
// ---------------------------------------------------------------------------

/**
 * Single-row holdings snapshot — kept for backwards compatibility with the
 * old test suite. New code should use `ibkrPositionToHoldingsPosition` and
 * post via `client.importHoldingsSnapshot`.
 */
export interface SnapshotRow {
  accountId: string;
  symbol: string;
  quoteCcy: string;
  quantity: number;
  averageCost: number;
  marketValue?: number;
  asOf: string;
}

/**
 * Map one IBKR trade row to one Wealthfolio `ActivityInput`.
 *
 * Returns `null` when the row must be skipped:
 *   - `sec_type` other than STK.
 *   - `size <= 0` or `price <= 0` (corporate-action / data-quality skips).
 *   - `side` is neither BUY nor SELL.
 *
 * Caller is responsible for logging skip reasons; this stays pure.
 */
export function ibkrTradeToActivity(
  trade: IbkrTrade,
  accountId: string,
): ActivityInput | null {
  if (trade.sec_type !== 'STK') return null;
  if (trade.side !== 'BUY' && trade.side !== 'SELL') return null;
  if (!(trade.size > 0)) return null;
  if (!(trade.price > 0)) return null;

  return {
    accountId,
    activityType: trade.side,
    activityDate: trade.trade_time,
    quantity: trade.size,
    unitPrice: trade.price,
    currency: trade.currency,
    fee: trade.commission ?? 0,
    asset: {
      symbol: trade.symbol,
      quoteCcy: trade.currency,
    },
    sourceSystem: 'IBKR',
    sourceRecordId: trade.trade_id,
    idempotencyKey: `ibkr:${trade.trade_id}`,
  };
}

/** Legacy: see CONTEXT.md. Kept so prior tests keep passing. New code uses
 *  `ibkrPositionToHoldingsPosition`. */
export function ibkrPositionToHoldingRow(
  pos: IbkrPosition,
  accountId: string,
  asOf: string,
): SnapshotRow | null {
  if (pos.asset_class !== undefined && pos.asset_class !== 'STK') return null;
  if (!(pos.position > 0)) return null;
  return {
    accountId,
    symbol: pos.contract_description,
    quoteCcy: pos.currency,
    quantity: pos.position,
    averageCost: pos.average_price,
    marketValue: pos.market_value,
    asOf,
  };
}

// ---------------------------------------------------------------------------
// Positions → HoldingsPositionInput (current sync flow)
// ---------------------------------------------------------------------------

export interface ParsedOptionContract {
  /** Standard 21-char OCC option symbol, e.g. `ACME  260702C00140000`.
   *  Wealthfolio's `build_asset_metadata` parses this on its own. */
  occSymbol: string;
  /** Underlying ticker, e.g. `ACME`. */
  underlying: string;
  /** Contract multiplier — almost always 100 for equity options. */
  multiplier: number;
}

/**
 * Extract an OCC option spec from an IBKR position's `contract_description`.
 *
 * IBKR formats option positions as:
 *   "ACME   JUL2026 140 C [ACME  260702C00140000 100]"
 *                         └──── bracket payload ────┘
 *
 * The bracket payload is `<OCC symbol> <multiplier>`, where the OCC symbol
 * itself contains a (padded) space-padded underlying — so we split on the
 * LAST space, not the first.
 *
 * Returns `null` for stock rows (no bracket) or malformed strings.
 */
export function parseOccFromContractDescription(
  desc: string,
): ParsedOptionContract | null {
  const bracketStart = desc.indexOf('[');
  const bracketEnd = desc.indexOf(']');
  if (bracketStart < 0 || bracketEnd < 0 || bracketEnd < bracketStart) {
    return null;
  }
  const inner = desc.slice(bracketStart + 1, bracketEnd).trim();
  const lastSpace = inner.lastIndexOf(' ');
  if (lastSpace < 0) return null;

  const occSymbol = inner.slice(0, lastSpace);
  const multiplierStr = inner.slice(lastSpace + 1).trim();
  const multiplier = Number(multiplierStr);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;

  // OCC is 21 chars (6 padded ticker + 6 YYMMDD + 1 C/P + 8 strike).
  if (occSymbol.length !== 21) return null;

  const underlying = occSymbol.slice(0, 6).trim();
  if (!underlying) return null;

  return { occSymbol, underlying, multiplier };
}

/**
 * Fully parsed option spec, ready to drop into an OptionSpec metadata blob.
 */
export interface ParsedOption {
  /** 21-char OCC symbol, e.g. `ACME  260702C00140000`. */
  occSymbol: string;
  /** Underlying ticker, e.g. `ACME`. */
  underlying: string;
  /** ISO date `YYYY-MM-DD`. */
  expiration: string;
  right: 'CALL' | 'PUT';
  /** Strike price, formatted as a plain decimal string ("140" or "70.5"). */
  strike: string;
  /** Contract multiplier — usually 100. */
  multiplier: number;
}

/**
 * Parse an IBKR option position into a fully-typed spec. Returns `null` for
 * stock rows or malformed strings. Uses the bracketed OCC payload —
 * see `parseOccFromContractDescription`.
 */
export function parseOptionPosition(pos: IbkrPosition): ParsedOption | null {
  const occ = parseOccFromContractDescription(pos.contract_description);
  if (!occ) return null;

  const s = occ.occSymbol; // 21 chars guaranteed by parseOccFromContractDescription
  const underlying = s.slice(0, 6).trim();
  const yymmdd = s.slice(6, 12);
  const yy = yymmdd.slice(0, 2);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  // OCC date is YY only — same century assumption as the rest of the industry.
  const expiration = `20${yy}-${mm}-${dd}`;
  const rightChar = s[12];
  if (rightChar !== 'C' && rightChar !== 'P') return null;
  const right: 'CALL' | 'PUT' = rightChar === 'C' ? 'CALL' : 'PUT';
  const strikeRaw = s.slice(13);
  if (!/^\d{8}$/.test(strikeRaw)) return null;
  const strikeNum = Number(strikeRaw) / 1000;
  // Drop trailing zeros for cleaner display (`"140"` not `"140.000"`).
  const strike = String(strikeNum);

  return {
    occSymbol: s,
    underlying,
    expiration,
    right,
    strike,
    multiplier: occ.multiplier,
  };
}

/**
 * Map one IBKR position row to a Wealthfolio holdings-snapshot position.
 *
 * Handles both stocks and options:
 *   - Stocks (no bracket in `contract_description`):
 *       symbol = contract_description, instrumentType = "EQUITY"
 *   - Options (bracket present):
 *       symbol = parsed OCC string, instrumentType = "OPTION"
 *       NOTE: the snapshot-import path does NOT derive option metadata from the
 *       OCC symbol — get_or_create_minimal_asset never calls build_asset_metadata.
 *       Strike/expiry/right come from sync.ts pre-creating the asset via
 *       POST /assets with an explicit metadata.option blob. (contract_multiplier
 *       still falls back to 100 for any OPTION asset, even without metadata.)
 *
 * Quantities preserve their sign — short option positions (negative
 * `position`) are passed through so Wealthfolio shows them as shorts.
 *
 * Returns `null` for closed rows (position === 0) and unparseable options.
 */
export function ibkrPositionToHoldingsPosition(
  pos: IbkrPosition,
): HoldingsPositionInput | null {
  if (pos.position === 0) return null;

  const desc = pos.contract_description;
  const occ = parseOccFromContractDescription(desc);

  if (occ === null) {
    // Stock row.
    const symbol = desc.trim();
    if (!symbol) return null;
    return {
      symbol,
      quantity: String(pos.position),
      avgCost: String(pos.average_price),
      currency: pos.currency,
      instrumentType: 'EQUITY',
    };
  }

  // Option row. The snapshot importer does NOT parse the OCC symbol; sync.ts
  // pre-creates this asset (POST /assets with metadata.option) so strike/expiry/
  // right are populated, and passes the resulting asset UUID back as
  // `assetId` to bind this row to it. `avgCost` is per-share (IBKR convention).
  return {
    symbol: occ.occSymbol,
    quantity: String(pos.position),
    avgCost: String(pos.average_price),
    currency: pos.currency,
    instrumentType: 'OPTION',
  };
}
