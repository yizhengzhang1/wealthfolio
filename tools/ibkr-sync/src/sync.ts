#!/usr/bin/env node
/**
 * IBKR → Wealthfolio positions-snapshot sync.
 *
 * Reads a JSON file dumped by a Claude Code session (which has IBKR MCP
 * access), maps positions + cash balances to Wealthfolio's snapshot import
 * payload, and posts it. Trade history is intentionally NOT synced — see
 * docs/ibkr-sync/CONTEXT.md.
 *
 * Usage:
 *   WEALTHFOLIO_PASSWORD=… node sync.ts --from=/tmp/ibkr-raw.json \
 *       [--dry-run] [--account-name=IBKR] [--provider-account-id=IBKR-MAIN]
 *
 * Expected JSON shape:
 *   {
 *     "positions": <get_account_positions response>,
 *     "balances":  <get_account_balances response>   (optional, recommended)
 *     "summary":   <get_account_summary response>    (optional, sanity check)
 *   }
 */

import { readFile } from 'node:fs/promises';
import {
  parsePositions,
  parseBalances,
  parseSummary,
  type IbkrPosition,
} from './ibkr.js';
import {
  ibkrPositionToHoldingsPosition,
  parseOptionPosition,
} from './mapping.js';
import {
  WealthfolioClient,
  WealthfolioApiError,
  type AccountInput,
  type HoldingsPositionInput,
  type QuoteImport,
} from './wealthfolio.js';

interface CliArgs {
  from: string;
  dryRun: boolean;
  accountName: string;
  providerAccountId: string;
  baseUrl: string;
  password: string;
}

