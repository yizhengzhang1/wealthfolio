/**
 * Tests for WealthfolioClient.
 *
 * Two suites:
 *  - Unit (always run): mock fetch, exercise retry / 401 / dedupe behavior.
 *  - Integration (skipped unless WF_INTEGRATION=1): hit the real self-host
 *    at http://localhost:8088 using the password from
 *    docs/ibkr-sync/secrets.local.md or WEALTHFOLIO_PASSWORD env var.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  WealthfolioApiError,
  WealthfolioClient,
  type AccountInput,
  type ActivityInput,
} from '../src/wealthfolio.js';

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

interface MockResponse {
  status: number;
  body?: unknown;
  /** Raw string body, used when we want to control exact bytes (e.g. error
   *  message strings the client greps). Wins over `body`. */
  text?: string;
  /** Set-Cookie header values (use getSetCookie-shaped multi-value support). */
  setCookie?: string[];
}

function makeResponse(r: MockResponse): Response {
  const headers = new Headers();
  if (r.setCookie?.length) {
    // Headers.append on `set-cookie` produces the right multi-value shape on
    // Node 20+ (undici exposes getSetCookie).
    for (const v of r.setCookie) headers.append('set-cookie', v);
  }
  const bodyText =
    r.text !== undefined
      ? r.text
      : r.body !== undefined
        ? JSON.stringify(r.body)
        : '';
  if (r.body !== undefined && r.text === undefined) {
    headers.set('content-type', 'application/json');
  }
  return new Response(bodyText, { status: r.status, headers });
}

const LOGIN_OK: MockResponse = {
  status: 200,
  body: { authenticated: true, expiresIn: 3600 },
  setCookie: ['wf_session=jwt-token-1; Path=/api; HttpOnly; SameSite=Lax'],
};

const ACCOUNT_FIXTURE = {
  id: 'acct-1',
  name: 'IBKR-Test',
  accountType: 'SECURITIES',
  currency: 'USD',
  trackingMode: 'TRANSACTIONS',
  provider: 'IBKR',
  providerAccountId: 'TEST-IBKR-ACCT',
};

function newAccountInput(): AccountInput & { providerAccountId: string } {
  return {
    name: 'IBKR-Test',
    accountType: 'SECURITIES',
    currency: 'USD',
    provider: 'IBKR',
    providerAccountId: 'TEST-IBKR-ACCT',
    trackingMode: 'TRANSACTIONS',
    isActive: true,
  };
}

function newActivityInput(idempotencyKey: string): ActivityInput {
  return {
    accountId: 'acct-1',
    activityType: 'BUY',
    activityDate: '2026-05-30T10:00:00Z',
    quantity: '10',
    unitPrice: '200.00',
    fee: '1.00',
    currency: 'USD',
    asset: { symbol: 'AAPL', quoteCcy: 'USD' },
    idempotencyKey,
    sourceSystem: 'IBKR',
    sourceRecordId: idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// Unit tests — mock fetch
// ---------------------------------------------------------------------------

describe('WealthfolioClient (unit, mocked fetch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sleepMock: ReturnType<typeof vi.fn>;
  let client: WealthfolioClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    sleepMock = vi.fn(() => Promise.resolve());
    client = new WealthfolioClient({
      baseUrl: 'http://localhost:8088',
      password: 'unit-test-pw',
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: sleepMock,
    });
  });

  it('login() stores wf_session cookie and sends it on next request', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(LOGIN_OK))
      .mockResolvedValueOnce(
        makeResponse({ status: 200, body: [ACCOUNT_FIXTURE] }),
      );

    await client.login();
    await client.findOrCreateAccount(newAccountInput());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call: login, no Cookie header.
    const loginInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((loginInit.headers as Record<string, string>)['Cookie']).toBeUndefined();
    expect(loginInit.method).toBe('POST');
    // Second call carries the cookie.
    const acctInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect((acctInit.headers as Record<string, string>)['Cookie']).toBe(
      'wf_session=jwt-token-1',
    );
  });

  it('401 from API triggers re-login + retry of the original request', async () => {
    fetchMock
      // Implicit login on first request
      .mockResolvedValueOnce(makeResponse(LOGIN_OK))
      // First /accounts attempt: 401 (cookie went stale)
      .mockResolvedValueOnce(makeResponse({ status: 401, body: { code: 401 } }))
      // Re-login
      .mockResolvedValueOnce(
        makeResponse({
          ...LOGIN_OK,
          setCookie: [
            'wf_session=jwt-token-2; Path=/api; HttpOnly; SameSite=Lax',
          ],
        }),
      )
      // Retry /accounts: 200
      .mockResolvedValueOnce(
        makeResponse({ status: 200, body: [ACCOUNT_FIXTURE] }),
      );

    const acct = await client.findOrCreateAccount(newAccountInput());
    expect(acct.id).toBe('acct-1');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // The retried /accounts call must use the *new* cookie.
    const retryInit = fetchMock.mock.calls[3]![1] as RequestInit;
    expect((retryInit.headers as Record<string, string>)['Cookie']).toBe(
      'wf_session=jwt-token-2',
    );
  });

  it('5xx is retried with exponential backoff, then throws after 3 attempts', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(LOGIN_OK))
      .mockResolvedValueOnce(
        makeResponse({ status: 503, text: 'unavailable' }),
      )
      .mockResolvedValueOnce(
        makeResponse({ status: 503, text: 'unavailable' }),
      )
      .mockResolvedValueOnce(
        makeResponse({ status: 503, text: 'unavailable' }),
      );

    await expect(
      client.findOrCreateAccount(newAccountInput()),
    ).rejects.toBeInstanceOf(WealthfolioApiError);

    // 1 login + 3 attempts on /accounts
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock.mock.calls[0]![0]).toBe(100);
    expect(sleepMock.mock.calls[1]![0]).toBe(200);
  });

  it('createActivity treats 400 "Duplicate activity detected" as success', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(LOGIN_OK))
      .mockResolvedValueOnce(
        makeResponse({
          status: 400,
          text: JSON.stringify({
            code: 400,
            message:
              'Activity error: Invalid data: Duplicate activity detected. A matching activity already exists (id: ebd0b400-ccda-4851-a8f0-5d6438b56ca0).',
          }),
        }),
      );

    const result = await client.createActivity(newActivityInput('smoke-1'));
    expect(result).toEqual({
      duplicated: true,
      id: 'ebd0b400-ccda-4851-a8f0-5d6438b56ca0',
    });
  });

  it('createActivity rethrows other 400 errors (e.g. missing quoteCcy)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(LOGIN_OK))
      .mockResolvedValueOnce(
        makeResponse({
          status: 400,
          text: JSON.stringify({
            code: 400,
            message:
              'Quote currency is required. Please re-select the symbol.',
          }),
        }),
      );

    await expect(
      client.createActivity(newActivityInput('bad-1')),
    ).rejects.toMatchObject({
      name: 'WealthfolioApiError',
      status: 400,
    });
  });

  it('findOrCreateAccount reuses an existing account and does NOT POST', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(LOGIN_OK))
      .mockResolvedValueOnce(
        makeResponse({ status: 200, body: [ACCOUNT_FIXTURE] }),
      );

    const acct = await client.findOrCreateAccount(newAccountInput());
    expect(acct.id).toBe('acct-1');

    // Exactly two calls (login + GET). No POST /accounts.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lastCall = fetchMock.mock.calls[1]!;
    expect((lastCall[1] as RequestInit).method).toBe('GET');
  });

  it('findOrCreateAccount POSTs when no match exists', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(LOGIN_OK))
      // GET /accounts: empty list
      .mockResolvedValueOnce(makeResponse({ status: 200, body: [] }))
      // POST /accounts: created
      .mockResolvedValueOnce(
        makeResponse({ status: 200, body: ACCOUNT_FIXTURE }),
      );

    const acct = await client.findOrCreateAccount(newAccountInput());
    expect(acct.id).toBe('acct-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2]![1] as RequestInit).method).toBe('POST');
  });
});

