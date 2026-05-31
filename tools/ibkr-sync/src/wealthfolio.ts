/**
 * Wealthfolio self-host HTTP client.
 *
 * Behavior contract (see docs/ibkr-sync/API-NOTES.md):
 * - Single-password Argon2id login → HttpOnly cookie `wf_session=<JWT>`.
 * - All JSON payloads are camelCase.
 * - Account creation has no server-side dedupe → caller must `findOrCreate`.
 * - Activity dedupe is keyed on `idempotencyKey`. Duplicate POST returns
 *   HTTP 400 with body containing `Duplicate activity detected. ... (id: ...)`
 *   — treat as success (`duplicated: true`).
 * - Login is rate-limited 5/60s/peer IP. Don't re-login per request; only
 *   re-login on 401.
 * - 5xx and network errors retried 3 times with exponential backoff
 *   (100ms → 200ms → 400ms).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccountType =
  | 'SECURITIES'
  | 'CASH'
  | 'CRYPTO'
  | 'RETIREMENT'
  | 'EDUCATION'
  | 'HSA'
  | 'OTHER';

export type TrackingMode = 'TRANSACTIONS' | 'HOLDINGS';

export type ActivityType =
  | 'BUY'
  | 'SELL'
  | 'SPLIT'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'FEE'
  | 'TAX'
  | 'CREDIT'
  | 'DIVIDEND'
  | 'INTEREST'
  | 'ADJUSTMENT'
  | 'UNKNOWN';

export interface Account {
  id: string;
  name: string;
  accountType: AccountType | string;
  currency: string;
  trackingMode?: TrackingMode | null;
  provider?: string | null;
  providerAccountId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  [extra: string]: unknown;
}

export interface AccountInput {
  name: string;
  accountType: AccountType;
  currency: string;
  provider?: string;
  providerAccountId?: string;
  trackingMode?: TrackingMode;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface AssetRef {
  symbol: string;
  quoteCcy: string;
}

export interface ActivityInput {
  accountId: string;
  activityType: ActivityType;
  /** UTC ISO-8601, e.g. "2026-05-30T10:00:00Z". */
  activityDate: string;
  quantity?: number | string;
  unitPrice?: number | string;
  fee?: number | string;
  currency: string;
  asset: AssetRef;
  idempotencyKey: string;
  sourceSystem?: string;
  sourceRecordId?: string;
}

export interface CreateActivityResult {
  /** Server-assigned id. May be `undefined` if the dedupe message is shaped
   *  differently than expected and we cannot parse it out. */
  id?: string;
  /** True if the server reported a duplicate (HTTP 400 dedupe path). */
  duplicated: boolean;
}

// Holdings snapshot import. Mirrors
// apps/server/src/api/holdings/dto.rs::HoldingsPositionInput /
// HoldingsSnapshotInput / ImportHoldingsCsvRequest|Result (camelCase JSON).
export interface HoldingsPositionInput {
  symbol: string;
  /** Decimal as string (e.g. "1.5", "-2"). Negatives allowed for shorts. */
  quantity: string;
  /** Per-share cost basis. For options this is per-share, not per-contract. */
  avgCost?: string;
  currency: string;
  exchangeMic?: string;
  quoteCcy?: string;
  /** `"EQUITY"`, `"OPTION"`, … — passed straight to `build_asset_metadata`
   *  which derives option spec from the OCC symbol. */
  instrumentType?: 'EQUITY' | 'OPTION' | 'ETF' | 'BOND' | 'CRYPTO' | string;
  providerId?: string;
  providerSymbol?: string;
  assetId?: string;
}

export interface HoldingsSnapshotInput {
  /** YYYY-MM-DD (UTC). Same date + same content = server skips (idempotent);
   *  same date + different content = server overwrites. */
  date: string;
  positions: HoldingsPositionInput[];
  /** Per-currency cash totals: `{ "USD": "1234.56", "HKD": "0" }`. */
  cashBalances: Record<string, string>;
}

export interface ImportSnapshotResult {
  snapshotsImported: number;
  snapshotsFailed: number;
  errors: string[];
}

// Asset creation (used to inject option metadata that the snapshot import
// path does NOT auto-build — see docs/ibkr-sync/CONTEXT.md).
export interface NewAssetInput {
  id?: string;
  /** Default `INVESTMENT` if omitted. */
  kind?: 'INVESTMENT' | 'PROPERTY' | 'VEHICLE' | 'COLLECTIBLE' | string;
  name?: string;
  displayCode?: string;
  isActive?: boolean;
  quoteMode?: 'MARKET' | 'MANUAL';
  quoteCcy: string;
  instrumentType?: 'EQUITY' | 'OPTION' | 'CRYPTO' | 'FX' | 'BOND' | string;
  instrumentSymbol?: string;
  instrumentExchangeMic?: string;
  metadata?: Record<string, unknown>;
}

