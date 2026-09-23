// scripts/settled-timing-audit.ts
// Empirically determine what hour_ts labels in settled_funding for HYPE.
//
// For every hour H where a non-backfill settled row exists AND raw
// snapshot_metrics predictions exist in at least one of the two windows,
// compute:
//   prev_mean = avg(predicted samples in [H - HOUR_MS, H))  — previous accrual window
//   curr_mean = avg(predicted samples in [H, H + HOUR_MS))  — same-hour accrual window
//
// Then compute Pearson r:
//   corr_a = r(settled, prev_mean)   — hypothesis: hour_ts = settlement time (end of accrual)
//   corr_b = r(settled, curr_mean)   — hypothesis: hour_ts = accrual window start
//
// Interpretation:
//   corr_a >> corr_b  →  rate is known at hour_ts, capturedAt = hour_ts (correct as-is)
//   corr_b >> corr_a  →  rate not knowable until hour_ts + HOUR_MS, must shift capturedAt
//
// Usage: npx tsx scripts/settled-timing-audit.ts

import Database from "better-sqlite3";
import { resolve } from "path";

const HOUR_MS = 3_600_000;
const DB_PATH = process.env["DB_PATH"] ?? resolve(process.cwd(), "data/bot.db");

const db = new Database(DB_PATH, { readonly: true });

// ── 1. Inspect source_endpoint values ────────────────────────────────────────
console.log("=== settled_funding source_endpoint values ===");
const sources = db.prepare(`
  SELECT source_endpoint, COUNT(*) AS n, MIN(hour_ts) AS earliest, MAX(hour_ts) AS latest
  FROM settled_funding
  WHERE venue = 'HL' AND coin = 'HYPE'
  GROUP BY source_endpoint
  ORDER BY n DESC
`).all() as { source_endpoint: string; n: number; earliest: number; latest: number }[];

for (const s of sources) {
  console.log(`  ${s.source_endpoint.padEnd(40)} n=${s.n}  ` +
    `${new Date(s.earliest).toISOString()} → ${new Date(s.latest).toISOString()}`);
}
if (sources.length === 0) {
  console.log("  (no rows in settled_funding for HL/HYPE — run settled-signal-audit.ts first)");
  db.close();
  process.exit(0);
}

// Infer which source_endpoints are backfill
const backfillEndpoints = sources
  .map(s => s.source_endpoint)
  .filter(ep => /backfill|bulk|history/i.test(ep));
console.log(`\nExcluding as backfill: ${backfillEndpoints.length === 0 ? "(none matched — will exclude nothing)" : backfillEndpoints.join(", ")}`);

// ── 2. Load non-backfill settled rows ─────────────────────────────────────────
const placeholders = backfillEndpoints.map(() => "?").join(", ");
const excludeClause = backfillEndpoints.length > 0
  ? `AND source_endpoint NOT IN (${placeholders})`
  : "";

const settledRows = db.prepare(`
  SELECT hour_ts, rate
  FROM settled_funding
  WHERE venue = 'HL' AND coin = 'HYPE'
  ${excludeClause}
  ORDER BY hour_ts ASC
`).all(...backfillEndpoints) as { hour_ts: number; rate: number }[];

console.log(`\nNon-backfill settled rows: ${settledRows.length}`);
if (settledRows.length === 0) {
  console.log("  Nothing to correlate. Exiting.");
  db.close();
  process.exit(0);
}

// ── 3. Load ALL raw snapshot_metrics for HYPE funding_rate ───────────────────
// Bounded to the time range of settled rows ± 1 hour for efficiency.
const tMin = settledRows[0]!.hour_ts - HOUR_MS;
const tMax = settledRows[settledRows.length - 1]!.hour_ts + HOUR_MS;

const rawRows = db.prepare(`
  SELECT sm.captured_at, sm.value
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = 'HYPE' AND sm.metric_key = 'funding_rate'
    AND sm.captured_at >= ? AND sm.captured_at < ?
  ORDER BY sm.captured_at ASC
`).all(tMin, tMax) as { captured_at: number; value: number }[];

console.log(`Raw snapshot_metrics rows in range: ${rawRows.length}`);
if (rawRows.length < 10) {
  console.log("  Too few raw rows to compute meaningful correlations.");
  console.log("  (Dev DB is empty — run this script on the production server.)");
  db.close();
  process.exit(0);
}

