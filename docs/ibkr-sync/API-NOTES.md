# Wealthfolio REST API — Cookbook (S2 output)

Base: `http://localhost:8088/api/v1`. All JSON uses **camelCase**. Auth is a
single-password Argon2id login that returns an `HttpOnly` cookie
`wf_session=<JWT>; Path=/api; SameSite=Lax; Max-Age=3600`. The same JWT can
also be sent as `Authorization: Bearer <token>` (extracted from the cookie or
re-issued via login).

## 1. Login

```bash
PASSWORD=$(grep '^- \*\*Password' docs/ibkr-sync/secrets.local.md | sed 's/.*`\(.*\)`.*/\1/')
rm -f /tmp/wf_cookies.txt
curl -sS -c /tmp/wf_cookies.txt -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" \
  http://localhost:8088/api/v1/auth/login
# -> {"authenticated":true,"expiresIn":3600}
```

Pass the cookie jar on every subsequent call (`-b /tmp/wf_cookies.txt`). The
middleware auto-refreshes the cookie after 50% of TTL.

Sanity check:

```bash
curl -sS -b /tmp/wf_cookies.txt http://localhost:8088/api/v1/auth/me
# -> {"authenticated":true}
```

## 2. Create account

```bash
curl -sS -b /tmp/wf_cookies.txt -H "Content-Type: application/json" -d '{
  "name": "IBKR-Test",
  "accountType": "SECURITIES",
  "currency": "USD",
  "isDefault": false,
  "isActive": true,
  "trackingMode": "TRANSACTIONS",
  "provider": "IBKR",
  "providerAccountId": "TEST-IBKR-ACCT"
}' http://localhost:8088/api/v1/accounts
```

Response (truncated):

```json
{"id":"00000000-0000-0000-0000-000000000000","name":"IBKR-Test",
 "accountType":"SECURITIES","currency":"USD","trackingMode":"TRANSACTIONS",
 "provider":"IBKR","providerAccountId":"TEST-IBKR-ACCT", ...}
```

`GET /api/v1/accounts` returns the array; pass `?includeArchived=true` to see
soft-deleted ones.

Idempotent reuse: there is no server-side dedupe on `providerAccountId`.
The sync client must `GET /accounts` and filter on `provider` +
`providerAccountId` before POSTing.

## 3. Create activity (BUY)

```bash
curl -sS -b /tmp/wf_cookies.txt -H "Content-Type: application/json" -d '{
  "accountId": "00000000-0000-0000-0000-000000000000",
  "asset": { "symbol": "AAPL", "quoteCcy": "USD" },
  "activityType": "BUY",
  "activityDate": "2026-05-30T10:00:00Z",
  "quantity": "10",
  "unitPrice": "200.00",
  "currency": "USD",
  "fee": "1.00",
  "sourceSystem": "IBKR",
  "sourceRecordId": "smoke-trade-1",
  "idempotencyKey": "smoke-1"
}' http://localhost:8088/api/v1/activities
```

Returns the new activity (id, accountId, assetId, status:`POSTED`, etc.).
Asset (`AAPL`) is auto-created on first reference; no separate
`POST /assets` is required for STK.

## 4. Idempotency

Re-POST the **exact** same body (same `idempotencyKey`):

```
HTTP/1.1 400 Bad Request
{"code":400,"message":"Activity error: Invalid data: Duplicate activity
 detected. A matching activity already exists (id: ebd0b400-...)."}
```

Control: change only `idempotencyKey` (other fields identical) → 200 OK,
brand-new row created. So dedupe is keyed strictly on `idempotencyKey`.
**Client must treat HTTP 400 with the substring `Duplicate activity detected`
as success** (parse the existing id from the message if needed).

## 5. Verify rows

```bash
curl -sS -b /tmp/wf_cookies.txt -H "Content-Type: application/json" -d '{
  "page": 0, "pageSize": 50,
  "accountIdFilter": "00000000-0000-0000-0000-000000000000"
}' http://localhost:8088/api/v1/activities/search
```

`meta.totalRowCount` gives total; `data[]` is the page slice.

## Endpoint summary

