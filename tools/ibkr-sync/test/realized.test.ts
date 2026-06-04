import { describe, expect, it } from 'vitest';
import { applyTradesToLedger, emptyLedger } from '../src/state.js';
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
