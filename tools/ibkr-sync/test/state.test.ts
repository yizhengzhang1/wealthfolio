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
