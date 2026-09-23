// scripts/settled-timing-audit.ts
// Empirically determine what hour_ts labels in settled_funding for HYPE.
//
// For every hour H where a non-backfill settled row exists:
//   prev_mean = avg(predicted samples in [H - HOUR_MS, H))  — prior-hour accrual window
//   curr_mean = avg(predicted samples in [H, H + HOUR_MS))  — same-hour accrual window
//
// Two INDEPENDENT correlations (each uses only hours where that arm's window exists):
//   corr_a = r(settled[H], prev_mean[H])  n_a pairs  — hypothesis: hour_ts = settlement time
//   corr_b = r(settled[H], curr_mean[H])  n_b pairs  — hypothesis: hour_ts = accrual start
//
// Also reports mean absolute error (MAE) per arm.  Correlation alone can be
// high for both arms when the series is slow-moving; MAE discriminates better.
//
// Decision rule:
//   corr_a > corr_b AND MAE_a < MAE_b  →  SETTLED_OFFSET_MS = 0 (rate known at hour_ts)
//   corr_b > corr_a AND MAE_b < MAE_a  →  SETTLED_OFFSET_MS = HOUR_MS (same as rollup fix)
//   Either arm n < 200                 →  INCONCLUSIVE, state so
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
  WHERE venue = 'hyperliquid' AND coin = 'HYPE'
  GROUP BY source_endpoint
  ORDER BY n DESC
`).all() as { source_endpoint: string; n: number; earliest: number; latest: number }[];

for (const s of sources) {
  console.log(`  ${s.source_endpoint.padEnd(40)} n=${s.n}  ` +
    `${new Date(s.earliest).toISOString()} → ${new Date(s.latest).toISOString()}`);
}
if (sources.length === 0) {
  const allVenueCoins = db.prepare(
    `SELECT venue, coin, COUNT(*) AS n FROM settled_funding GROUP BY venue, coin`
  ).all() as { venue: string; coin: string; n: number }[];
  const summary = allVenueCoins.map(r => `${r.venue}/${r.coin}(n=${r.n})`).join(", ");
  throw new Error(
    `No rows found for venue='hyperliquid'/coin='HYPE'. ` +
    `Distinct venue/coin in table: [${summary || "none"}]. ` +
    `Run settled-signal-audit.ts to backfill if the table is empty.`
  );
}

// Infer which source_endpoints are backfill
const backfillEndpoints = sources
  .map(s => s.source_endpoint)
  .filter(ep => /backfill|bulk|history/i.test(ep));
console.log(`\nExcluding as backfill: ${backfillEndpoints.length === 0 ? "(none matched)" : backfillEndpoints.join(", ")}`);

// ── 2. Load non-backfill settled rows ─────────────────────────────────────────
const excludeClause = backfillEndpoints.length > 0
  ? `AND source_endpoint NOT IN (${backfillEndpoints.map(() => "?").join(", ")})`
  : "";

const settledRows = db.prepare(`
  SELECT hour_ts, rate
  FROM settled_funding
  WHERE venue = 'hyperliquid' AND coin = 'HYPE'
  ${excludeClause}
  ORDER BY hour_ts ASC
