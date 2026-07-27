#!/usr/bin/env npx tsx
/**
 * Backfill historical HYPE funding-rate data into the Market signal store.
 *
 * Usage:
 *   cd ~/hyperliquid-trading-bot
 *   npx tsx scripts/backfill-funding-signals.ts [--dry] [--repair]
 *
 * Flags:
 *   --dry     Preview only — shows counts and gap audit without writing rows.
 *   --repair  Gap-repair mode: start from BACKFILL_START regardless of existing
 *             hl-backfill rows. The per-row EXISTS check is the sole idempotency
 *             guard — no duplicates can be inserted. Use this to fill interior
 *             gaps that the normal resume (MAX(captured_at)) would skip past.
 *             Reports inserted-vs-skipped so you can confirm which rows were missing.
 *             Combine with --dry to preview before committing.
 *
 * Pagination:
 *   fundingHistory caps at 500 records per call. The script advances startTime to
 *   lastRecord.time + 1 after every full page (500 records) and keeps fetching
 *   until a page returns fewer than 500 records (stream exhausted). No fixed time
 *   windows — drains completely regardless of data density.
 *
 * Timestamp assumption (no lookahead):
 *   The API returns one record per funding period with field `time` (epoch ms).
 *   That timestamp is when the funding rate was published/settled — publicly known
 *   at that moment. Storing capturedAt = time is leak-free: a backtest at bar T
 *   only sees records where time <= closeTime(T).
 *
 * Storage design:
 *   funding_rate lives in snapshot_metrics (source="hl-market", kind="level"),
 *   joined to a parent snapshots row. Each backfilled period gets one snapshots
 *   row and one snapshot_metrics row. network is "mainnet" to match the live poller.
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
// "hl-backfill" distinguishes these rows from live-polled "hl-market" rows.
// Checked against all consumers before using this tag:
//   - getMetricTimeSeries: selects capturedAt+value only, no source filter
//   - buildScorecard / scoring engine: calls getMetricTimeSeries, never sees source
//   - attachSignals (backtest): calls getMetricTimeSeries, never sees source
//   - /api/market/signals: source in response comes from the manifest, not the DB
//   - market.ejs SRC_CLS badge: hardcoded tile definitions, not read from DB
//   - rollup (runRetentionPolicy): source is SELECT'd but not in GROUP BY; arbitrary row picked
//   - getRecentSnapshots / replay: source flows through to JSON but no code branches on it
// Deletion: DELETE FROM snapshot_metrics WHERE source = 'hl-backfill';
//           then DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM snapshot_metrics);
const SOURCE      = "hl-backfill";
const KIND        = "level";
const NETWORK     = "mainnet";
const DB_PATH     = resolve(process.cwd(), "data/bot.db");

// fundingHistory hard-caps at 500 records per call.
// After a full page the script advances startTime and keeps fetching.
const API_PAGE_SIZE = 500;

// HYPE genesis was ~Nov 2024. Starting from Oct 2024 avoids ~680 empty API
// pages that would fire before any data exists (epoch 0 → Oct 2024 = ~680 months).
const BACKFILL_START = new Date("2024-10-01T00:00:00Z").getTime();

const MAX_RETRIES      = 5;    // retry attempts per page on 429
const REQUEST_DELAY_MS = 250;  // courtesy delay between successful page fetches
const BACKOFF_BASE_MS  = 1_000; // base for 2^n exponential backoff on 429 (1s, 2s, 4s, 8s, 16s)

const DRY    = process.argv.includes("--dry");
const REPAIR = process.argv.includes("--repair");

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function is429(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many request");
}

// ── Open DB ───────────────────────────────────────────────────────────────────
if (DRY)    console.log("[dry-run] No rows will be written.\n");
if (REPAIR) console.log("[repair] Starting from BACKFILL_START — interior gaps will be filled.\n");
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

// ── Show existing data and determine resume point ─────────────────────────────
const existingRange = db.prepare<[string, string], { minTs: number | null; maxTs: number | null }>(`
  SELECT MIN(sm.captured_at) AS minTs, MAX(sm.captured_at) AS maxTs
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = ? AND sm.metric_key = ?
`).get(COIN, METRIC_KEY) as { minTs: number | null; maxTs: number | null };

console.log(`[backfill] Existing ${METRIC_KEY} rows for ${COIN} (all sources):`);
if (existingRange.minTs) {
  console.log(`  earliest: ${new Date(existingRange.minTs).toISOString()}`);
  console.log(`  latest:   ${new Date(existingRange.maxTs!).toISOString()}`);
} else {
  console.log("  none");
}

let pageStart: number;
if (REPAIR) {
  // --repair: ignore MAX(captured_at) so interior gaps aren't skipped
  pageStart = BACKFILL_START;
  console.log(`[backfill] --repair: fetching from BACKFILL_START ${new Date(pageStart).toISOString()} onward`);
} else {
  // Normal mode: resume from the latest hl-backfill row
  const latestBackfill = db.prepare<[string, string, string], { maxTs: number | null }>(`
    SELECT MAX(sm.captured_at) AS maxTs
    FROM snapshot_metrics sm
    JOIN snapshots s ON s.id = sm.snapshot_id
    WHERE s.symbol = ? AND sm.metric_key = ? AND sm.source = ?
  `).get(COIN, METRIC_KEY, SOURCE) as { maxTs: number | null };

  if (latestBackfill.maxTs !== null) {
    pageStart = latestBackfill.maxTs + 1;
    console.log(`[backfill] Resuming — latest hl-backfill: ${new Date(latestBackfill.maxTs).toISOString()}`);
    console.log(`           Fetching from ${new Date(pageStart).toISOString()} onward`);
  } else {
    pageStart = BACKFILL_START;
    console.log(`[backfill] Fresh backfill — starting from BACKFILL_START ${new Date(pageStart).toISOString()}`);
  }
}

const FETCH_END = Date.now();

// ── Fetch ─────────────────────────────────────────────────────────────────────
console.log(`\n[backfill] Fetching from HL API (mainnet, HYPE)…`);

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

type FundingRecord = { coin: string; fundingRate: string; premium: string; time: number };

async function fetchPage(startTime: number, endTime: number): Promise<FundingRecord[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await info.fundingHistory({ coin: COIN, startTime, endTime });
      return raw as FundingRecord[];
    } catch (e) {
      if (is429(e) && attempt < MAX_RETRIES) {
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
        process.stdout.write(
          `\n  [429] rate-limited — retry ${attempt + 1}/${MAX_RETRIES} in ${(backoffMs / 1000).toFixed(0)}s… `,
        );
        await sleep(backoffMs);
        continue;
      }
      throw e;
    }
  }
}

const allRecords: FundingRecord[] = [];
let pageCount = 0;

while (pageStart < FETCH_END) {
  if (pageCount > 0) await sleep(REQUEST_DELAY_MS);
  pageCount++;

  process.stdout.write(`  [page ${String(pageCount).padStart(3)}] from ${new Date(pageStart).toISOString().slice(0, 16)}… `);

  let page: FundingRecord[];
  try {
    page = await fetchPage(pageStart, FETCH_END);
  } catch (e) {
    console.error(`\n[backfill] Fetch failed: ${(e as Error).message}`);
    process.exit(1);
  }

  if (page.length === 0) {
    console.log("0 records (done)");
    break;
  }

  const lastTs = page[page.length - 1].time;
  console.log(`${page.length} records  (through ${new Date(lastTs).toISOString().slice(0, 10)})`);
  allRecords.push(...page);

  if (page.length < API_PAGE_SIZE) break; // < full page → stream exhausted

  // Full page: advance past the last returned record and fetch next batch
  pageStart = lastTs + 1;
}

if (allRecords.length === 0) {
  console.log("\n[backfill] No records returned from API. Nothing to insert.");
  runGapAudit();
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
// beyond parseFloat / safeNum. This block confirms the values agree in order of
// magnitude — no 8× or 100× scale error exists between the two sources.
//
// Expected discrepancy — predicted vs. settled:
//   The live poller samples metaAndAssetCtxs().funding, which is the *predicted*
//   (accruing) rate for the current hour, polled at an arbitrary minute within
//   that hour. fundingHistory returns the *settled* rate for each completed hour.
//   For the same hour these values are often identical (the protocol publishes the
//   settled rate at the period boundary), but if the poller fires mid-hour the two
//   can differ — sometimes by 10–20% relative — because the predicted rate tracks
//   live mark/index divergence while the settled rate is fixed at settlement time.
//   This intra-hour drift is normal and NOT a unit error.
//
// Verdict design:
//   We use the median of hist/live ratios across matched pairs. The median is robust
//   to the intra-hour drift outliers described above. A true unit mismatch (8× or
//   100×) shifts every ratio by that factor and fails by orders of magnitude; a few
//   outlier pairs from mid-hour sampling do not move the median meaningfully.
//   PASS band: median ratio in [0.5, 2.0]. Avg/max relative delta are informational.
//
// Matching: live-polled rows fire at an arbitrary minute within each hour. We pair
// each live row with the nearest historical settlement record within ±90 minutes.
// A systematic multiplier would be immediately visible in the ratio column even
// before a single row is inserted.
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
      relDelta:  number;
      ratio:     number;
    };

    const comparisons: Comparison[] = [];
    for (const live of liveRows) {
      const hist = nearestRecord(live.capturedAt);
      if (!hist) continue;
      const histVal = parseFloat(hist.fundingRate);
      if (!isFinite(histVal) || !isFinite(live.value) || live.value === 0) continue;
      comparisons.push({
        liveTs:   live.capturedAt,
        histTs:   hist.time,
        lagMs:    live.capturedAt - hist.time,
        liveVal:  live.value,
        histVal,
        absDelta: Math.abs(histVal - live.value),
        relDelta: Math.abs((histVal - live.value) / live.value),
        ratio:    histVal / live.value,
      });
      if (comparisons.length >= 10) break;
    }

    if (comparisons.length === 0) {
      console.log("  No historical records fall within ±90 min of any live-polled row.");
      console.log("  Possible causes: backfill range doesn't reach the live-poller window,");
      console.log("  or the poller ran exclusively outside settlement hour boundaries.\n");
    } else {
      const sortedRatios = [...comparisons.map(c => c.ratio)].sort((a, b) => a - b);
      const mid = Math.floor(sortedRatios.length / 2);
      const medianRatio = sortedRatios.length % 2 === 1
        ? sortedRatios[mid]
        : (sortedRatios[mid - 1] + sortedRatios[mid]) / 2;

      const RATIO_LO = 0.5;
      const RATIO_HI = 2.0;
      const passed = medianRatio >= RATIO_LO && medianRatio <= RATIO_HI;

      const avgRelDelta = comparisons.reduce((s, c) => s + c.relDelta, 0) / comparisons.length;
      const maxAbsDelta = Math.max(...comparisons.map(c => c.absDelta));

      console.log(`\n  Verdict: ${passed ? "✓ PASS" : "✗ FAIL"} — median ratio hist/live ${medianRatio.toFixed(4)}  (pass band [${RATIO_LO}, ${RATIO_HI}])`);
      console.log(`  Info:    avg relative delta ${(avgRelDelta * 100).toFixed(4)}%  max abs delta ${maxAbsDelta.toExponential(3)}  (intra-hour drift, not used for verdict)`);
      if (!passed) {
        console.log("  WARNING: median ratio outside pass band — likely unit mismatch (e.g. 8h vs 1h rate).");
        console.log("  DO NOT proceed with insertion. Review the comparison table and check the API documentation.\n");
        if (!DRY) {
          db.close();
          process.exit(1);
        }
      }

      const tableRows = comparisons.slice(0, 5);
      const COL = { ts: 22, lag: 10, live: 15, hist: 15, ratio: 8, delta: 12 };
      console.log(`\n  Showing ${tableRows.length} of ${comparisons.length} matched pairs (±90 min tolerance):`);
      console.log(
        `  ${"Live-polled (UTC)".padEnd(COL.ts)}` +
        `${"Lag (min)".padEnd(COL.lag)}` +
        `${"Live value".padEnd(COL.live)}` +
        `${"Hist value".padEnd(COL.hist)}` +
        `${"Ratio".padEnd(COL.ratio)}` +
        `${"Rel delta"}`,
      );
      console.log("  " + "─".repeat(COL.ts + COL.lag + COL.live + COL.hist + COL.ratio + COL.delta));
      for (const c of tableRows) {
        const lagMin = (c.lagMs / 60_000).toFixed(0).padStart(4);
        const relPct = (c.relDelta * 100).toFixed(4) + "%";
        console.log(
          `  ${new Date(c.liveTs).toISOString().slice(0, 19).padEnd(COL.ts)}` +
          `${lagMin} min    ` +
          `${c.liveVal.toFixed(8).padEnd(COL.live)}` +
          `${c.histVal.toFixed(8).padEnd(COL.hist)}` +
          `${c.ratio.toFixed(4).padEnd(COL.ratio)}` +
          relPct,
        );
      }
      console.log();
    }
  }
}

// ── Insert ────────────────────────────────────────────────────────────────────
let inserted = 0;
let skipped  = 0;
let errored  = 0;

if (DRY) {
  for (const r of records) {
    const exists = (stmtExists.get(COIN, METRIC_KEY, r.time) as { n: number }).n > 0;
    if (exists) skipped++;
    else         inserted++;
  }
  console.log(`[dry-run] Would insert: ${inserted}  Would skip: ${skipped}`);
  console.log();
  runGapAudit();
  db.close();
  process.exit(0);
}

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
console.log(` BACKFILL ${REPAIR ? "(REPAIR) " : ""}COMPLETE`);
console.log("═══════════════════════════════════════════════════════");
console.log(`  Fetched:    ${records.length} unique funding records`);
console.log(`  Inserted:   ${inserted}`);
console.log(`  Skipped:    ${skipped}  (already present)`);
console.log(`  Errors:     ${errored}`);
if (finalRange.minTs) {
  console.log(`  DB range:   ${new Date(finalRange.minTs).toISOString()} → ${new Date(finalRange.maxTs!).toISOString()}`);
}
console.log("═══════════════════════════════════════════════════════\n");

runGapAudit();

db.close();

// ── Gap audit ─────────────────────────────────────────────────────────────────
// Scans the full merged time series (raw snapshot_metrics + rolled-up hourly,
// the same UNION the backtest and signal reader use) for consecutive rows spaced
// more than 2 hours apart. Lists remaining holes so you can decide whether
// another --repair pass or manual investigation is needed.
function runGapAudit(): void {
  console.log("[gap audit] Scanning for holes > 2h in stored series…");

  type TsRow = { ts: number };
  const rows = db.prepare<[string, string, string, string], TsRow>(`
    SELECT sm.captured_at AS ts
    FROM snapshot_metrics sm
    JOIN snapshots s ON s.id = sm.snapshot_id
    WHERE s.symbol = ? AND sm.metric_key = ?
    UNION ALL
    SELECT ts_hour AS ts
    FROM snapshot_metrics_hourly
    WHERE symbol = ? AND metric_key = ?
    ORDER BY ts ASC
  `).all(COIN, METRIC_KEY, COIN, METRIC_KEY) as TsRow[];

  if (rows.length < 2) {
    console.log("  Fewer than 2 rows in DB — cannot audit.\n");
    return;
  }

  // Deduplicate (raw + hourly may overlap near rollup boundaries)
  const tsSorted = [...new Set(rows.map(r => r.ts))].sort((a, b) => a - b);

  const GAP_THRESHOLD_MS = 2 * 3_600_000; // > 2 hours
  const gaps: { from: number; to: number; hrs: number }[] = [];

  for (let i = 1; i < tsSorted.length; i++) {
    const gapMs = tsSorted[i] - tsSorted[i - 1];
    if (gapMs > GAP_THRESHOLD_MS) {
      gaps.push({ from: tsSorted[i - 1], to: tsSorted[i], hrs: gapMs / 3_600_000 });
    }
  }

  const span = `${new Date(tsSorted[0]).toISOString().slice(0, 10)} → ${new Date(tsSorted[tsSorted.length - 1]).toISOString().slice(0, 10)}`;
  if (gaps.length === 0) {
    console.log(`  ✓ No gaps > 2h found across ${tsSorted.length} rows  (${span})\n`);
  } else {
    const totalGapHrs = gaps.reduce((s, g) => s + g.hrs, 0);
    console.log(`  ✗ ${gaps.length} gap(s) > 2h found across ${tsSorted.length} rows  (${span})`);
    console.log(`    Total missing hours: ~${totalGapHrs.toFixed(0)}h`);
    for (const g of gaps) {
      const fromStr = new Date(g.from).toISOString().slice(0, 16);
      const toStr   = new Date(g.to).toISOString().slice(0, 16);
      console.log(`    ${fromStr} → ${toStr}  (${g.hrs.toFixed(1)}h)`);
    }
    console.log();
    console.log("  To fill these gaps: npx tsx scripts/backfill-funding-signals.ts --repair");
    console.log();
  }
}