| Endpoint | Method | Auth | Request | Response | Idempotency |
|---|---|---|---|---|---|
| `/api/v1/healthz` | GET | none | — | `"ok"` | — |
| `/api/v1/auth/status` | GET | none | — | `{requiresPassword}` | — |
| `/api/v1/auth/login` | POST | none | `{password}` | `{authenticated,expiresIn}` + `Set-Cookie: wf_session=...` | rate-limited 5/60s/IP |
| `/api/v1/auth/me` | GET | cookie/Bearer | — | `{authenticated:true}` | — |
| `/api/v1/auth/logout` | POST | cookie/Bearer | — | 204 + clears cookie | — |
| `/api/v1/accounts` | GET | cookie | `?includeArchived=` | `Account[]` | — |
| `/api/v1/accounts` | POST | cookie | `NewAccount` (camelCase) | `Account` | client-side dedupe via `providerAccountId` |
| `/api/v1/accounts/{id}` | PUT/DELETE | cookie | `AccountUpdate` / — | `Account` / 204 | — |
| `/api/v1/activities` | POST | cookie | `NewActivity` (camelCase) | `Activity` | `idempotencyKey` → 400 "Duplicate activity detected" |
| `/api/v1/activities/{id}` | DELETE | cookie | — | deleted `Activity` | — |
| `/api/v1/activities/search` | POST | cookie | `{page,pageSize,...}` | `{data:[],meta:{totalRowCount}}` | — |

## Gotchas

1. **JSON is camelCase, not snake_case** — `accountType`, `isDefault`,
   `trackingMode`, `providerAccountId`, `activityType`, `activityDate`,
   `unitPrice`, `sourceSystem`, `sourceRecordId`, `idempotencyKey`. Snake_case
   bodies silently 422.
2. **`asset` is required for BUY/SELL, and `asset.quoteCcy` is required on
   first reference** of a new symbol. Without it: 400
   `"Quote currency is required. Please re-select the symbol."`. Top-level
   `symbol: "AAPL"` (string) also works (legacy alias) but you still need a
   way to pass `quoteCcy` — so always use the object form
   `"asset": { "symbol": "AAPL", "quoteCcy": "USD" }`.
3. **Search pagination is 0-based.** `page: 0` returns the first page;
   `page: 1` skips `pageSize` rows. Easy to miss because totalRowCount stays
   right.
4. **Cookie path is `/api`** and `HttpOnly` — `curl -c/-b` works; plain
   `-H "Cookie: ..."` also works as long as you include `wf_session=<jwt>`.
   The `Secure` flag is only set when `X-Forwarded-Proto: https` is seen
   (default policy `auto`), so plain `http://localhost` is fine.
5. **Duplicate idempotencyKey returns HTTP 400**, not 409 or 200. The error
   message contains `Duplicate activity detected` and the existing activity
   id — treat this as a successful no-op in the sync client. **Scope is
   global, not per-account** — the same `idempotencyKey` is rejected even
   across different `accountId`s. Confirmed in rehearsal: an IBKR trade
   first written to `IBKR-Test` was dedup'd when the same trade later
   targeted the `IBKR` account, leaving it stuck in the first account.
   Prefix keys with `ibkr:<trade_id>` (project convention) and never reuse.
6. **Numeric fields accept strings** (e.g. `"10"`, `"200.00"`) — they go
   through a custom `Decimal` deserializer. Bare numbers also work; use
   strings to avoid float drift.
7. **Login is rate-limited 5 req/60s per peer IP** (tower-governor). Don't
   loop login retries.
8. **Account creation has no server-side dedupe.** Two POSTs with the same
   `providerAccountId` create two accounts. The sync orchestrator MUST
   `findOrCreate` by walking `GET /accounts`.
9. **`/activities/search` requires `sort.id` from a fixed set**
   (`"date"`, `"activityType"`, `"assetSymbol"`, `"accountName"` per
   `crates/storage-sqlite/src/activities/repository.rs:204`). `"activityDate"`
   is **not** valid — unknown ids silently fall through to insertion order.
10. **404 on missing routes** returns no JSON body — handy for distinguishing
    "endpoint typo" from "auth failure" (which returns the `AuthErrorBody`
    JSON).
11. **`POST /accounts` requires `isDefault` AND `isActive`** even though they
    might look optional. Omitting either → 422 `missing field 'isDefault'`.
    The wealthfolio.ts client now defaults them in `findOrCreateAccount`.

## Test artifacts retained

- Account `IBKR-Test` id: `00000000-0000-0000-0000-000000000000`
- BUY activity id: `ebd0b400-ccda-4851-a8f0-5d6438b56ca0`
  (`idempotencyKey: "smoke-1"`, AAPL × 10 @ 200.00 USD, fee 1.00)
- Auto-created asset `AAPL` (Apple Inc., EQUITY) id:
  `e7d29baa-5889-4c3a-8b5e-a6e191d2c9ca`

Control duplicate (`smoke-1-different`) was deleted; no other artefacts.

## Open Questions

- `accountType` accepted any uppercase string in this smoke test
  (`"SECURITIES"`); no enum validation observed. Confirm the canonical list
  the UI expects (look at `crates/core/src/accounts/accounts_constants.rs`)
  before settling on a value for prod.
- Behaviour of `POST /activities` when the symbol exists with a *different*
  `quoteCcy` than the request — not exercised here; expect a validation error
  but verify before relying on it.
- `POST /snapshots/import` (holdings path) — out of S2 scope, not tested.
