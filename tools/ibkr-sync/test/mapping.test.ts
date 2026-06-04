import { describe, expect, it } from 'vitest';

import type { IbkrPosition, IbkrTrade } from '../src/ibkr.js';
import {
  ibkrPositionToHoldingRow,
  ibkrTradeToActivity,
} from '../src/mapping.js';
import { ibkrPositionToObserved, parseOcc } from '../src/mapping.js';
import { reinjectionToHoldingsPosition } from '../src/mapping.js';
import type { ClosingPosition } from '../src/state.js';

const ACCOUNT_ID = 'acct-uuid-123';
const AS_OF = '2026-05-30T12:00:00Z';

// Minimal trade builder — every test starts from a valid BUY STK USD row
// and overrides only the field(s) under test. Keeps each table entry
// focused on the rule it exercises.
function makeTrade(overrides: Partial<IbkrTrade> = {}): IbkrTrade {
  const base: IbkrTrade = {
    trade_id: 'tid-1',
    symbol: 'AAPL',
    sec_type: 'STK',
    currency: 'USD',
    side: 'BUY',
    size: 10,
    price: 200,
    order_type: 'LIMIT',
    trade_time: '2026-05-30T10:00:00Z',
    commission: 1.0,
    net_amount: 2000,
    realized_pnl: 0,
    order_id: 42,
  };
  return { ...base, ...overrides };
}

function makePosition(overrides: Partial<IbkrPosition> = {}): IbkrPosition {
  const base: IbkrPosition = {
    contract_id: 1,
    contract_description: 'AAPL',
    position: 10,
    market_price: 200,
    market_value: 2000,
    currency: 'USD',
    average_price: 180,
    unrealized_pnl: 200,
    asset_class: 'STK',
  };
  return { ...base, ...overrides };
}

describe('ibkrTradeToActivity', () => {
  it('maps a BUY STK USD trade end-to-end', () => {
    const trade = makeTrade();
    const activity = ibkrTradeToActivity(trade, ACCOUNT_ID);

    expect(activity).toEqual({
      accountId: ACCOUNT_ID,
      activityType: 'BUY',
      activityDate: '2026-05-30T10:00:00Z',
      quantity: 10,
      unitPrice: 200,
      currency: 'USD',
      fee: 1.0,
      asset: { symbol: 'AAPL', quoteCcy: 'USD' },
      sourceSystem: 'IBKR',
      sourceRecordId: 'tid-1',
      idempotencyKey: 'ibkr:tid-1',
    });
  });

  it('maps a SELL STK HKD trade and propagates HKD currency', () => {
    const trade = makeTrade({
      trade_id: 'tid-002',
      symbol: '9999',
      currency: 'HKD',
      side: 'SELL',
      size: 1000,
      price: 50,
      commission: 10,
    });
    const activity = ibkrTradeToActivity(trade, ACCOUNT_ID);

    expect(activity).not.toBeNull();
    expect(activity!.activityType).toBe('SELL');
    expect(activity!.currency).toBe('HKD');
    expect(activity!.asset.quoteCcy).toBe('HKD');
    expect(activity!.asset.symbol).toBe('9999');
    expect(activity!.quantity).toBe(1000);
    expect(activity!.unitPrice).toBe(50);
    expect(activity!.fee).toBe(10);
    expect(activity!.idempotencyKey).toBe('ibkr:tid-002');
  });

  it('defaults fee to 0 when commission is missing', () => {
    const trade = makeTrade({ commission: undefined });
    const activity = ibkrTradeToActivity(trade, ACCOUNT_ID);
    expect(activity!.fee).toBe(0);
  });

  it('idempotencyKey is prefixed with "ibkr:" and uses raw trade_id', () => {
    const trade = makeTrade({ trade_id: 'CRS:1234567890' });
    const activity = ibkrTradeToActivity(trade, ACCOUNT_ID);
    expect(activity!.idempotencyKey).toBe('ibkr:CRS:1234567890');
    expect(activity!.sourceRecordId).toBe('CRS:1234567890');
  });

  it('asset.quoteCcy mirrors the trade currency', () => {
    const trade = makeTrade({ currency: 'CNH' });
    const activity = ibkrTradeToActivity(trade, ACCOUNT_ID);
    expect(activity!.asset.quoteCcy).toBe('CNH');
    expect(activity!.currency).toBe('CNH');
  });

  // Table-driven skip cases. Each row asserts the row is rejected (-> null).
  it.each([
    { label: 'sec_type=OPT', overrides: { sec_type: 'OPT' as const } },
    { label: 'sec_type=CASH', overrides: { sec_type: 'CASH' as const } },
    { label: 'size=0', overrides: { size: 0 } },
    { label: 'size negative', overrides: { size: -1 } },
    { label: 'price=0 (corp action)', overrides: { price: 0 } },
    { label: 'price negative', overrides: { price: -5 } },
    {
      label: 'side=OTHER',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      overrides: { side: 'OTHER' as any },
    },
  ])('returns null when $label', ({ overrides }) => {
    const trade = makeTrade(overrides as Partial<IbkrTrade>);
    expect(ibkrTradeToActivity(trade, ACCOUNT_ID)).toBeNull();
  });
});

