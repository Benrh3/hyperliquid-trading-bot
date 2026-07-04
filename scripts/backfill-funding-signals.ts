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

// ── Unit/transform verification ───────────────────────────────────────────────
// Compare backfill values (fundingHistory API, settled rates) against live-polled
// rows already in the DB (metaAndAssetCtxs().funding, current-period accruing rate).
//
// Both APIs return a plain decimal string; no transform is applied by either path
// beyond parseFloat / safeNum. This block confirms the values agree in practice:
// settled rates and accruing rates for the same period should be equal or very close.
//
// Matching: live-polled rows fire at an arbitrary minute within each hour. We pair
// each live row with the nearest historical settlement record within ±90 minutes.
// A systematic multiplier (e.g. 8× for 8h vs hourly mismatch) would be immediately
// visible in the delta column even before a single row is inserted.
{
  const OVERLAP_WINDOW_MS  = 7 * 24 * 3_600_000; // look back 7 days for live rows
  const MATCH_TOLERANCE_MS = 90 * 60 * 1000;      // ±90 min to pair with a settlement

  type LiveRow = { capturedAt: number; value: number };
  const liveRows = db.prepare<[string, string, number], LiveRow>(`
    SELECT sm.captured_at AS capturedAt, sm.value
    FROM snapshot_metrics sm
    JOIN snapshots s ON s.id = sm.snapshot_id
    WHERE s.symbol = ? AND sm.metric_key = ?
      AND sm.captured_at >= ?
    ORDER BY sm.captured_at ASC
  `).all(COIN, METRIC_KEY, Date.now() - OVERLAP_WINDOW_MS) as LiveRow[];

  console.log(`\n[verify] Live-polled rows in the last 7 days: ${liveRows.length}`);

  if (liveRows.length === 0) {
    console.log("  No live-polled rows to compare against — poller may not have run yet.");
    console.log("  Cannot verify unit alignment until the poller has accumulated data.\n");
  } else {
    // For each live row, binary-search records[] for the nearest settlement by time
    function nearestRecord(targetMs: number): FundingRecord | null {
      let lo = 0, hi = records.length - 1, best: FundingRecord | null = null;
      let bestDist = Infinity;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const dist = Math.abs(records[mid].time - targetMs);
        if (dist < bestDist) { bestDist = dist; best = records[mid]; }
        if (records[mid].time < targetMs) lo = mid + 1;
        else hi = mid - 1;
      }
      return bestDist <= MATCH_TOLERANCE_MS ? best : null;
    }

    type Comparison = {
      liveTs:    number;
      histTs:    number;
      lagMs:     number;
      liveVal:   number;
      histVal:   number;
      absDelta:  number;
      relDelta:  number; // fraction, not percent
    };

    const comparisons: Comparison[] = [];
    for (const live of liveRows) {
      const hist = nearestRecord(live.capturedAt);
      if (!hist) continue;
      const histVal = parseFloat(hist.fundingRate);
      if (!isFinite(histVal) || !isFinite(live.value)) continue;
      comparisons.push({
        liveTs:   live.capturedAt,
        histTs:   hist.time,
        lagMs:    live.capturedAt - hist.time,
        liveVal:  live.value,
        histVal,
        absDelta: Math.abs(histVal - live.value),
        relDelta: live.value !== 0 ? Math.abs((histVal - live.value) / live.value) : 0,
      });
      if (comparisons.length >= 10) break; // collect 10, show 5
    }

    if (comparisons.length === 0) {
      console.log("  No historical records fall within ±90 min of any live-polled row.");
      console.log("  Possible causes: backfill range doesn't reach the live-poller window,");
      console.log("  or the poller ran exclusively outside settlement hour boundaries.\n");
    } else {
      // Compute aggregate stats over all matches
      const avgRelDelta = comparisons.reduce((s, c) => s + c.relDelta, 0) / comparisons.length;
      const maxAbsDelta = Math.max(...comparisons.map(c => c.absDelta));

      // Emit a clear PASS/FAIL verdict before the table
      const PASS_THRESHOLD = 0.01; // 1% relative delta tolerated (accounts for accrual drift)
      const passed = avgRelDelta < PASS_THRESHOLD;
      console.log(`\n  Verdict: ${passed ? "✓ PASS" : "✗ FAIL"} — avg relative delta ${(avgRelDelta * 100).toFixed(4)}%  max abs delta ${maxAbsDelta.toExponential(3)}`);
      if (!passed) {
        console.log("  WARNING: values differ by more than 1% on average.");
        console.log("  Possible unit mismatch (e.g. 8h vs 1h rate). DO NOT proceed with insertion.");
        console.log("  Review the comparison table and check the API documentation.\n");
        if (!DRY) {
          db.close();
          process.exit(1);
        }
      }

      // Print 5-row comparison table
      const tableRows = comparisons.slice(0, 5);
      const COL = { ts: 22, lag: 10, live: 15, hist: 15, delta: 12 };
      console.log(`\n  Showing ${tableRows.length} of ${comparisons.length} matched pairs (±90 min tolerance):`);
      console.log(
        `  ${"Live-polled (UTC)".padEnd(COL.ts)}` +
        `${"Lag (min)".padEnd(COL.lag)}` +
        `${"Live value".padEnd(COL.live)}` +
        `${"Hist value".padEnd(COL.hist)}` +
        `${"Rel delta"}`,
      );
      console.log("  " + "─".repeat(COL.ts + COL.lag + COL.live + COL.hist + COL.delta));
      for (const c of tableRows) {
        const lagMin = (c.lagMs / 60_000).toFixed(0).padStart(4);
        const relPct = (c.relDelta * 100).toFixed(4) + "%";
        console.log(
          `  ${new Date(c.liveTs).toISOString().slice(0, 19).padEnd(COL.ts)}` +
          `${lagMin} min    ` +
          `${c.liveVal.toFixed(8).padEnd(COL.live)}` +
          `${c.histVal.toFixed(8).padEnd(COL.hist)}` +
          relPct,
        );
      }
      console.log();
    }
  }
}

// ── Insert ────────────────────────────────────────────────────────────────────
if (DRY) {
  // Count what would be inserted (verification already printed above)
  let wouldInsert = 0;
  let wouldSkip   = 0;
  for (const r of records) {
    const exists = (stmtExists.get(COIN, METRIC_KEY, r.time) as { n: number }).n > 0;
    if (exists) wouldSkip++;
    else         wouldInsert++;
  }
  console.log(`[dry-run] Would insert: ${wouldInsert}  Would skip: ${wouldSkip}`);
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
