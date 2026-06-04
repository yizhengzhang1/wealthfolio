/**
 * Local sync state: remembers each position's last non-zero snapshot so that
 * positions which just closed (qty 0) or expired can be re-injected into the
 * pushed holdings snapshot for a short grace window. The hourly cron is the
 * only writer. See docs/ibkr-sync/2026-06-04-expiry-grace-design.md.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IbkrTrade } from './ibkr.js';
import { tradeAssetKey } from './mapping.js';

export type InstrumentKind = 'EQUITY' | 'OPTION';
export type ClosingKind = 'EXPIRED' | 'CLOSED';

/** One IBKR position as observed this run (quantity may be "0"). */
export interface ObservedPosition {
  contractId: number;
  contractDescription: string;
  occSymbol: string | null; // 21-char OCC for options, null for stocks
  instrumentType: InstrumentKind;
  expiration: string | null; // YYYY-MM-DD, options only
  quantity: string; // signed; "0" for closed rows
  avgCost: string;
  currency: string;
}

/** Last-known NON-ZERO snapshot of a position. */
export interface LivePosition {
  contractId: number;
  contractDescription: string;
  occSymbol: string | null;
  instrumentType: InstrumentKind;
  expiration: string | null;
  quantity: string; // signed, non-zero
  avgCost: string;
  currency: string;
  lastSeenDate: string; // YYYY-MM-DD
}

/** A position inside the grace window after closing/expiring. */
export interface ClosingPosition extends LivePosition {
  closedDate: string; // YYYY-MM-DD, first run that saw it gone
  kind: ClosingKind;
}

/** Cumulative realized P&L, accumulated from IBKR trades and deduped by
 *  trade_id. `cumulativeRealizedByAsset` is keyed by the same asset key the
 *  snapshot row uses (stock symbol, or `OPT:<symbol>` for options). */
export interface RealizedLedger {
  seenTradeIds: string[];
  cumulativeRealizedByAsset: Record<string, { amount: number; currency: string }>;
}

export interface SyncState {
  version: 2;
  lastRunUtc?: string;
  live: Record<string, LivePosition>;
  closing: Record<string, ClosingPosition>;
  realized: RealizedLedger;
}

export function emptyLedger(): RealizedLedger {
  return { seenTradeIds: [], cumulativeRealizedByAsset: {} };
}

export function emptyState(): SyncState {
  return { version: 2, live: {}, closing: {}, realized: emptyLedger() };
}

/**
 * Fold a batch of IBKR trades into a realized ledger. Pure.
 *  - each unseen trade_id adds its realized_pnl to its asset key and is marked seen;
 *  - already-seen trade_ids are ignored (dedup across overlapping lookback windows);
 *  - trades with no asset key (CASH/FX) are marked seen but contribute nothing.
 */
export function applyTradesToLedger(
  ledger: RealizedLedger,
  trades: IbkrTrade[],
): RealizedLedger {
  const seen = new Set(ledger.seenTradeIds);
  const byAsset: Record<string, { amount: number; currency: string }> = {
    ...ledger.cumulativeRealizedByAsset,
  };
  for (const t of trades) {
    if (seen.has(t.trade_id)) continue;
    seen.add(t.trade_id);
    const key = tradeAssetKey(t);
    if (key === null) continue;
    const prev = byAsset[key];
    byAsset[key] = { amount: (prev?.amount ?? 0) + t.realized_pnl, currency: t.currency };
  }
  return { seenTradeIds: [...seen], cumulativeRealizedByAsset: byAsset };
}

export async function loadState(path: string): Promise<SyncState> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      ((raw as { version: number }).version === 1 || (raw as { version: number }).version === 2) &&
      (raw as SyncState).live &&
      (raw as SyncState).closing
    ) {
      const s = raw as Omit<SyncState, 'version'> & { version: number };
      return { ...s, version: 2, realized: s.realized ?? emptyLedger() } as SyncState;
    }
    console.warn(`[ibkr-sync] state: unexpected shape at ${path}; starting empty`);
    return emptyState();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[ibkr-sync] state: unreadable ${path} (${code ?? String(err)}); starting empty`);
    }
    return emptyState();
  }
}

export async function saveState(path: string, state: SyncState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Whole UTC days from `from` to `to` (negative if `to` precedes `from`). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Shift a YYYY-MM-DD UTC date by `n` days. */
export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface ReconcileResult {
  next: SyncState;
  reinjections: ClosingPosition[];
}

function isNonZero(quantity: string): boolean {
  return Number(quantity) !== 0;
}

/**
 * Reconcile observed positions against prior state.
 *  - positions that left the non-zero set become `closing` (EXPIRED if their
 *    expiration is on/before `today`, else CLOSED), carrying their last-known
 *    non-zero quantity/avgCost;
 *  - reappearing positions are revived into `live`;
 *  - closing entries past the grace window (by close date, or by expiry for
 *    options) are dropped.
 * Pure: no I/O, no clock — `today` and `graceDays` are passed in.
 */
export function reconcile(
  prev: SyncState,
  observed: ObservedPosition[],
  today: string,
  graceDays: number,
): ReconcileResult {
  const next: SyncState = { version: 2, live: {}, closing: { ...prev.closing }, realized: prev.realized };

  const liveNow = observed.filter((p) => isNonZero(p.quantity));
  const liveNowIds = new Set(liveNow.map((p) => String(p.contractId)));

  // 1. newly closed: present in prior live, absent from current non-zero set.
  for (const [id, lp] of Object.entries(prev.live)) {
    if (!liveNowIds.has(id) && !next.closing[id]) {
      const expired = lp.expiration != null && lp.expiration <= today;
      next.closing[id] = { ...lp, closedDate: today, kind: expired ? 'EXPIRED' : 'CLOSED' };
    }
  }

  // 2. refresh live from this run; revive any that reappeared.
  for (const p of liveNow) {
    const id = String(p.contractId);
    next.live[id] = {
      contractId: p.contractId,
      contractDescription: p.contractDescription,
      occSymbol: p.occSymbol,
      instrumentType: p.instrumentType,
      expiration: p.expiration,
      quantity: p.quantity,
      avgCost: p.avgCost,
      currency: p.currency,
      lastSeenDate: today,
    };
    delete next.closing[id];
  }

  // 3. prune the grace window.
  for (const [id, c] of Object.entries(next.closing)) {
    const beyondClose = daysBetween(c.closedDate, today) > graceDays;
    const beyondExpiry = c.expiration != null && c.expiration < addDays(today, -graceDays);
    if (beyondClose || beyondExpiry) delete next.closing[id];
  }

  return { next, reinjections: Object.values(next.closing) };
}