// Quote import. Mirrors crates/core/src/quotes/import.rs::QuoteImport.
export interface QuoteImport {
  /** Despite the name, this is used VERBATIM as the asset_id (no symbol→id
   *  lookup) — see crates/core/src/quotes/import.rs. Pass the asset UUID, not a
   *  ticker. A non-existent id fails on the quotes→assets FK. */
  symbol: string;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Required price. Decimal as number (server accepts both). */
  close: number | string;
  currency: string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  volume?: number | string;
  displaySymbol?: string;
}

/** Mirrors `OptionSpec` in crates/core/src/assets/assets_model.rs:121. */
export interface OptionSpec {
  underlyingAssetId: string;
  /** ISO `YYYY-MM-DD`. */
  expiration: string;
  right: 'CALL' | 'PUT';
  /** Decimal as string. */
  strike: string;
  /** Decimal as string. Usually `"100"`. */
  multiplier: string;
  occSymbol?: string;
}

export interface WealthfolioClientOptions {
  baseUrl: string;
  password: string;
  /** Reserved for future use (proactive refresh). Currently we just react to
   *  401 from the server. */
  tokenTtlBufferSec?: number;
  /** Override `globalThis.fetch` (used by tests). */
  fetchImpl?: typeof fetch;
  /** Override the sleep used between retry attempts (tests can stub this to
   *  skip the actual delay). Returns a promise that resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'wf_session';
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 100;
const DUP_MSG = 'Duplicate activity detected';
const DUP_ID_RE = /id:\s*([0-9a-fA-F-]{36})/;

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** If true, do NOT attach the session cookie and do NOT retry on 401.
   *  Used internally by `login`. */
  noAuth?: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const rel = path.startsWith('/') ? path : `/${path}`;
  return `${base}${rel}`;
}

/** Parse `wf_session=...` token out of one or more `Set-Cookie` header values.
 *  Returns the cookie value (without the name=) or null if not present. */
function extractSessionCookie(setCookieValues: string[]): string | null {
  for (const raw of setCookieValues) {
    // Each value is one cookie: `wf_session=<jwt>; Path=/api; HttpOnly; ...`
    const firstPair = raw.split(';', 1)[0]?.trim() ?? '';
    const eq = firstPair.indexOf('=');
    if (eq < 0) continue;
    const name = firstPair.slice(0, eq).trim();
    if (name === SESSION_COOKIE) {
      return firstPair.slice(eq + 1).trim();
    }
  }
  return null;
}

/** Pull every Set-Cookie header value out of a Headers object regardless of
 *  whether the runtime exposes `getSetCookie()` (Node 20+ does, older runtimes
 *  collapse repeats). */
