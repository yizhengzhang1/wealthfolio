import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addDays,
  daysBetween,
  emptyState,
  loadState,
  saveState,
  type SyncState,
} from '../src/state.js';

describe('state date helpers', () => {
  it('daysBetween counts whole UTC days', () => {
    expect(daysBetween('2026-06-03', '2026-06-04')).toBe(1);
    expect(daysBetween('2026-06-04', '2026-06-04')).toBe(0);
    expect(daysBetween('2026-06-04', '2026-06-02')).toBe(-2);
  });

  it('addDays shifts a UTC date string', () => {
    expect(addDays('2026-06-04', -1)).toBe('2026-06-03');
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
  });
});

describe('state load/save', () => {
  it('returns empty state when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-state-'));
    const state = await loadState(join(dir, 'nope.json'));
    expect(state).toEqual(emptyState());
  });

  it('round-trips a state object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-state-'));
    const path = join(dir, 'positions-state.json');
    const original: SyncState = {
      version: 1,
      live: {
        '1': {
          contractId: 1,
          contractDescription: 'ACME',
          occSymbol: null,
          instrumentType: 'EQUITY',
          expiration: null,
          quantity: '10',
          avgCost: '90',
          currency: 'USD',
          lastSeenDate: '2026-06-04',
        },
      },
      closing: {},
    };
    await saveState(path, original);
    expect(await loadState(path)).toEqual(original);
    // human-readable on disk
    expect(await readFile(path, 'utf8')).toContain('\n');
  });

  it('falls back to empty on malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ibkr-state-'));
    const path = join(dir, 'bad.json');
    await saveState(path, emptyState());
    await (await import('node:fs/promises')).writeFile(path, '{ not json', 'utf8');
    expect(await loadState(path)).toEqual(emptyState());
  });
});

import { reconcile, type ObservedPosition } from '../src/state.js';

function obs(overrides: Partial<ObservedPosition> = {}): ObservedPosition {
  return {
    contractId: 1,
    contractDescription: 'ACME',
    occSymbol: null,
    instrumentType: 'EQUITY',
    expiration: null,
    quantity: '10',
    avgCost: '90',
    currency: 'USD',
    ...overrides,
  };
}

describe('reconcile', () => {
  const TODAY = '2026-06-04';

  it('records a new non-zero position as live, nothing closing', () => {
    const { next, reinjections } = reconcile(emptyState(), [obs()], TODAY, 1);
    expect(next.live['1'].quantity).toBe('10');
    expect(next.live['1'].lastSeenDate).toBe(TODAY);
    expect(reinjections).toEqual([]);
  });

  it('classifies a vanished option as EXPIRED when expiration has passed', () => {
    const prev = reconcile(
      emptyState(),
      [obs({ contractId: 7, occSymbol: 'SPXW  260603P07500000', instrumentType: 'OPTION', expiration: '2026-06-03', quantity: '1', avgCost: '1.8' })],
      '2026-06-03',
      1,
    ).next;
    // next day it is gone from IBKR entirely
    const { next, reinjections } = reconcile(prev, [], TODAY, 1);
    expect(next.live['7']).toBeUndefined();
    expect(next.closing['7'].kind).toBe('EXPIRED');
    expect(next.closing['7'].quantity).toBe('1');
    expect(next.closing['7'].avgCost).toBe('1.8');
    expect(reinjections.map((r) => r.contractId)).toEqual([7]);
  });

  it('classifies a flat-but-not-expired option as CLOSED', () => {
    const prev = reconcile(
      emptyState(),
      [obs({ contractId: 8, occSymbol: 'INTC  260717P00100000', instrumentType: 'OPTION', expiration: '2026-07-17', quantity: '1', avgCost: '6.85' })],
      TODAY,
      1,
    ).next;
    // IBKR now reports it with quantity 0 (avg 0)
    const { next } = reconcile(prev, [obs({ contractId: 8, occSymbol: 'INTC  260717P00100000', instrumentType: 'OPTION', expiration: '2026-07-17', quantity: '0', avgCost: '0' })], TODAY, 1);
    expect(next.closing['8'].kind).toBe('CLOSED');
    expect(next.closing['8'].quantity).toBe('1'); // last non-zero retained
  });

  it('keeps a closing entry within grace, drops it after', () => {
    let state = reconcile(emptyState(), [obs({ contractId: 9, quantity: '5' })], '2026-06-04', 1).next;
    state = reconcile(state, [], '2026-06-04', 1).next; // closed today
    expect(state.closing['9']).toBeDefined();
    const day1 = reconcile(state, [], '2026-06-05', 1);
    expect(day1.next.closing['9']).toBeDefined(); // age 1 <= grace 1
    const day2 = reconcile(day1.next, [], '2026-06-06', 1);
    expect(day2.next.closing['9']).toBeUndefined(); // age 2 > grace 1
    expect(day2.reinjections).toEqual([]);
  });

  it('revives a closing position if it reappears non-zero', () => {
    let state = reconcile(emptyState(), [obs({ contractId: 11, quantity: '2' })], TODAY, 1).next;
    state = reconcile(state, [], TODAY, 1).next; // closed
    expect(state.closing['11']).toBeDefined();
    const back = reconcile(state, [obs({ contractId: 11, quantity: '3' })], TODAY, 1);
    expect(back.next.closing['11']).toBeUndefined();
    expect(back.next.live['11'].quantity).toBe('3');
  });

  it('warm-up: a position first seen already at qty 0 is ignored', () => {
    const { next, reinjections } = reconcile(emptyState(), [obs({ contractId: 12, quantity: '0', avgCost: '0' })], TODAY, 1);
    expect(next.live['12']).toBeUndefined();
    expect(next.closing['12']).toBeUndefined();
    expect(reinjections).toEqual([]);
  });
});
