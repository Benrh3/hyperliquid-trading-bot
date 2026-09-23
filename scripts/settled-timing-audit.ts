// scripts/settled-timing-audit.ts
// Empirically determine what hour_ts labels in settled_funding for HYPE.
//
// Settled series: ALL rows for venue='hyperliquid', coin='HYPE'.
// No source_endpoint exclusion — settled_funding is populated exclusively
// from fundingHistory and none of it should be excluded.
//
// Predicted series: snapshot_metrics_hourly WHERE source='hl-market' (NOT
// 'hl-backfill' — those rows were derived from the same fundingHistory
// endpoint and would make both correlations spuriously near 1.0), plus all
// raw snapshot_metrics rows (live poller only, no backfill path exists there).
//
// For every settled hour H in the overlap window:
//   prev_mean = avg(predicted in [H - HOUR_MS, H))  — prior-hour window
//   curr_mean = avg(predicted in [H, H + HOUR_MS))  — same-hour window
//
// Two INDEPENDENT correlations (each uses only hours where that arm exists):
//   corr_a = r(settled[H], prev_mean[H])  n_a pairs  — hour_ts = settlement time (end of accrual)
//   corr_b = r(settled[H], curr_mean[H])  n_b pairs  — hour_ts = accrual window start
//
// MAE is reported alongside Pearson r: slow-moving series can show high r
// for both arms; error magnitude better discriminates which window fits.
//
// Either arm n < 200 → INCONCLUSIVE.
//
// Usage: npx tsx scripts/settled-timing-audit.ts

import Database from "better-sqlite3";
import { resolve } from "path";

const HOUR_MS  = 3_600_000;
const DB_PATH  = process.env["DB_PATH"] ?? resolve(process.cwd(), "data/bot.db");
const MIN_N    = 200;

const db = new Database(DB_PATH, { readonly: true });

// ── 1. Load settled series — ALL rows, no source exclusion ────────────────────
console.log("=== Settled series (settled_funding, venue='hyperliquid', coin='HYPE') ===");

const settledRows = db.prepare(`
  SELECT hour_ts, rate
  FROM settled_funding
  WHERE venue = 'hyperliquid' AND coin = 'HYPE'
  ORDER BY hour_ts ASC
`).all() as { hour_ts: number; rate: number }[];

if (settledRows.length < 1000) {
  const venueCoins = db.prepare(
    `SELECT venue, coin, COUNT(*) AS n FROM settled_funding GROUP BY venue, coin`
  ).all() as { venue: string; coin: string; n: number }[];
  const summary = venueCoins.map(r => `${r.venue}/${r.coin}(n=${r.n})`).join(", ");
  throw new Error(
    `settled_funding returned only ${settledRows.length} rows for ` +
    `venue='hyperliquid'/coin='HYPE'. ` +
    `Distinct venue/coin in table: [${summary || "none"}]. ` +
    `Run settled-signal-audit.ts to backfill if the table is empty.`
  );
}

const settledEarliest = settledRows[0]!.hour_ts;
const settledLatest   = settledRows[settledRows.length - 1]!.hour_ts;
console.log(`  Rows:  ${settledRows.length}`);
console.log(`  Range: ${new Date(settledEarliest).toISOString()} → ${new Date(settledLatest).toISOString()}`);

// ── 2. Load predicted series — hl-market hourly only, plus all raw rows ────────
console.log("\n=== Predicted series (snapshot_metrics_hourly source='hl-market' + raw) ===");

// Hourly rollup: hl-market source only. hl-backfill rows come from fundingHistory
// and would be identical to the settled values — including them makes both
// correlations spuriously near 1.0. capturedAt = ts_hour + HOUR_MS (bucket end).
const hourlyRows = db.prepare(`
  SELECT ts_hour + ${HOUR_MS} AS captured_at, avg_value AS value
  FROM snapshot_metrics_hourly
  WHERE symbol = 'HYPE' AND metric_key = 'funding_rate' AND source = 'hl-market'
  ORDER BY ts_hour ASC
`).all() as { captured_at: number; value: number }[];

// Raw snapshot_metrics: live poller only, no backfill path.
// Bounded to ±1h of settled range for efficiency.
const rawRows = db.prepare(`
  SELECT sm.captured_at, sm.value
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = 'HYPE' AND sm.metric_key = 'funding_rate'
    AND sm.captured_at >= ? AND sm.captured_at < ?
  ORDER BY sm.captured_at ASC
`).all(settledEarliest - HOUR_MS, settledLatest + HOUR_MS) as { captured_at: number; value: number }[];