`).all(...backfillEndpoints) as { hour_ts: number; rate: number }[];

console.log(`\nNon-backfill settled rows: ${settledRows.length}`);
if (settledRows.length < 1000) {
  const allVenueCoins = db.prepare(
    `SELECT venue, coin, COUNT(*) AS n FROM settled_funding GROUP BY venue, coin`
  ).all() as { venue: string; coin: string; n: number }[];
  const summary = allVenueCoins.map(r => `${r.venue}/${r.coin}(n=${r.n})`).join(", ");
  throw new Error(
    `settled_funding returned only ${settledRows.length} non-backfill rows for ` +
    `venue='hyperliquid'/coin='HYPE'. ` +
    `Distinct venue/coin in table: [${summary || "none"}]. ` +
    `Run settled-signal-audit.ts to backfill if the table is empty.`
  );
}

// ── 3. Load ALL raw snapshot_metrics for HYPE funding_rate ───────────────────
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

// ── 4. Build per-arm independent pair sets ────────────────────────────────────
// Each arm uses ALL settled hours where that window has prediction data — no
// requirement for both windows to be populated simultaneously.

function meanInRange(rows: { captured_at: number; value: number }[], lo: number, hi: number): number | null {
  let left = 0, right = rows.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (rows[mid]!.captured_at < lo) left = mid + 1; else right = mid;
  }
  let sum = 0, n = 0;
  for (let i = left; i < rows.length && rows[i]!.captured_at < hi; i++) {
    sum += rows[i]!.value; n++;
  }
  return n >= 1 ? sum / n : null;
}

interface Pair { settled: number; predicted: number; H: number }
const prevPairs: Pair[] = [];
const currPairs: Pair[] = [];

// Also collect triplets (both present) for the sample table
interface Triplet { settled: number; prevMean: number; currMean: number; H: number }
const triplets: Triplet[] = [];

for (const { hour_ts: H, rate } of settledRows) {
  const prevMean = meanInRange(rawRows, H - HOUR_MS, H);
  const currMean = meanInRange(rawRows, H, H + HOUR_MS);
  if (prevMean !== null) prevPairs.push({ settled: rate, predicted: prevMean, H });
  if (currMean !== null) currPairs.push({ settled: rate, predicted: currMean, H });
  if (prevMean !== null && currMean !== null) triplets.push({ settled: rate, prevMean, currMean, H });
}

console.log(`\nPair coverage:`);
console.log(`  Arm a — [H-1h, H):   n_a = ${prevPairs.length} (of ${settledRows.length} settled hours)`);
console.log(`  Arm b — [H, H+1h):   n_b = ${currPairs.length} (of ${settledRows.length} settled hours)`);
console.log(`  Both arms present:   ${triplets.length}`);

// ── 5. Statistics ─────────────────────────────────────────────────────────────

function pearson(pairs: Pair[]): number {
  const n  = pairs.length;
  const mx = pairs.reduce((s, p) => s + p.settled, 0) / n;
  const my = pairs.reduce((s, p) => s + p.predicted, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (const p of pairs) {
    const dx = p.settled - mx, dy = p.predicted - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 1e-20 ? num / denom : 0;
}

function mae(pairs: Pair[]): number {
  return pairs.reduce((s, p) => s + Math.abs(p.settled - p.predicted), 0) / pairs.length;
}

const corrA = pearson(prevPairs);
const corrB = pearson(currPairs);
const maeA  = mae(prevPairs);
const maeB  = mae(currPairs);

// ── 6. Sample table (hours where both arms present) ───────────────────────────
console.log("\n=== Sample rows — first 8 hours where both windows have predictions ===");
if (triplets.length === 0) {
  console.log("  (no overlap between settled rows and raw snapshot_metrics)");
} else {
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
}

// ── 7. Results ────────────────────────────────────────────────────────────────
const MIN_N = 200;
const inconclusiveA = prevPairs.length < MIN_N;
const inconclusiveB = currPairs.length < MIN_N;

console.log("\n=== Correlation + MAE results ===");
console.log(`  ${"Arm".padEnd(8)} ${"n".padStart(6)} ${"Pearson r".padStart(12)} ${"MAE (e-5)".padStart(12)}  Hypothesis`);
console.log("  " + "-".repeat(60));
console.log(
  `  ${"a".padEnd(8)} ${String(prevPairs.length).padStart(6)} ${corrA.toFixed(4).padStart(12)} ` +
  `${(maeA * 1e5).toFixed(3).padStart(12)}  settled[H] ~ mean([H-1h,H))  hour_ts=settlement`
);
console.log(
  `  ${"b".padEnd(8)} ${String(currPairs.length).padStart(6)} ${corrB.toFixed(4).padStart(12)} ` +
  `${(maeB * 1e5).toFixed(3).padStart(12)}  settled[H] ~ mean([H,H+1h))  hour_ts=accrual start`
);
console.log(`\n  Δ (b − a):  r = ${(corrB - corrA).toFixed(4)}   MAE = ${((maeB - maeA) * 1e5).toFixed(3)}e-5`);

if (inconclusiveA || inconclusiveB) {
  console.log(`\n=== Conclusion: INCONCLUSIVE ===`);
  if (inconclusiveA) console.log(`  Arm a has only ${prevPairs.length} pairs (< ${MIN_N} threshold).`);
  if (inconclusiveB) console.log(`  Arm b has only ${currPairs.length} pairs (< ${MIN_N} threshold).`);
  console.log("  Cannot make a reliable determination. Inspect the sample table above and/or");
  console.log("  check a known large-funding-spike event to determine hour_ts convention.");
  db.close();
  process.exit(0);
}

const delta = corrB - corrA;
const maeDelta = maeB - maeA;   // positive = a fits better, negative = b fits better
const rClear = Math.abs(delta) >= 0.03;
const maeClear = Math.abs(maeDelta) / Math.max(maeA, maeB) >= 0.05;   // ≥5% relative MAE difference

console.log("\n=== Conclusion ===");
if (!rClear && !maeClear) {
  console.log("  AMBIGUOUS: r and MAE differences are both small (Δr < 3pp, ΔMAE < 5% relative).");
  console.log("  Cannot distinguish hour_ts convention from this data alone.");
  console.log("  Inspect a known funding-spike event to determine which window aligned with the spike.");
} else if (delta <= -0.03 || (maeDelta > 0 && maeClear)) {
  // corr_a better, or MAE_a clearly smaller
  console.log(`  corr_a > corr_b (Δr = ${(-delta).toFixed(3)}) AND/OR MAE_a < MAE_b (Δ = ${(maeDelta*1e5).toFixed(3)}e-5)`);
  console.log("  hour_ts labels the SETTLEMENT TIME (end of accrual). Rate is known at hour_ts.");
  console.log("  SETTLED_OFFSET_MS = 0 is correct. No change needed in wf-audit-2.ts.");
} else {
  // corr_b better, or MAE_b clearly smaller
  console.log(`  corr_b > corr_a (Δr = ${delta.toFixed(3)}) AND/OR MAE_b < MAE_a (Δ = ${(-maeDelta*1e5).toFixed(3)}e-5)`);
  console.log("  hour_ts labels the ACCRUAL WINDOW START. Rate is not knowable until hour_ts + HOUR_MS.");
  console.log("  ACTION: set SETTLED_OFFSET_MS = HOUR_MS in wf-audit-2.ts (same fix as the rollup).");
}

db.close();