// ── 4. For each settled hour, compute prev_mean and curr_mean ─────────────────
// Build a sorted index of raw rows so we can binary-search for time ranges.
function meanInRange(rows: { captured_at: number; value: number }[], lo: number, hi: number): number | null {
  // Binary search for first row >= lo
  let left = 0, right = rows.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (rows[mid]!.captured_at < lo) left = mid + 1; else right = mid;
  }
  let sum = 0, n = 0;
  for (let i = left; i < rows.length && rows[i]!.captured_at < hi; i++) {
    sum += rows[i]!.value;
    n++;
  }
  return n >= 1 ? sum / n : null;
}

interface Triplet { settled: number; prevMean: number; currMean: number; H: number }
const triplets: Triplet[] = [];
let nPrevOnly = 0, nCurrOnly = 0, nBoth = 0, nNeither = 0;

for (const { hour_ts: H, rate } of settledRows) {
  const prevMean = meanInRange(rawRows, H - HOUR_MS, H);
  const currMean = meanInRange(rawRows, H, H + HOUR_MS);
  if (prevMean !== null && currMean !== null) {
    triplets.push({ settled: rate, prevMean, currMean, H });
    nBoth++;
  } else if (prevMean !== null) {
    nPrevOnly++;
  } else if (currMean !== null) {
    nCurrOnly++;
  } else {
    nNeither++;
  }
}

console.log(`\nHours matched: both windows=${nBoth}  prev-only=${nPrevOnly}  curr-only=${nCurrOnly}  neither=${nNeither}`);

if (triplets.length < 5) {
  console.log("  Too few hours with both windows populated — cannot compute reliable correlations.");
  db.close();
  process.exit(0);
}

// ── 5. Pearson correlation ────────────────────────────────────────────────────
function pearson(xs: number[], ys: number[]): number {
  const n    = xs.length;
  const mx   = xs.reduce((s, x) => s + x, 0) / n;
  const my   = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 1e-20 ? num / denom : 0;
}

const settledVals  = triplets.map(t => t.settled);
const prevMeans    = triplets.map(t => t.prevMean);
const currMeans    = triplets.map(t => t.currMean);

const corrA = pearson(settledVals, prevMeans);   // settled vs prev window
const corrB = pearson(settledVals, currMeans);   // settled vs curr window

// ── 6. Sample rows ─────────────────────────────────────────────────────────
console.log("\n=== Sample triplets (first 8) ===");
console.log(`${"hour_ts (H)".padEnd(27)} ${"settled".padStart(12)} ${"prev_mean".padStart(12)} ${"curr_mean".padStart(12)}`);
console.log("-".repeat(65));
for (const t of triplets.slice(0, 8)) {
  console.log(
    `${new Date(t.H).toISOString().padEnd(27)} ` +
    `${t.settled.toExponential(4).padStart(12)} ` +
    `${t.prevMean.toExponential(4).padStart(12)} ` +
    `${t.currMean.toExponential(4).padStart(12)}`
  );
}

// ── 7. Results ────────────────────────────────────────────────────────────────
console.log("\n=== Correlation results ===");
console.log(`  n (hours with both windows):  ${triplets.length}`);
console.log(`  corr_a  r(settled, prev_window [H-1h, H)):   ${corrA.toFixed(4)}   ← hypothesis: hour_ts = settlement time`);
console.log(`  corr_b  r(settled, curr_window [H, H+1h)):   ${corrB.toFixed(4)}   ← hypothesis: hour_ts = accrual start`);
console.log(`  Δ = corr_b − corr_a:                         ${(corrB - corrA).toFixed(4)}`);

console.log("\n=== Conclusion ===");
const delta = corrB - corrA;
if (Math.abs(delta) < 0.03) {
  console.log("  AMBIGUOUS: both correlations are within 3pp. Cannot distinguish timing from this data.");
  console.log("  Consider checking HL docs or inspecting a known funding spike event directly.");
} else if (delta > 0.03) {
  console.log(`  corr_b > corr_a by ${delta.toFixed(3)} — hour_ts labels the ACCRUAL WINDOW START.`);
  console.log("  The settled rate is not knowable until hour_ts + HOUR_MS.");
  console.log("  ACTION: capturedAt must be set to hour_ts + HOUR_MS in wf-audit-2.ts (same as the rollup fix).");
} else {
  console.log(`  corr_a > corr_b by ${(-delta).toFixed(3)} — hour_ts labels the SETTLEMENT TIME (end of accrual).`);
  console.log("  The settled rate is knowable at hour_ts.");
  console.log("  ACTION: capturedAt = hour_ts is correct. No change needed in wf-audit-2.ts.");
}

db.close();
