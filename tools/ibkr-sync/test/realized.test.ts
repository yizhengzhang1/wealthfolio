import { describe, expect, it, vi } from 'vitest';
import { applyTradesToLedger, emptyLedger, loadState, saveState, emptyState } from '../src/state.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IbkrTrade } from '../src/ibkr.js';
import { tradeAssetKey, positionAssetKey } from '../src/mapping.js';
import tradesFixture from '../fixtures/ibkr-trades.json' with { type: 'json' };
import { parseTradesForRealized } from '../src/ibkr.js';
import type { HoldingsPositionInput } from '../src/wealthfolio.js';

function trade(overrides: Partial<IbkrTrade> = {}): IbkrTrade {
  const base: IbkrTrade = {
    trade_id: 'tid-1',
    symbol: 'ACME',
    sec_type: 'STK',
    currency: 'USD',
    side: 'SELL',
    size: 100,
    price: 55,
    order_type: 'LIMIT',
    trade_time: '2026-05-30T10:00:00Z',
    commission: 0.5,
    net_amount: 5500,
    realized_pnl: 500,
    order_id: 1,
  };
  return { ...base, ...overrides };
}

describe('applyTradesToLedger', () => {
  it('accumulates realized_pnl per asset key from an empty ledger', () => {
    const next = applyTradesToLedger(emptyLedger(), [
      trade({ trade_id: 'a', symbol: 'ACME', realized_pnl: 500 }),
      trade({ trade_id: 'b', symbol: 'ACME', realized_pnl: 250 }),
      trade({ trade_id: 'c', symbol: '9999', currency: 'HKD', realized_pnl: -100 }),
    ]);
    expect(next.cumulativeRealizedByAsset).toEqual({ ACME: 750, '9999': -100 });
    expect(next.seenTradeIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not double-count when the same trades are re-applied (overlapping windows)', () => {
    const batch = [
      trade({ trade_id: 'a', symbol: 'ACME', realized_pnl: 500 }),
      trade({ trade_id: 'b', symbol: 'ACME', realized_pnl: 250 }),
    ];
    const first = applyTradesToLedger(emptyLedger(), batch);
    const second = applyTradesToLedger(first, [
      ...batch,
      trade({ trade_id: 'c', symbol: 'ACME', realized_pnl: 100 }),
    ]);
    expect(second.cumulativeRealizedByAsset).toEqual({ ACME: 850 });
    expect(second.seenTradeIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('marks CASH/FX trades seen but adds nothing', () => {
    const next = applyTradesToLedger(emptyLedger(), [
      trade({ trade_id: 'fx-1', sec_type: 'CASH', symbol: 'USD', realized_pnl: 0 }),
    ]);
    expect(next.cumulativeRealizedByAsset).toEqual({});
    expect(next.seenTradeIds).toEqual(['fx-1']);
  });
});

describe('tradeAssetKey', () => {
  it('keys a STK trade by its bare symbol', () => {
    expect(tradeAssetKey(trade({ sec_type: 'STK', symbol: 'ACME' }))).toBe('ACME');
  });
  it('keys an OPT trade by OPT:<symbol> (trades lack the full OCC)', () => {
    expect(tradeAssetKey(trade({ sec_type: 'OPT', symbol: 'ACME' }))).toBe('OPT:ACME');
  });
  it('returns null for CASH/FX trades', () => {
    expect(tradeAssetKey(trade({ sec_type: 'CASH', symbol: 'USD' }))).toBeNull();
  });
  it('maps every fixture STK trade to a non-null key', () => {
    const stk = parseTradesForRealized(tradesFixture).filter((t) => t.sec_type === 'STK');
    expect(stk.length).toBeGreaterThan(0);
    for (const t of stk) expect(tradeAssetKey(t)).toBe(t.symbol);
  });
});

describe('positionAssetKey', () => {
  function row(o: Partial<HoldingsPositionInput> = {}): HoldingsPositionInput {
    return { symbol: 'ACME', quantity: '10', currency: 'USD', instrumentType: 'EQUITY', ...o };
  }
  it('keys an EQUITY row by its symbol (matches a STK trade key)', () => {
    expect(positionAssetKey(row({ symbol: 'ACME', instrumentType: 'EQUITY' }))).toBe('ACME');
  });
  it('keys an OPTION row by its OCC symbol', () => {
    const r = row({ symbol: 'ACME  260702C00140000', instrumentType: 'OPTION' });
    expect(positionAssetKey(r)).toBe('ACME  260702C00140000');
  });
});

describe('applyTradesToLedger against the trades fixture', () => {
  it('accumulates the ACME STK close (500) and the ACME OPT close (200)', () => {
    const trades = parseTradesForRealized(tradesFixture);
    const ledger = applyTradesToLedger(emptyLedger(), trades);
    expect(ledger.cumulativeRealizedByAsset['ACME']).toBe(500);     // STK close
    expect(ledger.cumulativeRealizedByAsset['OPT:ACME']).toBe(200); // OPT close
  });
});

describe('loadState ledger migration', () => {
  it('loads an old v1 state file with no realized ledger as an empty ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-realized-'));
    const path = join(dir, 'positions-state.json');
    // a pre-ledger file: version 1, live/closing only, NO `realized` key
    await writeFile(
      path,
      JSON.stringify({ version: 1, live: {}, closing: {} }) + '\n',
      'utf8',
    );
    const state = await loadState(path);
    expect(state.version).toBe(2);
    expect(state.realized).toEqual({ seenTradeIds: [], cumulativeRealizedByAsset: {} });
    expect(state.live).toEqual({});
    expect(state.closing).toEqual({});
  });

  it('round-trips a v2 state including the ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-realized-'));
    const path = join(dir, 'positions-state.json');
    const state = emptyState();
    state.realized = { seenTradeIds: ['a'], cumulativeRealizedByAsset: { ACME: 500 } };
    await saveState(path, state);
    expect(await loadState(path)).toEqual(state);
  });
});