function parseArgs(argv: string[]): CliArgs {
  const opts: Record<string, string | boolean> = {};
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) throw new Error(`Unrecognised argument: ${arg}`);
    opts[m[1]] = m[2];
  }
  const from = String(opts['from'] ?? '');
  if (!from) throw new Error('Missing --from=<path-to-ibkr-raw.json>');

  const baseUrl = process.env.WEALTHFOLIO_URL ?? 'http://localhost:8088';
  const password = process.env.WEALTHFOLIO_PASSWORD ?? '';
  if (!password) {
    throw new Error('WEALTHFOLIO_PASSWORD env var is required');
  }

  return {
    from,
    dryRun: Boolean(opts.dryRun),
    accountName: String(opts['account-name'] ?? 'IBKR'),
    providerAccountId: String(opts['provider-account-id'] ?? 'IBKR-MAIN'),
    baseUrl,
    password,
  };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv);
  const raw = JSON.parse(await readFile(args.from, 'utf8')) as Record<
    string,
    unknown
  >;

  const positions = parsePositions(raw.positions ?? []);
  const balances = raw.balances ? parseBalances(raw.balances) : [];
  const summary = raw.summary ? parseSummary(raw.summary) : null;

  // Map positions, recording per-row skip reasons for the summary line.
  // Keep each row paired with its source position so we can later attach the
  // pre-created option asset UUID (by contract_id) before posting.
  const mappedEntries: { pos: IbkrPosition; row: HoldingsPositionInput }[] = [];
  let skipped = 0;
  for (const p of positions) {
    const out = ibkrPositionToHoldingsPosition(p);
    if (out === null) {
      skipped += 1;
    } else {
      mappedEntries.push({ pos: p, row: out });
    }
  }
  const mapped: HoldingsPositionInput[] = mappedEntries.map((e) => e.row);
  const stkCount = mapped.filter((m) => m.instrumentType === 'EQUITY').length;
  const optCount = mapped.filter((m) => m.instrumentType === 'OPTION').length;

  const cashBalances: Record<string, string> = {};
  for (const b of balances) {
    cashBalances[b.currency] = String(b.cash_balance);
  }

  const date = todayUtc();
  const summaryLine = (extra: string): string =>
    `[ibkr-sync] summary: date=${date} positions=${positions.length} (stk=${stkCount} opt=${optCount} skipped=${skipped}) cash_currencies=${Object.keys(cashBalances).length}${summary ? ` net_liq=${summary.net_liquidation.toFixed(2)}${summary.currency}` : ''} ${extra}`;

  if (args.dryRun) {
    console.log(`[ibkr-sync] loaded (dry-run): ${mapped.length} positions, ${Object.keys(cashBalances).length} cash currencies`);
    for (const m of mapped) {
      console.log(
        `[dry-run] ${m.instrumentType?.padEnd(6)} ${m.quantity.padStart(8)} ${m.symbol.padEnd(24)} @ ${m.avgCost} ${m.currency}`,
      );
    }
    for (const [ccy, amt] of Object.entries(cashBalances)) {
      console.log(`[dry-run] cash ${ccy}: ${amt}`);
    }
    console.log(summaryLine('imported=0 (dry-run)'));
    return 0;
  }

  const client = new WealthfolioClient({
    baseUrl: args.baseUrl,
    password: args.password,
  });

  const accountInput: AccountInput & { providerAccountId: string } = {
    name: args.accountName,
    accountType: 'SECURITIES',
    currency: summary?.currency ?? 'USD',
    provider: 'IBKR',
    providerAccountId: args.providerAccountId,
    trackingMode: 'HOLDINGS',
    isActive: true,
  };
  const account = await client.findOrCreateAccount(accountInput);
  console.log(
    `[ibkr-sync] account: ${account.name} (${account.id})  providerAccountId=${args.providerAccountId}`,
  );

  // Pre-create option assets with OptionSpec metadata. snapshot import's
  // get_or_create_minimal_asset never calls build_asset_metadata itself, so
  // unless we create the asset up-front the option contract details are lost.
  // Also collects asset_id per position so importQuotes can reference them.
  const optionAssetIds = new Map<number, string>(); // contract_id -> asset.id
  for (const p of positions) {
    if (p.position === 0) continue;
    const opt = parseOptionPosition(p);
    if (!opt) continue;
    const asset = await client.findOrCreateAsset({
      quoteCcy: p.currency,
      // MANUAL: Wealthfolio's market-data providers don't price options.
      // We feed prices from IBKR ourselves via importQuotes below.
      quoteMode: 'MANUAL',
      instrumentType: 'OPTION',
      instrumentSymbol: opt.occSymbol,
      displayCode: opt.occSymbol,
      metadata: {
        option: {
          underlyingAssetId: opt.underlying,
          expiration: opt.expiration,
          right: opt.right,
          strike: opt.strike,
          multiplier: String(opt.multiplier),
          occSymbol: opt.occSymbol,
        },
      },
    });
    optionAssetIds.set(p.contract_id, asset.id);
  }
  if (optionAssetIds.size > 0) {
    console.log(`[ibkr-sync] option assets ensured: ${optionAssetIds.size}`);
  }

  // Bind each option snapshot row to its pre-created asset UUID. With assetId
  // set, the snapshot importer resolves the asset by id directly instead of
  // re-deriving it from the OCC string via instrument_key canonicalization —
  // which would otherwise create a second, metadata-less asset if the sync
  // ever sent an exchangeMic or the OCC casing/spacing differed.
  for (const e of mappedEntries) {
    const assetId = optionAssetIds.get(e.pos.contract_id);
    if (assetId) e.row.assetId = assetId;
  }

  try {
    // Step 1: snapshot. This synthesises a quote = avg_cost for today and
    // would clobber any real market quote we wrote first — so it MUST run
    // before importQuotes, never after.
    const result = await client.importHoldingsSnapshot(account.id, {
      date,
      positions: mapped,
      cashBalances,
    });

    // Step 2: overwrite the synthetic avg-cost quote with IBKR's real
    // market_price for each option position. Stocks already get refreshed
    // by Wealthfolio's own providers (Yahoo etc.). NB: QuoteImport.symbol
    // is misleadingly named — server uses it verbatim as asset_id, so we
    // pass the UUID captured during pre-creation.
    const quoteRows: QuoteImport[] = [];
    for (const p of positions) {
      if (p.position === 0) continue;
      if (!(p.market_price > 0)) continue;
      const assetId = optionAssetIds.get(p.contract_id);
      if (!assetId) continue; // STK or skipped option
      quoteRows.push({
        symbol: assetId,
        date,
        close: p.market_price,
        currency: p.currency,
      });
    }
    let quotesImported = 0;
    let quoteError = '';
    if (quoteRows.length > 0) {
      try {
        const qres = await client.importQuotes(quoteRows, true);
        quotesImported = qres.length;
      } catch (err) {
        quoteError = err instanceof WealthfolioApiError
          ? `HTTP ${err.status}: ${err.body.slice(0, 120)}`
          : err instanceof Error ? err.message : String(err);
      }
    }

    console.log(
      summaryLine(
        `imported=${result.snapshotsImported}/${result.snapshotsImported + result.snapshotsFailed} quotes=${quotesImported}/${quoteRows.length}${quoteError ? ` quote_err=${quoteError}` : ''}${result.errors.length ? ` errors=${JSON.stringify(result.errors).slice(0, 200)}` : ''}`,
      ),
    );
    return result.snapshotsFailed > 0 || quoteError ? 1 : 0;
  } catch (err) {
    const msg =
      err instanceof WealthfolioApiError
        ? `HTTP ${err.status}: ${err.body.slice(0, 200)}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`[ibkr-sync] snapshot import failed: ${msg}`);
    return 1;
  }
}

run().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[ibkr-sync] fatal:', err instanceof Error ? err.stack : err);
    process.exit(2);
  },
);