describe('ibkrPositionToHoldingRow', () => {
  it('maps a long STK position to a SnapshotRow', () => {
    const pos = makePosition({
      contract_description: 'ACME',
      position: 6.2,
      average_price: 90,
      market_value: 620,
    });
    const row = ibkrPositionToHoldingRow(pos, ACCOUNT_ID, AS_OF);

    expect(row).toEqual({
      accountId: ACCOUNT_ID,
      symbol: 'ACME',
      quoteCcy: 'USD',
      quantity: 6.2,
      averageCost: 90,
      marketValue: 620,
      asOf: AS_OF,
    });
  });

  it('treats missing asset_class as STK (MVP — see code comment)', () => {
    // CONTEXT.md notes the field is sometimes absent on real STK rows.
    const pos = makePosition({ asset_class: undefined });
    const row = ibkrPositionToHoldingRow(pos, ACCOUNT_ID, AS_OF);
    expect(row).not.toBeNull();
    expect(row!.symbol).toBe('AAPL');
  });

  // Table-driven skip cases.
  it.each([
    {
      label: 'asset_class=OPT',
      overrides: { asset_class: 'OPT' as const },
    },
    { label: 'position=0', overrides: { position: 0 } },
    { label: 'position negative (short)', overrides: { position: -2 } },
  ])('returns null when $label', ({ overrides }) => {
    const pos = makePosition(overrides as Partial<IbkrPosition>);
    expect(ibkrPositionToHoldingRow(pos, ACCOUNT_ID, AS_OF)).toBeNull();
  });
});

describe('ibkrPositionToObserved', () => {
  it('maps a stock position', () => {
    const o = ibkrPositionToObserved(makePosition({ contract_description: 'IBKR', position: 6.2, average_price: 69 }));
    expect(o).toEqual({
      contractId: 1,
      contractDescription: 'IBKR',
      occSymbol: null,
      instrumentType: 'EQUITY',
      expiration: null,
      quantity: '6.2',
      avgCost: '69',
      currency: 'USD',
    });
  });

  it('maps an option position and pulls expiration from the OCC symbol', () => {
    const o = ibkrPositionToObserved(
      makePosition({
        contract_id: 877985483,
        contract_description: 'SPX    JUN2026 7450 P [SPXW  260604P07450000 100]',
        position: 1,
        average_price: 1.8164,
      }),
    );
    expect(o.instrumentType).toBe('OPTION');
    expect(o.occSymbol).toBe('SPXW  260604P07450000');
    expect(o.expiration).toBe('2026-06-04');
    expect(o.quantity).toBe('1');
  });

  it('preserves quantity 0 for closed rows', () => {
    const o = ibkrPositionToObserved(makePosition({ position: 0, average_price: 0 }));
    expect(o.quantity).toBe('0');
  });
});

describe('parseOcc', () => {
  it('parses a raw 21-char OCC symbol', () => {
    expect(parseOcc('SPXW  260604P07450000')).toEqual({
      occSymbol: 'SPXW  260604P07450000',
      underlying: 'SPXW',
      expiration: '2026-06-04',
      right: 'PUT',
      strike: '7450',
      multiplier: 100,
    });
  });

  it('returns null for a malformed symbol', () => {
    expect(parseOcc('NOTANOCC')).toBeNull();
  });
});

function closing(overrides: Partial<ClosingPosition> = {}): ClosingPosition {
  return {
    contractId: 7,
    contractDescription: 'SPX ...',
    occSymbol: 'SPXW  260603P07500000',
    instrumentType: 'OPTION',
    expiration: '2026-06-03',
    quantity: '1',
    avgCost: '1.8',
    currency: 'USD',
    lastSeenDate: '2026-06-03',
    closedDate: '2026-06-04',
    kind: 'EXPIRED',
    ...overrides,
  };
}

describe('reinjectionToHoldingsPosition', () => {
  it('EXPIRED option keeps avgCost so the backend shows the full loss', () => {
    expect(reinjectionToHoldingsPosition(closing())).toEqual({
      symbol: 'SPXW  260603P07500000',
      quantity: '1',
      avgCost: '1.8',
      currency: 'USD',
      instrumentType: 'OPTION',
    });
  });

  it('CLOSED position forces avgCost 0 (informational $0 row)', () => {
    const row = reinjectionToHoldingsPosition(
      closing({ kind: 'CLOSED', expiration: '2026-07-17', occSymbol: 'INTC  260717P00100000', avgCost: '6.85' }),
    );
    expect(row.avgCost).toBe('0');
    expect(row.symbol).toBe('INTC  260717P00100000');
  });

  it('CLOSED stock uses contract_description as the symbol', () => {
    const row = reinjectionToHoldingsPosition(
      closing({ kind: 'CLOSED', instrumentType: 'EQUITY', occSymbol: null, contractDescription: 'RKLB' }),
    );
    expect(row).toEqual({ symbol: 'RKLB', quantity: '1', avgCost: '0', currency: 'USD', instrumentType: 'EQUITY' });
  });
});