const hourlyEarliest = hourlyRows.length > 0 ? hourlyRows[0]!.captured_at : null;
const hourlyLatest   = hourlyRows.length > 0 ? hourlyRows[hourlyRows.length - 1]!.captured_at : null;
const rawEarliest    = rawRows.length > 0 ? rawRows[0]!.captured_at : null;
const rawLatest      = rawRows.length > 0 ? rawRows[rawRows.length - 1]!.captured_at : null;

console.log(`  Hourly (hl-market): ${hourlyRows.length} rows` +
  (hourlyEarliest ? `  ${new Date(hourlyEarliest).toISOString()} → ${new Date(hourlyLatest!).toISOString()}` : "  (none)"));
console.log(`  Raw (live poller):  ${rawRows.length} rows` +
  (rawEarliest ? `  ${new Date(rawEarliest).toISOString()} → ${new Date(rawLatest!).toISOString()}` : "  (none)"));

// Merge, deduplicate by captured_at (raw wins), sort ascending.
const allPredicted: { captured_at: number; value: number }[] = [];
const seenTs = new Set<number>();
for (const r of rawRows) { seenTs.add(r.captured_at); allPredicted.push(r); }
for (const h of hourlyRows) { if (!seenTs.has(h.captured_at)) allPredicted.push(h); }
allPredicted.sort((a, b) => a.captured_at - b.captured_at);

const predEarliest = allPredicted.length > 0 ? allPredicted[0]!.captured_at : null;
const predLatest   = allPredicted.length > 0 ? allPredicted[allPredicted.length - 1]!.captured_at : null;

console.log(`  Combined:           ${allPredicted.length} rows` +
  (predEarliest ? `  ${new Date(predEarliest).toISOString()} → ${new Date(predLatest!).toISOString()}` : "  (none)"));

if (allPredicted.length < 10) {
  console.log("\n  Too few predicted rows to compute meaningful correlations.");
  console.log("  (Dev DB is empty — run this script on the production server.)");
  db.close();
  process.exit(0);
}

// ── 3. Overlap window ─────────────────────────────────────────────────────────
const overlapStart = Math.max(settledEarliest, predEarliest ?? settledEarliest);
const overlapEnd   = Math.min(settledLatest,   predLatest   ?? settledLatest);
const overlapHours = Math.max(0, Math.round((overlapEnd - overlapStart) / HOUR_MS));

console.log("\n=== Overlap window ===");
if (overlapHours === 0) {
  console.log("  No overlap between settled and predicted series. Cannot compute correlations.");
  db.close();
  process.exit(0);
}
console.log(`  ${new Date(overlapStart).toISOString()} → ${new Date(overlapEnd).toISOString()}`);
console.log(`  ${overlapHours} hours`);
if (predEarliest !== null && predEarliest > settledEarliest) {
  const gapHours = Math.round((predEarliest - settledEarliest) / HOUR_MS);
  console.log(`  Note: settled series starts ${gapHours}h earlier than predicted; ` +
    `${settledRows.filter(r => r.hour_ts < overlapStart).length} settled rows are pre-overlap and will not appear in either arm.`);
}

// ── 4. Build per-arm independent pair sets ────────────────────────────────────
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
interface Triplet { settled: number; prevMean: number; currMean: number; H: number }
const triplets: Triplet[] = [];

for (const { hour_ts: H, rate } of settledRows) {
  if (H < overlapStart - HOUR_MS || H > overlapEnd + HOUR_MS) continue;
  const prevMean = meanInRange(allPredicted, H - HOUR_MS, H);
  const currMean = meanInRange(allPredicted, H, H + HOUR_MS);
  if (prevMean !== null) prevPairs.push({ settled: rate, predicted: prevMean, H });
  if (currMean !== null) currPairs.push({ settled: rate, predicted: currMean, H });
  if (prevMean !== null && currMean !== null) triplets.push({ settled: rate, prevMean, currMean, H });
}

