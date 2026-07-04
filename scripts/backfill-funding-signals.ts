#!/usr/bin/env npx tsx
/**
 * Backfill historical HYPE funding-rate data into the Market signal store.
 *
 * Usage:
 *   cd ~/hyperliquid-trading-bot
 *   npx tsx scripts/backfill-funding-signals.ts [--dry]
 *
 * What it does:
 *   Fetches HYPE funding history from Hyperliquid's public fundingHistory API,
 *   paginating backward to the earliest data the API serves, then inserts into
 *   the same snapshot_metrics table that the live poller writes — under the
 *   existing "funding_rate" key so getMetricTimeSeries() picks it up
 *   transparently alongside live-polled rows.
 *
 * Timestamp assumption (no lookahead):
 *   The API returns one record per funding period with field `time` (epoch ms).
 *   That timestamp is when the funding rate was published/settled — it is
 *   publicly known at that moment. Storing capturedAt = time is leak-free:
 *   a backtest at bar T will only see funding records where time <= closeTime(T).
 *
 * Storage design:
 *   funding_rate is NOT in funding_samples/rollups. It lives in snapshot_metrics
 *   (source="hl-market", kind="level"), joined to a parent snapshots row. Each
 *   backfilled funding period gets one snapshots row and one snapshot_metrics row.
 *   network is set to "mainnet" to match what the live poller writes.
 *
 * Idempotency:
 *   Before inserting, we check for an existing snapshot_metrics row with
 *   (metric_key='funding_rate', captured_at=T) via a JOIN on snapshots.symbol.
 *   If one exists, both rows are skipped. INSERT never overwrites live-polled data.
 */

import Database from "better-sqlite3";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { resolve } from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const COIN        = "HYPE";
const METRIC_KEY  = "funding_rate";
const SOURCE      = "hl-market";
const KIND        = "level";
const NETWORK     = "mainnet";
const DB_PATH     = resolve(process.cwd(), "data/bot.db");

// HL fundingHistory returns at most ~5000 records per call; use a wide window
// (30 days) per page to minimise round trips, then advance startTime.
const PAGE_WINDOW_MS = 30 * 24 * 3_600_000;
const FETCH_TIMEOUT  = 20_000;

const DRY = process.argv.includes("--dry");

// ── Open DB ───────────────────────────────────────────────────────────────────
if (DRY) console.log("[dry-run] No rows will be written.\n");
console.log(`[backfill] Opening ${DB_PATH}`);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");

// ── Prepared statements ───────────────────────────────────────────────────────
const stmtExists = db.prepare<[string, string, number], { n: number }>(`
  SELECT COUNT(*) AS n
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = ? AND sm.metric_key = ? AND sm.captured_at = ?
`);

const stmtInsertSnapshot = db.prepare<[string, string, number], { lastInsertRowid: bigint }>(
  "INSERT INTO snapshots (symbol, network, captured_at) VALUES (?, ?, ?)",
);

const stmtInsertMetric = db.prepare(
  "INSERT INTO snapshot_metrics (snapshot_id, metric_key, value, source, kind, meta_json, captured_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
);

// ── Determine time range ──────────────────────────────────────────────────────
// Start from the earliest existing backfilled row (or epoch 0 if none), then
// fetch forward. If there are already rows, start from the day before the
// earliest to avoid gaps.
const existingRange = db.prepare<[string, string], { minTs: number | null; maxTs: number | null }>(`
  SELECT MIN(sm.captured_at) AS minTs, MAX(sm.captured_at) AS maxTs
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = ? AND sm.metric_key = ?
`).get(COIN, METRIC_KEY) as { minTs: number | null; maxTs: number | null };

console.log(`[backfill] Existing ${METRIC_KEY} rows for ${COIN}:`);
if (existingRange.minTs) {
  console.log(`  earliest: ${new Date(existingRange.minTs).toISOString()}`);
  console.log(`  latest:   ${new Date(existingRange.maxTs!).toISOString()}`);
} else {
  console.log("  none — full backfill");
}

// Fetch from as early as HL serves. HYPE launched ~Nov 2024; use epoch 0 and
// let the API return an empty page when we go before data exists.
const FETCH_START = 0;
const FETCH_END   = Date.now();

// ── Fetch ─────────────────────────────────────────────────────────────────────
console.log(`\n[backfill] Fetching from HL API (mainnet, HYPE)…`);

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

type FundingRecord = { coin: string; fundingRate: string; premium: string; time: number };

