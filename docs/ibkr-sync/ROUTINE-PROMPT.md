# IBKR → Wealthfolio Hourly Routine — Prompt Template

This is the prompt the `/schedule` routine fires every hour. Keep it terse
and idempotent — the routine has no conversation history and no user.

## Edit before registering

Replace the placeholders below for your environment, then register with
`/schedule`.

| Placeholder         | What to put                                                   |
| ------------------- | ------------------------------------------------------------- |
| `{REPO}`            | `/home/ubuntu/wealthfolio_ws/wealthfolio`                     |
| `{WF_URL}`          | `http://localhost:8088` (or your real host)                   |
| `{IBKR_ACC_ID}`     | A stable id for your IBKR account, e.g. `IBKR-USER-MAIN`      |
| `{ACC_NAME}`        | What you want it called in Wealthfolio, e.g. `IBKR Main`      |
| `{LOOKBACK}`        | IBKR `period` value — `DAYS_7` is safe (dedup handles repeats)|

## The prompt itself

```
You are a scheduled IBKR → Wealthfolio sync runner. No human is watching. Do
exactly the steps below, in order. If anything fails, print one short error
line and stop. Do NOT ask questions.

1. Call these IBKR MCP tools and capture their raw JSON responses:
   - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_trades   (period: "{LOOKBACK}")
   - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_positions
   - mcp__claude_ai_Interactive_Brokers_IBKR__get_account_summary

2. Write a single combined JSON file to /tmp/ibkr-raw.json with this shape:
   { "trades": <trades response>, "positions": <positions response>, "summary": <summary response> }

   Use the Bash tool with a here-doc or `node -e` to write the file. Make
   sure each top-level key holds the raw response (whatever shape the MCP
   tool returned — bare array or {trades:[...]} envelope, the parser
   handles both).

3. Read the local self-host password:
   Bash:  grep -oP '(?<=\*\*Password\*\*: `)[^`]+' {REPO}/docs/ibkr-sync/secrets.local.md

4. Run the sync, in {REPO}/tools/ibkr-sync, with that password in the env:
   Bash:  cd {REPO}/tools/ibkr-sync && \
          WEALTHFOLIO_URL={WF_URL} \
          WEALTHFOLIO_PASSWORD="<password from step 3>" \
          npx tsx src/sync.ts \
              --from=/tmp/ibkr-raw.json \
              --account-name="{ACC_NAME}" \
              --provider-account-id="{IBKR_ACC_ID}"

5. Report ONE line:
   IBKR sync OK: <copy the "[ibkr-sync] summary: ..." line from step 4 output>

   If the sync exited non-zero, instead:
   IBKR sync FAILED (exit <code>): <last error line from stderr>

6. Bash:  rm -f /tmp/ibkr-raw.json
```

## Why so prescriptive

- The runtime cost per routine fire is low — keeping the prompt short keeps
  it lower. Don't paraphrase; copy verbatim.
- Dedup is enforced server-side (HTTP 400 "Duplicate activity detected" path
  in `src/wealthfolio.ts`), so re-running is safe. The `{LOOKBACK}` window
  can overlap previous runs without consequences.
- IBKR MCP exposes no account id, so `{IBKR_ACC_ID}` is just a stable label
  we pick. Don't change it later — it's the `providerAccountId` key used by
  `findOrCreateAccount` to locate the Wealthfolio account. If you do change
  it, you'll get a second Wealthfolio account and split history.

## Failure modes worth knowing

| Symptom                                       | Likely cause                                  |
| --------------------------------------------- | --------------------------------------------- |
| `Login failed: 401`                           | Password rotated — refresh `secrets.local.md` |
| `Login failed: 429`                           | Hitting 5/60s/IP login limit. Wait, retry.    |
| `WEALTHFOLIO_PASSWORD env var is required`    | Step 3 grep returned empty. Check the file.   |
| `summary: ... errors=N (N>0)`                 | One or more activities failed on POST.        |
| `fetch failed`                                | Wealthfolio container down. `docker ps`.      |
| MCP tool returns auth error                   | IBKR MCP token expired. Reauth in Claude.     |

## Manual fire (for testing)

Bypass `/schedule` and run it yourself once:

```bash
# In the Claude Code session this would be:
# (copy steps 1-5 of the prompt as a single user message)
```

Or skip the MCP step entirely and use a fixture for the TS half:

```bash
cd {REPO}/tools/ibkr-sync
WEALTHFOLIO_PASSWORD=$(grep -oP '(?<=\*\*Password\*\*: `)[^`]+' \
  ../../docs/ibkr-sync/secrets.local.md) \
npx tsx src/sync.ts \
    --from=fixtures/ibkr-raw.example.json \
    --account-name="IBKR Main" \
    --provider-account-id="IBKR-USER-MAIN" \
    --dry-run
```