console.log(`\n=== Pair counts ===`);
console.log(`  Arm a — settled[H] vs mean([H-1h, H)):   n_a = ${prevPairs.length}`);
console.log(`  Arm b — settled[H] vs mean([H, H+1h)):   n_b = ${currPairs.length}`);
console.log(`  Both arms present:                        ${triplets.length}`);
if (overlapHours > 0 && (prevPairs.length < overlapHours * 0.3 || currPairs.length < overlapHours * 0.3)) {
  console.log(`  (Low pair count relative to ${overlapHours}h overlap — predicted series may be sparse)`);
}

// ── 5. Statistics ─────────────────────────────────────────────────────────────
function pearsonPairs(pairs: Pair[]): number {
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

// ── 6. Sample table ───────────────────────────────────────────────────────────
console.log("\n=== Sample rows — first 8 hours where both arms have predictions ===");
if (triplets.length === 0) {
  console.log("  (no overlap hours where both windows have predictions)");
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
const inconclusiveA = prevPairs.length < MIN_N;
const inconclusiveB = currPairs.length < MIN_N;

if (inconclusiveA || inconclusiveB) {
  console.log(`\n=== Conclusion: INCONCLUSIVE ===`);
  if (inconclusiveA) console.log(`  Arm a has only ${prevPairs.length} pairs (threshold: ${MIN_N}).`);
  if (inconclusiveB) console.log(`  Arm b has only ${currPairs.length} pairs (threshold: ${MIN_N}).`);
  console.log("  Cannot make a reliable determination.");
  db.close();
  process.exit(0);
}

const corrA = pearsonPairs(prevPairs);
const corrB = pearsonPairs(currPairs);
const maeA  = mae(prevPairs);
const maeB  = mae(currPairs);

console.log("\n=== Correlation + MAE results ===");
console.log(`  ${"Arm".padEnd(8)} ${"n".padStart(6)} ${"Pearson r".padStart(12)} ${"MAE (×1e-5)".padStart(13)}  Hypothesis`);
console.log("  " + "-".repeat(65));
console.log(
  `  ${"a".padEnd(8)} ${String(prevPairs.length).padStart(6)} ${corrA.toFixed(4).padStart(12)} ` +
  `${(maeA * 1e5).toFixed(3).padStart(13)}  settled[H] ~ [H-1h, H)  → hour_ts = settlement time`
);
console.log(
  `  ${"b".padEnd(8)} ${String(currPairs.length).padStart(6)} ${corrB.toFixed(4).padStart(12)} ` +
  `${(maeB * 1e5).toFixed(3).padStart(13)}  settled[H] ~ [H, H+1h)  → hour_ts = accrual start`
);
console.log(`\n  Δ (b − a):  r = ${(corrB - corrA).toFixed(4)}   MAE = ${((maeB - maeA) * 1e5).toFixed(3)}e-5`);

const delta     = corrB - corrA;
const maeDelta  = maeB - maeA;     // positive = arm a fits better (lower MAE)
const rClear    = Math.abs(delta) >= 0.03;
const maeClear  = Math.abs(maeDelta) / Math.max(maeA, maeB) >= 0.05;

console.log("\n=== Conclusion ===");
if (!rClear && !maeClear) {
  console.log("  AMBIGUOUS: Δr < 3pp and ΔMAE < 5% relative. Cannot distinguish convention from data alone.");
  console.log("  Inspect the sample table above or a known funding-spike event.");
} else if (delta <= -0.03 || (maeDelta > 0 && maeClear)) {
  console.log(`  corr_a ≥ corr_b (Δr=${(-delta).toFixed(3)})  AND/OR  MAE_a < MAE_b (Δ=${(maeDelta*1e5).toFixed(3)}e-5)`);
  console.log("  hour_ts = SETTLEMENT TIME (end of accrual). Rate is known at hour_ts.");
  console.log("  SETTLED_OFFSET_MS = 0 is correct. No change needed in wf-audit-2.ts.");
} else {
  console.log(`  corr_b > corr_a (Δr=${delta.toFixed(3)})  AND/OR  MAE_b < MAE_a (Δ=${(-maeDelta*1e5).toFixed(3)}e-5)`);
  console.log("  hour_ts = ACCRUAL WINDOW START. Rate not knowable until hour_ts + HOUR_MS.");
  console.log("  ACTION: set SETTLED_OFFSET_MS = HOUR_MS in wf-audit-2.ts (same fix as the rollup).");
}

db.close();
