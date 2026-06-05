import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  reconcile,
  emptyState,
  loadState,
  saveState,
  type ObservedPosition,
  type SyncState,
} from '../src/state.js';

function mkPos(overrides: Partial<ObservedPosition> & { key: string }): ObservedPosition {
  return {
    contractDescription: overrides.contractDescription ?? overrides.key,
    occSymbol: null,
    instrumentType: 'EQUITY',
    expiration: null,
    quantity: '100',
    avgCost: '10.00',
    currency: 'USD',
    ...overrides,
  };
}

const TODAY = '2026-06-05';

describe('reconcile: equity closed', () => {
  it('moves a previously-live position absent this run into closing with kind CLOSED', () => {
    const prev: SyncState = {
      version: 1,
      live: {
        AAPL: {
          key: 'AAPL',
          contractDescription: 'Apple Inc.',
          occSymbol: null,
          instrumentType: 'EQUITY',
          expiration: null,
          quantity: '50',
          avgCost: '150.00',
          currency: 'USD',
          lastSeenDate: '2026-06-04',
        },
      },
      closing: {},
    };
    const { next, reinjections } = reconcile(prev, [], TODAY, 7);

    expect(next.live).toEqual({});
    expect(next.closing['AAPL']).toMatchObject({ kind: 'CLOSED', closedDate: TODAY });
    expect(reinjections).toHaveLength(1);
    expect(reinjections[0].key).toBe('AAPL');
  });
});

describe('reconcile: option expired', () => {
  it('marks a position EXPIRED when expiration <= today and absent this run', () => {
    const prev: SyncState = {
      version: 1,
      live: {
        'SPY240620C00500000': {
          key: 'SPY240620C00500000',
          contractDescription: 'SPY CALL',
          occSymbol: 'SPY240620C00500000',
          instrumentType: 'OPTION',
          expiration: '2026-06-04',
          quantity: '2',
          avgCost: '3.50',
          currency: 'USD',
          lastSeenDate: '2026-06-04',
        },
      },
      closing: {},
    };
    const { next, reinjections } = reconcile(prev, [], TODAY, 7);

    expect(next.closing['SPY240620C00500000']).toMatchObject({ kind: 'EXPIRED' });
    expect(reinjections[0].kind).toBe('EXPIRED');
  });
});

describe('reconcile: position revived', () => {
  it('moves a closing position back into live when it reappears non-zero', () => {
    const prev: SyncState = {
      version: 1,
      live: {},
      closing: {
        TSLA: {
          key: 'TSLA',
          contractDescription: 'Tesla',
          occSymbol: null,
          instrumentType: 'EQUITY',
          expiration: null,
          quantity: '10',
          avgCost: '200.00',
          currency: 'USD',
          lastSeenDate: '2026-06-03',
          closedDate: '2026-06-04',
          kind: 'CLOSED',
        },
      },
    };
    const observed = [mkPos({ key: 'TSLA', contractDescription: 'Tesla', quantity: '10' })];
    const { next, reinjections } = reconcile(prev, observed, TODAY, 7);

    expect(next.live['TSLA']).toBeDefined();
    expect(next.closing['TSLA']).toBeUndefined();
    expect(reinjections).toHaveLength(0);
  });
});

describe('reconcile: grace window prune', () => {
  it('drops closing entries older than graceDays', () => {
    const prev: SyncState = {
      version: 1,
      live: {},
      closing: {
        OLD: {
          key: 'OLD',
          contractDescription: 'OldCo',
          occSymbol: null,
          instrumentType: 'EQUITY',
          expiration: null,
          quantity: '5',
          avgCost: '50.00',
          currency: 'USD',
          lastSeenDate: '2026-05-25',
          closedDate: '2026-05-25', // 11 days before TODAY
          kind: 'CLOSED',
        },
      },
    };
    const { next, reinjections } = reconcile(prev, [], TODAY, 7);

    expect(next.closing['OLD']).toBeUndefined();
    expect(reinjections).toHaveLength(0);
  });
});

describe('loadState / saveState round-trip', () => {
  it('returns emptyState for non-existent path', async () => {
    const state = await loadState('/tmp/does-not-exist-xyz/state.json');
    expect(state).toEqual(emptyState());
  });

  it('round-trips live/closing through saveState + loadState', async () => {
    const tmpFile = path.join(os.tmpdir(), `snaptrade-state-test-${Date.now()}.json`);
    const state: SyncState = {
      version: 1,
      live: {
        MSFT: {
          key: 'MSFT',
          contractDescription: 'Microsoft',
          occSymbol: null,
          instrumentType: 'EQUITY',
          expiration: null,
          quantity: '20',
          avgCost: '300.00',
          currency: 'USD',
          lastSeenDate: TODAY,
        },
      },
      closing: {},
    };
    await saveState(tmpFile, state);
    const loaded = await loadState(tmpFile);
    expect(loaded.version).toBe(1);
    expect(loaded.live['MSFT']).toEqual(state.live['MSFT']);
    expect(loaded.closing).toEqual({});
  });
});
