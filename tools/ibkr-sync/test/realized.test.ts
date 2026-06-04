import { describe, expect, it } from 'vitest';
import { applyTradesToLedger, emptyLedger } from '../src/state.js';
import type { IbkrTrade } from '../src/ibkr.js';

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