async function fetchPage(startTime: number, endTime: number): Promise<FundingRecord[]> {
  const raw = await info.fundingHistory({
    coin: COIN,
    startTime,
    endTime,
  });
  return raw as FundingRecord[];
}

const allRecords: FundingRecord[] = [];
let pageStart = FETCH_START;

while (pageStart < FETCH_END) {
  const pageEnd = Math.min(pageStart + PAGE_WINDOW_MS, FETCH_END);
  process.stdout.write(
    `  fetching ${new Date(pageStart).toISOString().slice(0, 10)} → ${new Date(pageEnd).toISOString().slice(0, 10)}… `,
  );

  let page: FundingRecord[];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    page = await fetchPage(pageStart, pageEnd);
    clearTimeout(timer);
  } catch (e) {
    console.error(`\n[backfill] Fetch failed: ${(e as Error).message}`);
    process.exit(1);
  }

  process.stdout.write(`${page.length} records\n`);
  allRecords.push(...page);

  if (page.length === 0 && pageEnd >= FETCH_END) break;
  pageStart = pageEnd + 1;
}

if (allRecords.length === 0) {
  console.log("\n[backfill] No records returned from API. Nothing to insert.");
  db.close();
  process.exit(0);
}

// Deduplicate by timestamp (API may return duplicates at page boundaries)
const dedupedMap = new Map<number, FundingRecord>();
for (const r of allRecords) dedupedMap.set(r.time, r);
const records = [...dedupedMap.values()].sort((a, b) => a.time - b.time);

console.log(`\n[backfill] Fetched ${allRecords.length} raw → ${records.length} unique records`);
console.log(`  range: ${new Date(records[0].time).toISOString()} → ${new Date(records[records.length - 1].time).toISOString()}`);

// ── Insert ────────────────────────────────────────────────────────────────────
if (DRY) {
  // Count what would be inserted
  let wouldInsert = 0;
  let wouldSkip   = 0;
  for (const r of records) {
    const exists = (stmtExists.get(COIN, METRIC_KEY, r.time) as { n: number }).n > 0;
    if (exists) wouldSkip++;
    else         wouldInsert++;
  }
  console.log(`\n[dry-run] Would insert: ${wouldInsert}  Would skip: ${wouldSkip}`);
  db.close();
  process.exit(0);
}

let inserted = 0;
let skipped  = 0;
let errored  = 0;

const insertBatch = db.transaction((batch: FundingRecord[]) => {
  for (const r of batch) {
    const { n } = stmtExists.get(COIN, METRIC_KEY, r.time) as { n: number };
    if (n > 0) { skipped++; continue; }

    const value = parseFloat(r.fundingRate);
    if (!isFinite(value)) { errored++; continue; }

    try {
      const { lastInsertRowid } = stmtInsertSnapshot.run(COIN, NETWORK, r.time);
      stmtInsertMetric.run(Number(lastInsertRowid), METRIC_KEY, value, SOURCE, KIND, r.time);
      inserted++;
    } catch (e) {
      console.warn(`  WARN: failed at t=${r.time}: ${(e as Error).message}`);
      errored++;
    }
  }
});

// Process in batches of 500 to keep transactions short
const BATCH_SIZE = 500;
for (let i = 0; i < records.length; i += BATCH_SIZE) {
  const batch = records.slice(i, i + BATCH_SIZE);
  insertBatch(batch);
  process.stdout.write(`\r  inserted ${inserted}  skipped ${skipped}  errors ${errored}   `);
}
console.log();

// ── Report ────────────────────────────────────────────────────────────────────
const finalRange = db.prepare<[string, string], { minTs: number | null; maxTs: number | null }>(`
  SELECT MIN(sm.captured_at) AS minTs, MAX(sm.captured_at) AS maxTs
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = ? AND sm.metric_key = ?
`).get(COIN, METRIC_KEY) as { minTs: number | null; maxTs: number | null };

console.log("\n═══════════════════════════════════════════════════════");
console.log(" BACKFILL COMPLETE");
console.log("═══════════════════════════════════════════════════════");
console.log(`  Fetched:    ${records.length} unique funding records`);
console.log(`  Inserted:   ${inserted}`);
console.log(`  Skipped:    ${skipped}  (already present)`);
console.log(`  Errors:     ${errored}`);
if (finalRange.minTs) {
  console.log(`  DB range:   ${new Date(finalRange.minTs).toISOString()} → ${new Date(finalRange.maxTs!).toISOString()}`);
}
console.log("═══════════════════════════════════════════════════════\n");

db.close();