import { stampRealizedGain } from '../src/sync.js';

describe('stampRealizedGain', () => {
  it('stamps realizedGain on rows whose asset key is in the ledger', () => {
    const ledger = { seenTradeIds: ['x'], cumulativeRealizedByAsset: { ACME: 500, ZZZ: -100 } };
    const rows: HoldingsPositionInput[] = [
      { symbol: 'ACME', quantity: '10', currency: 'USD', instrumentType: 'EQUITY' },
      { symbol: 'NOPE', quantity: '5', currency: 'USD', instrumentType: 'EQUITY' },
    ];
    const out = stampRealizedGain(rows, ledger);
    expect(out[0].realizedGain).toBe(500);
    expect(out[1].realizedGain).toBeUndefined();
  });

  it('does not mutate the input rows', () => {
    const ledger = { seenTradeIds: [], cumulativeRealizedByAsset: { ACME: 500 } };
    const rows: HoldingsPositionInput[] = [
      { symbol: 'ACME', quantity: '10', currency: 'USD', instrumentType: 'EQUITY' },
    ];
    stampRealizedGain(rows, ledger);
    expect(rows[0].realizedGain).toBeUndefined();
  });
});

import { run } from '../src/sync.js';
import positionsFixture from '../fixtures/ibkr-positions.json' with { type: 'json' };

describe('sync run() dry-run carries realizedGain', () => {
  it('stamps ACME realized (500) onto the ACME stock row in the dry-run output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-sync-run-'));
    const rawPath = join(dir, 'raw.json');
    const statePath = join(dir, 'state.json');
    await writeFile(
      rawPath,
      JSON.stringify({ positions: positionsFixture, trades: tradesFixture }),
      'utf8',
    );

    const prevArgv = process.argv;
    const prevPwd = process.env.WEALTHFOLIO_PASSWORD;
    process.env.WEALTHFOLIO_PASSWORD = 'x';
    process.argv = ['node', 'sync.ts', `--from=${rawPath}`, `--state=${statePath}`, '--dry-run'];

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      lines.push(a.join(' '));
    });
    try {
      const code = await run();
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
      process.argv = prevArgv;
      process.env.WEALTHFOLIO_PASSWORD = prevPwd;
    }
    const out = lines.join('\n');
    expect(out).toContain('realized ACME');
    expect(out).toContain('500');
  });
});
