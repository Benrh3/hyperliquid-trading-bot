// scripts/signal-probe.ts
// Q3: For three specific HYPE hours, print the exact value attachSignals placed on
//     each candle, its source table, its capturedAt, and the candle open/close times.
// Q4: First captured_at in raw snapshot_metrics for HYPE funding_rate.
// Run on the server where snapshot_metrics is populated.

import Database from "better-sqlite3";
import { resolve } from "path";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

const DB_PATH = process.env["DB_PATH"] ?? resolve(process.cwd(), "data/bot.db");
const db = new Database(DB_PATH, { readonly: true });

// ─── Target hours ─────────────────────────────────────────────────────────────
const TARGETS = [
  { label: "2026-06-16T07:00", ts: new Date("2026-06-16T07:00:00Z").getTime() },
  { label: "2026-06-16T10:00", ts: new Date("2026-06-16T10:00:00Z").getTime() },
  { label: "2026-06-18T13:00", ts: new Date("2026-06-18T13:00:00Z").getTime() },
];

const DEFAULT_RATE  = 1.25e-5;
const SHORT_THRESH  = 3 * DEFAULT_RATE;  // 3.75e-5
const HOUR_MS       = 3_600_000;

// ─── Q4: First raw captured_at ───────────────────────────────────────────────
const firstRaw = db.prepare(`
  SELECT sm.captured_at
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = 'HYPE' AND sm.metric_key = 'funding_rate'
  ORDER BY sm.captured_at ASC
  LIMIT 1
`).get() as { captured_at: number } | undefined;

console.log("═══ Q4: First raw snapshot_metrics captured_at for HYPE funding_rate ═══\n");
if (!firstRaw) {
  console.log("  NO ROWS in snapshot_metrics for HYPE funding_rate.");
} else {
  console.log(`  captured_at: ${firstRaw.captured_at}  →  ${new Date(firstRaw.captured_at).toISOString()}`);
  console.log("  This is the splice point: hourly rollup covers hours BEFORE this timestamp;");
  console.log("  raw rows cover this timestamp and everything after.");
}
console.log();

// ─── Load signals: hourly rollup ─────────────────────────────────────────────
const rawRows = db.prepare(`
  SELECT sm.captured_at AS ts, sm.value
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = 'HYPE' AND sm.metric_key = 'funding_rate'
  ORDER BY sm.captured_at ASC
`).all() as { ts: number; value: number | null }[];

// Hourly rollup: only for hours before the first raw row (same filter as store.ts)
const spliceTs = firstRaw?.captured_at ?? 9_999_999_999_999;
const hourlyRows = db.prepare(`
  SELECT ts_hour AS ts, avg_value AS value
  FROM snapshot_metrics_hourly
  WHERE symbol = 'HYPE' AND metric_key = 'funding_rate'
    AND ts_hour < ?
  ORDER BY ts_hour ASC
`).all(spliceTs) as { ts: number; value: number | null }[];

db.close();

// Tag each row with its source
type TaggedSig = { ts: number; value: number | null; source: "hourly" | "raw" };
const allSigs: TaggedSig[] = [
  ...hourlyRows.map(r => ({ ts: r.ts, value: r.value, source: "hourly" as const })),
  ...rawRows.map(r =>    ({ ts: r.ts, value: r.value, source: "raw"    as const })),
];

console.log(`Total signals: ${allSigs.length}  (hourly: ${hourlyRows.length}, raw: ${rawRows.length})`);
if (allSigs.length > 0) {
  console.log(`  Hourly: ${new Date(hourlyRows[0]?.ts ?? 0).toISOString()} → ${new Date(hourlyRows[hourlyRows.length-1]?.ts ?? 0).toISOString()}`);
  console.log(`  Raw:    ${new Date(rawRows[0]?.ts ?? 0).toISOString()} → ${new Date(rawRows[rawRows.length-1]?.ts ?? 0).toISOString()}`);
}
console.log();

// ─── Fetch HYPE candles for the relevant window ───────────────────────────────
// We only need candles around the target hours — fetch 48h window around each.
const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

const windowStart = Math.min(...TARGETS.map(t => t.ts)) - 2 * HOUR_MS;
const windowEnd   = Math.max(...TARGETS.map(t => t.ts)) + 4 * HOUR_MS;

console.log(`Fetching HYPE candles ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}...`);
const rawCandles = await info.candleSnapshot({
  coin:      "HYPE",
  interval:  "1h" as any,
  startTime: windowStart,
  endTime:   windowEnd,
});

