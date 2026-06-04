/**
 * Local sync state: remembers each position's last non-zero snapshot so that
 * positions which just closed (qty 0) or expired can be re-injected into the
 * pushed holdings snapshot for a short grace window. The hourly cron is the
 * only writer. See docs/ibkr-sync/2026-06-04-expiry-grace-design.md.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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

export interface SyncState {
  version: 1;
  lastRunUtc?: string;
  live: Record<string, LivePosition>;
  closing: Record<string, ClosingPosition>;
}

export function emptyState(): SyncState {
  return { version: 1, live: {}, closing: {} };
}

export async function loadState(path: string): Promise<SyncState> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      (raw as SyncState).version === 1 &&
      (raw as SyncState).live &&
      (raw as SyncState).closing
    ) {
      return raw as SyncState;
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
