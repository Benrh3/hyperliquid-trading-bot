#!/usr/bin/env npx tsx
/**
 * Funding-Extreme backtest — run this on the server to get actual results.
 *
 *   cd ~/hyperliquid-trading-bot && npx tsx scripts/backtest-funding-extreme.ts
 *
 * What it does:
 *   1. Reads funding_rate signal history from data/bot.db (raw + hourly rollup)
 *   2. Prints trailing-percentile sanity samples at evenly spaced bars
 *   3. Fetches HYPE 1h candles covering that same window from HL API
 *   4. Attaches signals to candles (correct close-time cutoff via attachSignals)
 *   5. Runs FundingExtremeStrategy with default params
 *   6. Reports: full trade log (funding + point-in-time percentile at entry),
 *      alignment check, exit-reason distribution, aggregate stats, equity curve
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { attachSignals, runBacktest } from "../src/backtest.js";
import { computePercentile, FundingExtremeStrategy, SIGNAL_KEY } from "../src/strategy/funding-extreme.js";

// ── Config ────────────────────────────────────────────────────────────────────
const DB_PATH    = resolve(process.cwd(), "data/bot.db");
const COIN       = "HYPE";
const INTERVAL   = "1h";
const COMMISSION = 0.0005;      // 0.05%/side — matches live + paper paths
const EQUITY     = 1000;
const SIZE_USD   = 500;

const PARAMS = {
  entryLongBelow:     0.10,
  entryShortAbove:    0.90,
  exitBandLow:        0.40,
  exitBandHigh:       0.60,
  trailingWindowBars: 720,   // 30 days × 24h
  maxHoldBars:        72,    // 3 days × 24h
  stopLossPct:        6,
};

// ── 1. Load signal history from DB ───────────────────────────────────────────
console.log(`\n[1/6] Loading signal history from ${DB_PATH}...`);
const db = new Database(DB_PATH, { readonly: true });

const signalRows = db.prepare(`
  SELECT sm.captured_at AS ts, sm.value AS value
  FROM snapshot_metrics sm
  JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = ? AND sm.metric_key = ?
  UNION ALL
  SELECT ts_hour AS ts, avg_value AS value
  FROM snapshot_metrics_hourly
  WHERE symbol = ? AND metric_key = ?
  ORDER BY ts ASC
`).all(COIN, SIGNAL_KEY, COIN, SIGNAL_KEY) as { ts: number; value: number | null }[];

db.close();

if (signalRows.length === 0) {
  console.error(`\nERROR: No rows found for ${SIGNAL_KEY}. Run scripts/backfill-funding-signals.ts first.`);
  process.exit(1);
}

const values = signalRows.filter(r => r.value !== null).map(r => r.value as number);
console.log(`  Signal rows: ${signalRows.length} (${values.length} non-null)`);
console.log(`  Date range:  ${new Date(signalRows[0].ts).toISOString()} → ${new Date(signalRows[signalRows.length - 1].ts).toISOString()}`);
console.log(`  Value range: ${Math.min(...values).toExponential(3)} – ${Math.max(...values).toExponential(3)}`);

// ── 2. Trailing-percentile sanity samples ─────────────────────────────────────
console.log(`\n[2/6] Trailing-percentile sanity samples (window=${PARAMS.trailingWindowBars} bars)...`);

// Sample at 10 evenly-spaced points after the warm-up period
const sampleCount = 10;
const sampleInterval = Math.floor((values.length - PARAMS.trailingWindowBars) / sampleCount);

if (sampleInterval > 0) {
  console.log(`  ${"Bar".padEnd(6)} ${"Date".padEnd(22)} ${"Funding".padEnd(14)} ${"p10".padEnd(12)} ${"p90".padEnd(12)} ${"Rank"}`);
  for (let s = 0; s < sampleCount; s++) {
    const barIdx = PARAMS.trailingWindowBars + s * sampleInterval;
    if (barIdx >= values.length) break;
    const window  = values.slice(Math.max(0, barIdx - PARAMS.trailingWindowBars + 1), barIdx + 1);
    const sorted  = [...window].sort((a, b) => a - b);
    const p10     = computePercentile(sorted, PARAMS.entryLongBelow);
    const p90     = computePercentile(sorted, PARAMS.entryShortAbove);
    const val     = values[barIdx];
    const rank    = sorted.filter(v => v <= val).length / sorted.length;
    const rankStr = `p${(rank * 100).toFixed(0)}`;
    const ts      = signalRows[barIdx].ts;
    console.log(`  ${String(barIdx).padEnd(6)} ${new Date(ts).toISOString().slice(0, 16).padEnd(22)} ${val.toExponential(3).padEnd(14)} ${p10.toExponential(3).padEnd(12)} ${p90.toExponential(3).padEnd(12)} ${rankStr}`);
  }
} else {
  console.log("  (not enough data for warm-up + samples — run with more history)");
}

// ── 3. Fetch HYPE candles for the signal window ───────────────────────────────
console.log("\n[3/6] Fetching HYPE 1h candles from HL API...");
const startTime = signalRows[0].ts;
const endTime   = signalRows[signalRows.length - 1].ts + 3_600_000;

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
const raw = await info.candleSnapshot({ coin: COIN, interval: INTERVAL as "1h", startTime, endTime });
const candles = raw.map(c => ({
  timestamp: c.t,
  open:      parseFloat(c.o as unknown as string),
  high:      parseFloat(c.h as unknown as string),
  low:       parseFloat(c.l as unknown as string),
  close:     parseFloat(c.c as unknown as string),
  volume:    parseFloat(c.v as unknown as string),
}));

console.log(`  Fetched ${candles.length} 1h candles`);
if (candles.length === 0) { console.error("ERROR: No candles returned."); process.exit(1); }

// ── 4. Attach signals ─────────────────────────────────────────────────────────
console.log("\n[4/6] Attaching signals to candles...");
const signalMap = new Map([[
  SIGNAL_KEY,
  signalRows.map(r => ({ capturedAt: r.ts, value: r.value })),
]]);
const coverage = attachSignals(candles, signalMap);
const cov = coverage[0];
console.log(`  Coverage: ${cov?.filled ?? 0} / ${cov?.total ?? 0} candles have signal (${cov ? ((cov.filled / cov.total) * 100).toFixed(1) : 0}%)`);

const candlesWithSignal = candles.filter(c => c.signals?.[SIGNAL_KEY] !== null && c.signals?.[SIGNAL_KEY] !== undefined);
if (candlesWithSignal.length < PARAMS.trailingWindowBars) {
  console.error(`ERROR: Only ${candlesWithSignal.length} candles have signal — need at least ${PARAMS.trailingWindowBars} for warm-up.`);
  process.exit(1);
}

// ── 5. Run backtest ───────────────────────────────────────────────────────────
console.log("\n[5/6] Running backtest...\n");

const strategy = new FundingExtremeStrategy(PARAMS);

const result = runBacktest(strategy, candles, {
  initialEquity:   EQUITY,
  positionSizeUsd: SIZE_USD,
  stopLossPct:     PARAMS.stopLossPct,
  commissionPct:   COMMISSION,
});

// ── 6. Report ─────────────────────────────────────────────────────────────────
console.log("[6/6] Results\n");
const pctReturn = EQUITY > 0 ? (result.totalPnl / EQUITY * 100) : 0;

console.log("═══════════════════════════════════════════════════════════════════");
console.log(" FUNDING EXTREME BACKTEST — HYPE funding_rate");
console.log("═══════════════════════════════════════════════════════════════════");
console.log(`  Signal window:  ${new Date(startTime).toISOString().slice(0,16)} → ${new Date(endTime).toISOString().slice(0,16)}`);
console.log(`  Trailing window: ${PARAMS.trailingWindowBars} bars (${(PARAMS.trailingWindowBars / 24).toFixed(0)} days)`);
console.log(`  Entry: short > p${PARAMS.entryShortAbove * 100}, long < p${PARAMS.entryLongBelow * 100}`);
console.log(`  Exit:  neutral band p${PARAMS.exitBandLow * 100}–p${PARAMS.exitBandHigh * 100}, max-hold ${PARAMS.maxHoldBars}h, stop-loss ${PARAMS.stopLossPct}%`);
console.log(`  Commission:      ${(COMMISSION * 100).toFixed(3)}%/side`);
console.log(`  Candles:         ${candles.length}  with signal: ${cov?.filled ?? 0}`);
console.log("───────────────────────────────────────────────────────────────────");
console.log(`  Trade count:    ${result.tradeCount}`);
console.log(`  Win rate:       ${(result.winRate * 100).toFixed(1)}%`);
console.log(`  Net P&L:        $${result.totalPnl.toFixed(2)}  (${pctReturn.toFixed(2)}%)`);
console.log(`  Profit factor:  ${result.profitFactor.toFixed(2)}`);
console.log(`  Sharpe:         ${result.sharpeRatio.toFixed(2)}`);
console.log(`  Max drawdown:   ${result.maxDrawdownPct.toFixed(1)}%`);
console.log(`  Buy-hold ret:   ${result.buyHold.returnPct.toFixed(2)}%`);
console.log("───────────────────────────────────────────────────────────────────");

// ── Trade log (funding + point-in-time p10/p90 at entry) ─────────────────────
if (result.trades.length > 0) {
  console.log("\n  TRADE LOG  (funding and point-in-time percentile at each entry):");
  console.log(`  ${"#".padEnd(3)} ${"Side".padEnd(6)} ${"Entry time".padEnd(17)} ${"Funding".padEnd(12)} ${"pt-p".padEnd(10)} ${"vs thresh".padEnd(10)} ${"Entry $".padEnd(9)} ${"Exit $".padEnd(9)} ${"P&L".padEnd(10)} Reason`);

  // Build a bar-index lookup for fast access
  const candleByTs = new Map(candles.map((c, i) => [c.timestamp, i]));

  for (let i = 0; i < result.trades.length; i++) {
    const t        = result.trades[i];
    const barIdx   = candleByTs.get(t.entryTime) ?? -1;
    const entryCandle = barIdx >= 0 ? candles[barIdx] : undefined;
    const fundingVal  = entryCandle?.signals?.[SIGNAL_KEY] as number | undefined;

    let ptPercentile = NaN;
    let threshLabel  = "?";

    if (barIdx >= 0 && fundingVal !== undefined && isFinite(fundingVal)) {
      // Recompute the trailing window at this bar (mirrors strategy internals)
      const windowStart = Math.max(0, barIdx - PARAMS.trailingWindowBars + 1);
      const windowVals  = candles
        .slice(windowStart, barIdx + 1)
        .map(c => c.signals?.[SIGNAL_KEY] as number | undefined)
        .filter((v): v is number => v !== undefined && isFinite(v));
      const windowSorted = [...windowVals].sort((a, b) => a - b);

      if (t.side === "short") {
        ptPercentile = computePercentile(windowSorted, PARAMS.entryShortAbove);
        threshLabel  = `p${PARAMS.entryShortAbove * 100}`;
      } else if (t.side === "long") {
        ptPercentile = computePercentile(windowSorted, PARAMS.entryLongBelow);
        threshLabel  = `p${PARAMS.entryLongBelow * 100}`;
      }
    }

    const fundingStr = fundingVal !== undefined ? fundingVal.toExponential(3) : "n/a";
    const ptStr      = isFinite(ptPercentile) ? ptPercentile.toExponential(3) : "n/a";
    const vsStr      = isFinite(ptPercentile) && fundingVal !== undefined
      ? (t.side === "short" ? (fundingVal > ptPercentile ? "above ✓" : "BELOW ✗") : (fundingVal < ptPercentile ? "below ✓" : "ABOVE ✗"))
      : "n/a";
    const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);

    console.log(
      `  ${String(i + 1).padEnd(3)} ${t.side.padEnd(6)} ${new Date(t.entryTime).toISOString().slice(0,16).padEnd(17)} ` +
      `${fundingStr.padEnd(12)} ${(`${threshLabel}=${ptStr}`).padEnd(10)} ${vsStr.padEnd(10)} ` +
      `${t.entryPrice.toFixed(2).padEnd(9)} ${t.exitPrice.toFixed(2).padEnd(9)} ${pnlStr.padEnd(10)} ${t.reason}`,
    );
  }
}

// ── Alignment check ───────────────────────────────────────────────────────────
console.log("\n  ALIGNMENT CHECK — every entry must be on the correct side of its point-in-time percentile:");

const candleByTs = new Map(candles.map((c, i) => [c.timestamp, i]));

const shortEntries = result.trades.filter(t => t.side === "short");
const longEntries  = result.trades.filter(t => t.side === "long");

let shortFail = 0; let longFail = 0;

for (const t of shortEntries) {
  const barIdx  = candleByTs.get(t.entryTime) ?? -1;
  if (barIdx < 0) continue;
  const sig = candles[barIdx]?.signals?.[SIGNAL_KEY] as number | undefined;
  if (sig === undefined || !isFinite(sig)) continue;
  const windowStart = Math.max(0, barIdx - PARAMS.trailingWindowBars + 1);
  const windowVals  = candles.slice(windowStart, barIdx + 1)
    .map(c => c.signals?.[SIGNAL_KEY] as number | undefined)
    .filter((v): v is number => v !== undefined && isFinite(v));
  const p90 = computePercentile([...windowVals].sort((a, b) => a - b), PARAMS.entryShortAbove);
  if (sig <= p90) shortFail++;
}

for (const t of longEntries) {
  const barIdx  = candleByTs.get(t.entryTime) ?? -1;
  if (barIdx < 0) continue;
  const sig = candles[barIdx]?.signals?.[SIGNAL_KEY] as number | undefined;
  if (sig === undefined || !isFinite(sig)) continue;
  const windowStart = Math.max(0, barIdx - PARAMS.trailingWindowBars + 1);
  const windowVals  = candles.slice(windowStart, barIdx + 1)
    .map(c => c.signals?.[SIGNAL_KEY] as number | undefined)
    .filter((v): v is number => v !== undefined && isFinite(v));
  const p10 = computePercentile([...windowVals].sort((a, b) => a - b), PARAMS.entryLongBelow);
  if (sig >= p10) longFail++;
}

console.log(`  Short entries (${shortEntries.length}): funding above pt-p${PARAMS.entryShortAbove * 100}? ${shortFail === 0 ? `✓ ALL PASS` : `✗ ${shortFail} FAIL — ALIGNMENT BUG`}`);
console.log(`  Long  entries (${longEntries.length}): funding below pt-p${PARAMS.entryLongBelow * 100}? ${longFail === 0 ? `✓ ALL PASS` : `✗ ${longFail} FAIL — ALIGNMENT BUG`}`);

// ── Exit-reason distribution ──────────────────────────────────────────────────
console.log("\n  EXIT-REASON DISTRIBUTION:");
const reasonBuckets: Record<string, number> = {};
for (const t of result.trades) {
  const key = t.reason.includes("normalised") ? "normalised"
    : t.reason.includes("max-hold")           ? "max-hold"
    : t.reason.includes("stop")               ? "stop-loss"
    : t.reason.slice(0, 30);
  reasonBuckets[key] = (reasonBuckets[key] ?? 0) + 1;
}
for (const [reason, count] of Object.entries(reasonBuckets).sort((a, b) => b[1] - a[1])) {
  const pct = result.trades.length > 0 ? (count / result.trades.length * 100).toFixed(0) : "0";
  console.log(`  ${String(count).padStart(4)}  (${pct.padStart(3)}%)  ${reason}`);
}

// ── Equity curve (sampled) ────────────────────────────────────────────────────
console.log("\n  EQUITY CURVE (sampled every ~7 days):");
const eq   = result.equityCurve;
const step = Math.max(1, Math.floor(eq.length / 30));
console.log(`  ${"Date".padEnd(20)} ${"Equity".padEnd(12)} vs start`);
for (let i = 0; i < eq.length; i += step) {
  const pt   = eq[i];
  const diff = (pt.equity - EQUITY) / EQUITY * 100;
  console.log(`  ${new Date(pt.time).toISOString().slice(0,16).padEnd(20)} $${pt.equity.toFixed(2).padEnd(10)}  ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}%`);
}
const last = eq[eq.length - 1];
if (last) {
  const diff = (last.equity - EQUITY) / EQUITY * 100;
  console.log(`  ${new Date(last.time).toISOString().slice(0,16).padEnd(20)} $${last.equity.toFixed(2).padEnd(10)}  ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}% (final)`);
}

console.log("═══════════════════════════════════════════════════════════════════\n");
