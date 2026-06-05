import { makeClient, listAccounts, fetchHoldings } from "./snaptrade.js";
import {
  optionPositionToHoldingsPosition, equityPositionToHoldingsPosition,
  buildOptionAssetSpec, balancesToCashBalances, snaptradePositionToObserved,
  reinjectionToHoldingsPosition,
} from "./mapping.js";
import { loadState, saveState, reconcile } from "./state.js";
import { WealthfolioClient, type HoldingsPositionInput } from "./wealthfolio.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v == null) throw new Error(`missing env ${name}`);
  return v;
}

export async function run(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const clientId = env("SNAPTRADE_CLIENT_ID");
  const consumerKey = env("SNAPTRADE_CONSUMER_KEY");
  const userId = env("SNAPTRADE_USER_ID");
  const userSecret = env("SNAPTRADE_USER_SECRET");
  const wantInstitution = env("SNAPTRADE_INSTITUTION", "Schwab");
  const accountName = env("SNAPTRADE_ACCOUNT_NAME", "Schwab");
  const wfUrl = env("WEALTHFOLIO_URL", "http://localhost:8088");
  const statePath = env("SNAPTRADE_STATE", "state/positions-state.json");
  const graceDays = Number(env("SNAPTRADE_GRACE_DAYS", "1"));

  const st = makeClient(clientId, consumerKey);
  const accounts = await listAccounts(st, userId, userSecret);
  const acct = accounts.find(a => a.institution_name?.toLowerCase().includes(wantInstitution.toLowerCase())) ?? accounts[0];
  if (!acct) { console.error("[snaptrade-sync] no SnapTrade account found"); return 1; }
  const providerAccountId = `SNAPTRADE-${acct.id}`;

  const holdings = await fetchHoldings(st, userId, userSecret, acct.id);
  const today = new Date().toISOString().slice(0, 10);

  const observed = [
    ...holdings.positions.map(p => snaptradePositionToObserved(p, p.symbol.symbol.symbol)),
    ...holdings.option_positions.map(p => snaptradePositionToObserved(p, p.symbol.option_symbol.ticker)),
  ];
  const prev = await loadState(statePath);
  const { next, reinjections } = reconcile(prev, observed, today, graceDays);
  next.lastRunUtc = new Date().toISOString();

  const equityRows = holdings.positions.map(equityPositionToHoldingsPosition);
  const optionEntries = holdings.option_positions.map(p => ({ p, row: optionPositionToHoldingsPosition(p) }));
  const reinjectedRows = reinjections.map(reinjectionToHoldingsPosition);
  const cashBalances = balancesToCashBalances(holdings.balances);

  if (dryRun) {
    console.log(JSON.stringify({ providerAccountId, equityRows, optionRows: optionEntries.map(e => e.row), reinjectedRows, cashBalances }, null, 2));
    return 0;
  }

  const wf = new WealthfolioClient({ baseUrl: wfUrl, password: env("WEALTHFOLIO_PASSWORD") });
  const account = await wf.findOrCreateAccount({
    name: accountName, accountType: "SECURITIES", currency: "USD",
    provider: "SNAPTRADE", providerAccountId, trackingMode: "HOLDINGS", isActive: true,
  });

  for (const e of optionEntries) {
    const asset = await wf.findOrCreateAsset(buildOptionAssetSpec(e.p));
    e.row.assetId = asset.id;
  }

  const positions: HoldingsPositionInput[] = [...equityRows, ...optionEntries.map(e => e.row), ...reinjectedRows];
  const result = await wf.importHoldingsSnapshot(account.id, { date: today, positions, cashBalances });

  const quotes = optionEntries
    .filter(e => e.row.assetId && e.p.price != null && e.p.price > 0)
    .map(e => ({ symbol: e.row.assetId!, date: today, close: e.p.price!, currency: "USD" }));
  let quotesImported = 0;
  if (quotes.length) {
    try { await wf.importQuotes(quotes, true); quotesImported = quotes.length; }
    catch (err) { console.error("[snaptrade-sync] quote import error:", (err as Error).message); }
  }

  await saveState(statePath, next);
  console.log(`[snaptrade-sync] summary: date=${today} account=${account.id} equity=${equityRows.length} options=${optionEntries.length} reinjected=${reinjectedRows.length} cash=${Object.keys(cashBalances).join(",")} snapshotsImported=${result.snapshotsImported} snapshotsFailed=${result.snapshotsFailed} quotes=${quotesImported}/${quotes.length}`);
  return result.snapshotsFailed > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(code => process.exit(code)).catch(e => { console.error("[snaptrade-sync] FATAL:", e); process.exit(1); });
}