// ---------------------------------------------------------------------------
// Integration — hits real localhost:8088, skipped by default
// ---------------------------------------------------------------------------

const INTEGRATION = process.env.WF_INTEGRATION === '1';

function loadPassword(): string {
  const envPw = process.env.WEALTHFOLIO_PASSWORD;
  if (envPw) return envPw;
  const secretsPath = resolve(
    __dirname,
    '../../../docs/ibkr-sync/secrets.local.md',
  );
  const text = readFileSync(secretsPath, 'utf8');
  // Line shape: "- **Password**: `XXXXX`"
  const m = /^-\s*\*\*Password\*\*:\s*`([^`]+)`/m.exec(text);
  if (!m) {
    throw new Error(
      `Could not find Password in ${secretsPath}. Set WEALTHFOLIO_PASSWORD instead.`,
    );
  }
  return m[1]!;
}

describe.skipIf(!INTEGRATION)('WealthfolioClient (integration, live API)', () => {
  const BASE_URL = process.env.WEALTHFOLIO_URL ?? 'http://localhost:8088';
  let client: WealthfolioClient;
  const createdActivityIds: string[] = [];

  beforeEach(() => {
    client = new WealthfolioClient({
      baseUrl: BASE_URL,
      password: loadPassword(),
    });
  });

  it(
    'login → findOrCreate IBKR-Test → write activity → duplicate detection → cleanup',
    async () => {
      await client.login();

      // Account: should already exist from S2 smoke run.
      const acct = await client.findOrCreateAccount({
        name: 'IBKR-Test',
        accountType: 'SECURITIES',
        currency: 'USD',
        provider: 'IBKR',
        providerAccountId: 'TEST-IBKR-ACCT',
        trackingMode: 'TRANSACTIONS',
        isActive: true,
      });
      expect(acct.id).toBeTruthy();
      expect(acct.providerAccountId).toBe('TEST-IBKR-ACCT');

      // Write a *new* activity using a unique idempotency key.
      const ikey = `s4-test-${Date.now()}`;
      const activity: ActivityInput = {
        accountId: acct.id,
        activityType: 'BUY',
        activityDate: '2026-05-30T11:00:00Z',
        quantity: '1',
        unitPrice: '100.00',
        fee: '0.50',
        currency: 'USD',
        asset: { symbol: 'AAPL', quoteCcy: 'USD' },
        idempotencyKey: ikey,
        sourceSystem: 'IBKR',
        sourceRecordId: ikey,
      };

      const first = await client.createActivity(activity);
      expect(first.duplicated).toBe(false);
      expect(first.id).toBeTruthy();
      if (first.id) createdActivityIds.push(first.id);

      // Same key again → duplicated:true
      const second = await client.createActivity(activity);
      expect(second.duplicated).toBe(true);
      // Server returns the existing id in the error message
      expect(second.id).toBe(first.id);

      // Cleanup: delete *only* the activity we wrote (never smoke-1).
      for (const id of createdActivityIds) {
        if (id === 'ebd0b400-ccda-4851-a8f0-5d6438b56ca0') continue;
        await client.deleteActivity(id);
      }
    },
    20_000,
  );
});