function readSetCookie(headers: Headers): string[] {
  // Node ≥ 19.7 exposes getSetCookie via undici; prefer it because it returns
  // the un-merged list.
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers);
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export class WealthfolioApiError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'WealthfolioApiError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WealthfolioClient {
  private readonly baseUrl: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private sessionCookie: string | null = null;

  constructor(opts: WealthfolioClientOptions) {
    if (!opts.baseUrl) throw new Error('baseUrl is required');
    if (!opts.password) throw new Error('password is required');
    this.baseUrl = opts.baseUrl;
    this.password = opts.password;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Perform the login handshake and stash the session cookie. Safe to call
   *  multiple times; each call consumes one token from the 5/60s/IP rate
   *  budget on the server side. */
  async login(): Promise<void> {
    const res = await this.rawFetch({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { password: this.password },
      noAuth: true,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new WealthfolioApiError(
        `Login failed (HTTP ${res.status}): ${text}`,
        res.status,
        text,
      );
    }
    const cookie = extractSessionCookie(readSetCookie(res.headers));
    if (!cookie) {
      throw new Error(
        'Login response did not include a wf_session Set-Cookie header',
      );
    }
    this.sessionCookie = cookie;
  }

  /** Lookup existing account by `provider` + `providerAccountId`; create if
   *  missing. `providerAccountId` is required (we use it as the dedupe key). */
  async findOrCreateAccount(
    input: AccountInput & { providerAccountId: string },
  ): Promise<Account> {
    const accounts = await this.request<Account[]>({
      method: 'GET',
      path: '/api/v1/accounts',
    });
    const match = accounts.find(
      (a) =>
        a.providerAccountId === input.providerAccountId &&
        (input.provider === undefined || a.provider === input.provider),
    );
    if (match) return match;

    // Server deserialise rejects missing isDefault / isActive even though
    // TS marks them optional. Default rather than relying on every caller.
    const body = {
      isDefault: false,
      isActive: true,
      ...input,
    };
    return this.request<Account>({
      method: 'POST',
      path: '/api/v1/accounts',
      body,
    });
  }

  /** Create an activity. Treats HTTP 400 `"Duplicate activity detected"` as a
   *  successful no-op and returns `{ duplicated: true }`. */
  async createActivity(input: ActivityInput): Promise<CreateActivityResult> {
    try {
      const created = await this.request<{ id?: string }>({
        method: 'POST',
        path: '/api/v1/activities',
        body: input,
      });
      return { id: created.id, duplicated: false };
    } catch (err) {
      if (
        err instanceof WealthfolioApiError &&
        err.status === 400 &&
        err.body.includes(DUP_MSG)
      ) {
        const m = DUP_ID_RE.exec(err.body);
        return { id: m?.[1], duplicated: true };
      }
      throw err;
    }
  }

  /** Delete an activity by id. Returns the deleted activity body on success. */
  async deleteActivity(id: string): Promise<unknown> {
    return this.request<unknown>({
      method: 'DELETE',
      path: `/api/v1/activities/${encodeURIComponent(id)}`,
    });
  }

  /** Delete an account (and cascade its activities). Used for cleanup; the
   *  hourly sync itself never calls this. */
  async deleteAccount(id: string): Promise<void> {
    await this.request<unknown>({
      method: 'DELETE',
      path: `/api/v1/accounts/${encodeURIComponent(id)}`,
    });
  }

  /** Find an existing asset by (`instrumentSymbol`, `instrumentType`) or
   *  create it. Used to pre-populate option assets with `OptionSpec`
   *  metadata, which the snapshot-import code path never builds itself. */
  async findOrCreateAsset(input: NewAssetInput): Promise<Account> {
    if (input.instrumentSymbol && input.instrumentType) {
      const all = await this.request<Account[]>({
        method: 'GET',
        path: '/api/v1/assets',
      });
      const match = all.find(
        (a) =>
          (a as { instrumentSymbol?: string }).instrumentSymbol ===
            input.instrumentSymbol &&
          (a as { instrumentType?: string }).instrumentType ===
            input.instrumentType,
      );
      if (match) return match;
    }
    const body: NewAssetInput = {
      kind: 'INVESTMENT',
      isActive: true,
      quoteMode: 'MARKET',
      ...input,
    };
    return this.request<Account>({
      method: 'POST',
      path: '/api/v1/assets',
      body,
    });
  }

  /** Delete an asset by id. Used by cleanup scripts; not in the hot path. */
  async deleteAsset(id: string): Promise<void> {
    await this.request<unknown>({
      method: 'DELETE',
      path: `/api/v1/assets/${encodeURIComponent(id)}`,
    });
  }

  /** Bulk-import market quotes. Use `overwriteExisting=true` for hourly
   *  refreshes so the same date+symbol updates rather than rejects. Returns
   *  the per-row validation results from the server. */
  async importQuotes(
    quotes: QuoteImport[],
    overwriteExisting: boolean,
  ): Promise<QuoteImport[]> {
    return this.request<QuoteImport[]>({
      method: 'POST',
      path: '/api/v1/market-data/quotes/import',
      body: { quotes, overwriteExisting },
    });
  }

  /** Push a holdings snapshot (positions + cash) for a given account/date.
   *  Server is idempotent on (accountId, date, content). */
  async importHoldingsSnapshot(
    accountId: string,
    snapshot: HoldingsSnapshotInput,
  ): Promise<ImportSnapshotResult> {
    return this.request<ImportSnapshotResult>({
      method: 'POST',
      path: '/api/v1/snapshots/import',
      body: { accountId, snapshots: [snapshot] },
    });
  }

  // -------------------------------------------------------------------------
  // request pipeline: auth + retry
  // -------------------------------------------------------------------------

  private async request<T>(opts: RequestOptions): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.requestOnce<T>(opts);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) throw err;
        if (attempt < MAX_RETRIES - 1) {
          // 100ms, 200ms, 400ms — capped by MAX_RETRIES.
          await this.sleep(BACKOFF_BASE_MS * 2 ** attempt);
          continue;
        }
      }
    }
    throw lastError;
  }

  /** Single attempt: send the request, lazily login, and re-login + retry once
   *  on 401. Throws WealthfolioApiError on non-2xx, or rethrows fetch errors. */
  private async requestOnce<T>(opts: RequestOptions): Promise<T> {
    if (!opts.noAuth && !this.sessionCookie) {
      await this.login();
    }

    let res = await this.rawFetch(opts);
    if (res.status === 401 && !opts.noAuth) {
      // Session expired or cookie missing — re-login once and retry.
      this.sessionCookie = null;
      await this.login();
      res = await this.rawFetch(opts);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new WealthfolioApiError(
        `${opts.method} ${opts.path} failed (HTTP ${res.status}): ${text}`,
        res.status,
        text,
      );
    }
    // Some endpoints (DELETE /accounts/{id}, /auth/logout) return 204.
    if (res.status === 204) {
      return undefined as unknown as T;
    }
    return (await res.json()) as T;
  }

  private async rawFetch(opts: RequestOptions): Promise<Response> {
    const url = joinUrl(this.baseUrl, opts.path);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (!opts.noAuth && this.sessionCookie) {
      headers['Cookie'] = `${SESSION_COOKIE}=${this.sessionCookie}`;
    }
    return this.fetchImpl(url, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }
}

/** Retry decision: only retry on network errors or 5xx server errors. Don't
 *  retry 4xx (caller mistakes) — those should bubble up immediately. */
function isRetryable(err: unknown): boolean {
  if (err instanceof WealthfolioApiError) {
    return err.status >= 500 && err.status < 600;
  }
  // Anything else (TypeError from fetch, AbortError, etc.) — treat as
  // transient network noise and retry.
  return true;
}