type BtCandle = { timestamp: number; open: number; close: number; signals?: Record<string, number | null> };
const candles: BtCandle[] = rawCandles
  .sort((a: any, b: any) => a.t - b.t)
  .map((c: any) => ({ timestamp: c.t, open: +c.o, close: +c.c }));

console.log(`Candles fetched: ${candles.length}`);
console.log();

// ─── Replicate attachSignals logic to identify exactly which signal wins ──────
// attachSignals: for candle[i], closeTime = candles[i+1].timestamp (or +inferredInterval)
// Assigns the last signal with capturedAt <= closeTime.
// We want not just the value but also the source and capturedAt of the winning signal.

function findWinningSignal(closeTime: number): TaggedSig | null {
  // Find last entry in allSigs with ts <= closeTime
  let winner: TaggedSig | null = null;
  for (const sig of allSigs) {
    if (sig.ts <= closeTime) winner = sig;
    else break; // sorted ascending — past the cutoff
  }
  return winner;
}

// ─── Q3: Per-target analysis ─────────────────────────────────────────────────
console.log("═══ Q3: Signal probe for target hours ═══\n");

for (const target of TARGETS) {
  // Find the candle at this timestamp
  const idx = candles.findIndex(c => c.timestamp === target.ts);
  if (idx === -1) {
    console.log(`${target.label}: CANDLE NOT FOUND in fetched window`);
    console.log();
    continue;
  }

  const candle   = candles[idx]!;
  const nextC    = candles[idx + 1];
  const inferredInterval = candles.length > 1 ? candles[1]!.timestamp - candles[0]!.timestamp : HOUR_MS;
  const closeTime = nextC?.timestamp ?? (candle.timestamp + inferredInterval);

  const winner = findWinningSignal(closeTime);

  console.log(`${target.label}`);
  console.log(`  Candle open:   ${new Date(candle.timestamp).toISOString()}  (epoch ${candle.timestamp})`);
  console.log(`  Candle close:  ${new Date(closeTime).toISOString()}  (epoch ${closeTime})`);
  console.log(`  OHLC open:     ${candle.open}`);
  console.log(`  OHLC close:    ${candle.close}`);

  if (!winner) {
    console.log(`  Signal placed: null  (no capturedAt ≤ ${closeTime})`);
    console.log(`  Blocking:      NULL GUARD — onCandle returns null at line 66`);
  } else {
    const v = winner.value;
    const vStr = v !== null ? v.toExponential(6) : "null";
    const multiple = (v !== null && v !== undefined) ? (v / DEFAULT_RATE).toFixed(4) : "N/A";
    const aboveShort = v !== null && v !== undefined && v >= SHORT_THRESH;

    console.log(`  Signal placed: ${vStr}  (source: ${winner.source}, capturedAt: ${winner.ts}  →  ${new Date(winner.ts).toISOString()})`);
    console.log(`  As multiple:   ${multiple}× defaultRate`);
    console.log(`  ≥ 3.75e-5?:    ${aboveShort}  (shortThreshold = 3 × 1.25e-5 = 3.75e-5)`);

    if (v === null) {
      console.log(`  Blocking:      NULL GUARD (winner.value is null — no valid poll at this point)`);
    } else if (!aboveShort) {
      console.log(`  Blocking:      SHORT THRESHOLD CHECK: ${vStr} < 3.75e-5 → false → no entry`);
    } else {
      console.log(`  Entry would fire if position is FLAT (sig ${vStr} ≥ 3.75e-5 ✓)`);
    }

    // Show a window of signals around the closeTime to understand context
    const nearSigs = allSigs.filter(s => Math.abs(s.ts - closeTime) <= 4 * HOUR_MS);
    if (nearSigs.length > 0) {
      console.log(`  Signals within ±4h of bar close (cutoff = ${new Date(closeTime).toISOString()}):`);
      for (const s of nearSigs) {
        const delta = s.ts - closeTime;
        const arrow = s.ts <= closeTime ? "≤ cutoff (VISIBLE)" : "> cutoff (hidden)";
        const chosen = s === winner ? " ← CHOSEN" : "";
        console.log(`    capturedAt=${new Date(s.ts).toISOString()} (${delta > 0 ? "+" : ""}${delta}ms) [${s.source}]  val=${s.value?.toExponential(4) ?? "null"}  ${arrow}${chosen}`);
      }
    }
  }
  console.log();
}
