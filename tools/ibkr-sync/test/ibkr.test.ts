import { describe, it, expect } from 'vitest';
import {
  parsePositions,
  parseTrades,
  parseSummary,
} from '../src/ibkr.js';
import positionsFixture from '../fixtures/ibkr-positions.json' with { type: 'json' };
import tradesFixture from '../fixtures/ibkr-trades.json' with { type: 'json' };
import summaryFixture from '../fixtures/ibkr-summary.json' with { type: 'json' };

describe('parsePositions', () => {
  it('parses the fixture and keeps both STK and OPT rows', () => {
    const positions = parsePositions(positionsFixture);
    expect(positions).toHaveLength(positionsFixture.positions.length);

    // STK row (plain ticker, no bracket) preserved.
    const stk = positions.find((p) => p.contract_description === 'ACME');
    expect(stk).toBeDefined();
    expect(stk!.position).toBe(6.2);
    expect(stk!.currency).toBe('USD');

    // OPT rows preserved (no filtering at the position layer).
    const opts = positions.filter((p) =>
      p.contract_description.includes('JUL2026'),
    );
    expect(opts.length).toBeGreaterThan(0);
  });

  it('accepts a bare array as well as the envelope', () => {
    const bare = parsePositions(positionsFixture.positions);
    const wrapped = parsePositions(positionsFixture);
    expect(bare).toEqual(wrapped);
  });

  it('throws on null', () => {
    expect(() => parsePositions(null)).toThrow();
  });
});

describe('parseTrades', () => {
  it('parses the fixture and filters out CASH + OPT rows', () => {
    const trades = parseTrades(tradesFixture);

    // Every survivor is STK.
    expect(trades.every((t) => t.sec_type === 'STK')).toBe(true);

    // No CASH/OPT in result.
    expect(trades.find((t) => t.sec_type === 'CASH' as never)).toBeUndefined();
    expect(trades.find((t) => t.sec_type === 'OPT' as never)).toBeUndefined();

    // BUY STK preserved.
    const buy = trades.find((t) => t.side === 'BUY' && t.symbol === 'ACME');
    expect(buy).toBeDefined();
    expect(buy!.size).toBe(100);
    expect(buy!.price).toBe(50);

    // SELL STK preserved (HKD, multi-currency).
    const sell = trades.find((t) => t.side === 'SELL' && t.symbol === '9999');
    expect(sell).toBeDefined();
    expect(sell!.currency).toBe('HKD');
    expect(sell!.size).toBe(1000);
  });

  it('matches the expected survivor count from the fixture', () => {
    const stkCount = tradesFixture.trades.filter(
      (t) => t.sec_type === 'STK',
    ).length;
    expect(parseTrades(tradesFixture)).toHaveLength(stkCount);
  });

  it('accepts a bare array', () => {
    const bare = parseTrades(tradesFixture.trades);
    const wrapped = parseTrades(tradesFixture);
    expect(bare).toEqual(wrapped);
  });

  it('returns [] for empty input', () => {
    expect(parseTrades([])).toEqual([]);
    expect(parseTrades({ trades: [] })).toEqual([]);
  });

  it('throws on null', () => {
    expect(() => parseTrades(null)).toThrow();
  });
});

describe('parseSummary', () => {
  it('parses the fixture', () => {
    const summary = parseSummary(summaryFixture);
    expect(summary.currency).toBe('USD');
    expect(summary.net_liquidation).toBeCloseTo(12345.67, 4);
    expect(summary.buying_power).toBeGreaterThan(0);
  });

  it('throws on null', () => {
    expect(() => parseSummary(null)).toThrow();
  });

  it('throws when a required field is missing', () => {
    const { net_liquidation: _ignore, ...incomplete } = summaryFixture;
    expect(() => parseSummary(incomplete)).toThrow();
  });
});
