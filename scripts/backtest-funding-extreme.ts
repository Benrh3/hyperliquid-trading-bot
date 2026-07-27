#!/usr/bin/env npx tsx
/**
 * Funding-Extreme backtest — run this on the server to get actual results.
 *
 *   cd ~/hyperliquid-trading-bot && npx tsx scripts/backtest-funding-extreme.ts
 *
 * What it does:
 *   1. Reads funding_rate signal history from data/bot.db
 *   2. Prints a funding distribution histogram (mass-point check, entry threshold sanity)
 *   3. Fetches HYPE 1h candles covering the full signal window (paginated)
 *   4. Attaches signals to candles (correct close-time cutoff via attachSignals)
 *   5. Runs FundingExtremeStrategy with default params
 *   6. Reports: full trade log, alignment check, exit-reason distribution, aggregate stats, equity curve
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { attachSignals, runBacktest } from "../src/backtest.js";
import { FundingExtremeStrategy, SIGNAL_KEY } from "../src/strategy/funding-extreme.js";

// ── Config ────────────────────────────────────────────────────────────────────
const DB_PATH    = resolve(process.cwd(), "data/bot.db");
const COIN       = "HYPE";
const INTERVAL   = "1h";
const INTERVAL_MS = 3_600_000;
const MAX_PAGE   = 500;          // HL candleSnapshot API page limit
const COMMISSION = 0.0005;       // 0.05%/side — matches live + paper paths
const EQUITY     = 1000;
const SIZE_USD   = 500;

const PARAMS = {
  defaultRate:        1.25e-5,
  entryShortMultiple: 3,
  entryLongMultiple:  1,             // long when funding ≤ −1× default = −1.25e-5
  exitBand:           0.5 * 1.25e-5, // 6.25e-6
  maxHoldBars:        72,
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

// ── 2. Funding distribution histogram ────────────────────────────────────────
console.log("\n[2/6] Funding distribution histogram...");

const D  = PARAMS.defaultRate;
const n  = values.length;
const atDefault     = values.filter(v => Math.abs(v - D) < 1e-12).length;
const ge2x          = values.filter(v => v >= 2 * D).length;
const ge3x          = values.filter(v => v >= 3 * D).length;
const ge5x          = values.filter(v => v >= 5 * D).length;
const negative      = values.filter(v => v < 0).length;
const sortedAll     = [...values].sort((a, b) => a - b);
const median        = sortedAll[Math.floor(sortedAll.length / 2)];

// Computed thresholds — also used later in the trade log and alignment check
const shortThreshold = D * PARAMS.entryShortMultiple;
const longThreshold  = -(D * PARAMS.entryLongMultiple);
const atOrBelowLong  = values.filter(v => v <= longThreshold).length;

console.log(`  Total non-null values:  ${n}`);
console.log(`  Exactly at default (${D.toExponential(3)}):            ${atDefault.toString().padStart(5)}  (${(atDefault / n * 100).toFixed(1)}%)`);
console.log(`  ≥ 2× default   (${(2 * D).toExponential(3)}):        ${ge2x.toString().padStart(5)}  (${(ge2x / n * 100).toFixed(1)}%)`);
console.log(`  ≥ ${PARAMS.entryShortMultiple}× default   (${shortThreshold.toExponential(3)})  ← SHORT entry: ${ge3x.toString().padStart(5)}  (${(ge3x / n * 100).toFixed(1)}%)`);
console.log(`  ≥ 5× default   (${(5 * D).toExponential(3)}):        ${ge5x.toString().padStart(5)}  (${(ge5x / n * 100).toFixed(1)}%)`);
console.log(`  Negative (< 0):                           ${negative.toString().padStart(5)}  (${(negative / n * 100).toFixed(1)}%)`);
console.log(`  ≤ −${PARAMS.entryLongMultiple}× default  (${longThreshold.toExponential(3)})  ← LONG  entry: ${atOrBelowLong.toString().padStart(5)}  (${(atOrBelowLong / n * 100).toFixed(1)}%)`);
console.log(`  Min: ${Math.min(...values).toExponential(3)}   Max: ${Math.max(...values).toExponential(3)}   Median: ${median.toExponential(3)}`);

// ── 3. Fetch HYPE candles (probe retention boundary, then paginate) ───────────
console.log("\n[3/6] Fetching HYPE 1h candles from HL API...");

const signalStart = signalRows[0].ts;
const signalEnd   = signalRows[signalRows.length - 1].ts;

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
type RawCandle = Awaited<ReturnType<typeof info.candleSnapshot>>[number];

// Probe: request a wide window from signalStart → now. HL returns up to MAX_PAGE
// candles starting from its retention boundary, regardless of how far back
// signalStart is. The first returned timestamp is the earliest simulatable bar.
process.stdout.write("  Probing earliest available candle… ");
const probeRaw = await info.candleSnapshot({
  coin: COIN, interval: INTERVAL as "1h",
  startTime: signalStart,
  endTime:   Date.now(),
});
if (probeRaw.length === 0) {
  console.error("\nERROR: No candles returned from probe — API may be unreachable.");
  process.exit(1);
}
const earliestCandleTs = probeRaw[0].t;
const backtestStart    = Math.max(signalStart, earliestCandleTs);
const backtestEnd      = Date.now();

const signalMonths  = (signalEnd - signalStart)   / (30 * 24 * 3_600_000);
const overlapMonths = (backtestEnd - backtestStart) / (30 * 24 * 3_600_000);

console.log(`earliest candle: ${new Date(earliestCandleTs).toISOString().slice(0, 10)}`);
console.log(`  Signal history:   ${new Date(signalStart).toISOString().slice(0, 10)} → ${new Date(signalEnd).toISOString().slice(0, 10)}  (${signalMonths.toFixed(1)} mo — full range used for histogram)`);
console.log(`  Candle retention: ${new Date(earliestCandleTs).toISOString().slice(0, 10)} → now`);
console.log(`  Backtest window:  ${new Date(backtestStart).toISOString().slice(0, 10)} → ${new Date(backtestEnd).toISOString().slice(0, 10)}  (${overlapMonths.toFixed(1)} months of overlap)`);
if (earliestCandleTs > signalStart) {
  const gapMonths = (earliestCandleTs - signalStart) / (30 * 24 * 3_600_000);
  console.log(`  NOTE: ${gapMonths.toFixed(1)} months of signal history pre-date candle retention and cannot be backtested`);
}

// Paginate from backtestStart, seeding with the probe page (already fetched).
const allRaw: RawCandle[] = [...probeRaw];
let pageStart = probeRaw[probeRaw.length - 1].t + INTERVAL_MS;
let pages = 1;

while (pageStart < backtestEnd) {
  const pageEnd = Math.min(pageStart + MAX_PAGE * INTERVAL_MS, backtestEnd);
  const raw = await info.candleSnapshot({ coin: COIN, interval: INTERVAL as "1h", startTime: pageStart, endTime: pageEnd });
  if (raw.length === 0) break;
  for (const c of raw) allRaw.push(c);
  pages++;
  const lastTs = raw[raw.length - 1].t;
  if (lastTs >= backtestEnd - INTERVAL_MS) break;
  pageStart = lastTs + INTERVAL_MS;
}

// Deduplicate at probe/page boundary
const seen = new Set<number>();
const deduped = allRaw.filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; });
console.log(`  Fetched ${deduped.length} candles in ${pages} page(s)`);

const candles = deduped.map(c => ({
  timestamp: c.t,
  open:      parseFloat(c.o as unknown as string),
  high:      parseFloat(c.h as unknown as string),
  low:       parseFloat(c.l as unknown as string),
  close:     parseFloat(c.c as unknown as string),
  volume:    parseFloat(c.v as unknown as string),
}));

if (candles.length === 0) { console.error("ERROR: No candles after deduplication."); process.exit(1); }

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
if (candlesWithSignal.length === 0) {
  console.error("ERROR: No candles have signal attached. Check signal attachment step.");
  process.exit(1);
}
if (candlesWithSignal.length < 100) {
  console.warn(`  WARNING: Only ${candlesWithSignal.length} candles have signal — limited backtest data.`);
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
const pctPriceReturn   = EQUITY > 0 ? (result.totalPricePnl   / EQUITY * 100) : 0;
const pctFundingReturn = EQUITY > 0 ? (result.totalFundingPnl / EQUITY * 100) : 0;
const pctReturn        = EQUITY > 0 ? (result.totalPnl        / EQUITY * 100) : 0;

console.log("═══════════════════════════════════════════════════════════════════");
console.log(" FUNDING EXTREME BACKTEST — HYPE funding_rate");
console.log("═══════════════════════════════════════════════════════════════════");
console.log(`  Signal history:  ${new Date(signalStart).toISOString().slice(0,10)} → ${new Date(signalEnd).toISOString().slice(0,10)}  (${signalMonths.toFixed(1)} mo, histogram)`);
console.log(`  Backtest window: ${new Date(backtestStart).toISOString().slice(0,10)} → ${new Date(backtestEnd).toISOString().slice(0,10)}  (${overlapMonths.toFixed(1)} months)`);
console.log(`  Entry short: funding ≥ ${PARAMS.entryShortMultiple}× default = ${shortThreshold.toExponential(3)}`);
console.log(`  Entry long:  funding ≤ −${PARAMS.entryLongMultiple}× default = ${longThreshold.toExponential(3)}`);
console.log(`  Exit:        |funding − default| < ${PARAMS.exitBand.toExponential(2)}, max-hold ${PARAMS.maxHoldBars}h, stop ${PARAMS.stopLossPct}%`);
console.log(`  Commission:      ${(COMMISSION * 100).toFixed(3)}%/side`);
console.log(`  Candles:         ${candles.length}  with signal: ${cov?.filled ?? 0}`);
console.log("───────────────────────────────────────────────────────────────────");
console.log(`  Trade count:    ${result.tradeCount}`);
console.log(`  Win rate:       ${(result.winRate * 100).toFixed(1)}%`);
console.log(`  Price P&L:      $${result.totalPricePnl.toFixed(2)}  (${pctPriceReturn.toFixed(2)}%)`);
console.log(`  Funding P&L:    $${result.totalFundingPnl.toFixed(4)}  (${pctFundingReturn.toFixed(3)}%)`);
console.log(`  Total P&L:      $${result.totalPnl.toFixed(2)}  (${pctReturn.toFixed(2)}%)`);
console.log(`  ─── price-only: $${result.totalPricePnl.toFixed(2)}  total: $${result.totalPnl.toFixed(2)}`);
console.log(`  Profit factor:  ${result.profitFactor.toFixed(2)}`);
console.log(`  Sharpe:         ${result.sharpeRatio.toFixed(2)}`);
console.log(`  Max drawdown:   ${result.maxDrawdownPct.toFixed(1)}%`);
console.log(`  Buy-hold ret:   ${result.buyHold.returnPct.toFixed(2)}%`);
console.log("───────────────────────────────────────────────────────────────────");

// ── Trade log ─────────────────────────────────────────────────────────────────
if (result.trades.length > 0) {
  console.log("\n  TRADE LOG  (funding vs threshold at each entry):");
  console.log(`  ${"#".padEnd(3)} ${"Side".padEnd(6)} ${"Entry time".padEnd(17)} ${"Funding".padEnd(12)} ${"Threshold".padEnd(12)} ${"Meets?".padEnd(8)} ${"Entry $".padEnd(9)} ${"Exit $".padEnd(9)} ${"P&L".padEnd(10)} ${"Fund P&L".padEnd(10)} Reason`);

  const candleByTs = new Map(candles.map((c, i) => [c.timestamp, i]));

  for (let i = 0; i < result.trades.length; i++) {
    const t        = result.trades[i];
    const barIdx   = candleByTs.get(t.entryTime) ?? -1;
    const fundingVal = barIdx >= 0
      ? candles[barIdx]?.signals?.[SIGNAL_KEY] as number | undefined
      : undefined;

    let thresholdStr = "?";
    let meetsStr     = "?";
    if (fundingVal !== undefined && isFinite(fundingVal)) {
      if (t.side === "short") {
        thresholdStr = shortThreshold.toExponential(3);
        meetsStr = fundingVal >= shortThreshold ? "above ✓" : "BELOW ✗";
      } else if (t.side === "long") {
        thresholdStr = longThreshold.toExponential(3);
        meetsStr = fundingVal <= longThreshold ? "below ✓" : "ABOVE ✗";
      }
    }

    const fundingStr  = fundingVal !== undefined ? fundingVal.toExponential(3) : "n/a";
    const pnlStr      = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);
    const fundPnlStr  = (t.fundingPnl >= 0 ? "+" : "") + t.fundingPnl.toFixed(4);

    console.log(
      `  ${String(i + 1).padEnd(3)} ${t.side.padEnd(6)} ${new Date(t.entryTime).toISOString().slice(0,16).padEnd(17)} ` +
      `${fundingStr.padEnd(12)} ${thresholdStr.padEnd(12)} ${meetsStr.padEnd(8)} ` +
      `${t.entryPrice.toFixed(2).padEnd(9)} ${t.exitPrice.toFixed(2).padEnd(9)} ${pnlStr.padEnd(10)} ${fundPnlStr.padEnd(10)} ${t.reason}`,
    );
  }
}

// ── Alignment check ───────────────────────────────────────────────────────────
console.log("\n  ALIGNMENT CHECK — every entry must be on the correct side of its absolute threshold:");

const candleByTs = new Map(candles.map((c, i) => [c.timestamp, i]));

const shortEntries = result.trades.filter(t => t.side === "short");
const longEntries  = result.trades.filter(t => t.side === "long");

let shortFail = 0; let longFail = 0;

for (const t of shortEntries) {
  const barIdx = candleByTs.get(t.entryTime) ?? -1;
  const sig    = barIdx >= 0 ? candles[barIdx]?.signals?.[SIGNAL_KEY] as number | undefined : undefined;
  if (sig === undefined || !isFinite(sig)) continue;
  if (sig < shortThreshold) shortFail++;
}

for (const t of longEntries) {
  const barIdx = candleByTs.get(t.entryTime) ?? -1;
  const sig    = barIdx >= 0 ? candles[barIdx]?.signals?.[SIGNAL_KEY] as number | undefined : undefined;
  if (sig === undefined || !isFinite(sig)) continue;
  if (sig > longThreshold) longFail++;
}

console.log(`  Short entries (${shortEntries.length}): funding ≥ ${shortThreshold.toExponential(3)}? ${shortFail === 0 ? "✓ ALL PASS" : `✗ ${shortFail} FAIL — ALIGNMENT BUG`}`);
console.log(`  Long  entries (${longEntries.length}): funding ≤ ${longThreshold.toExponential(3)}? ${longFail === 0 ? "✓ ALL PASS" : `✗ ${longFail} FAIL — ALIGNMENT BUG`}`);

// ── Exit-reason distribution ──────────────────────────────────────────────────
console.log("\n  EXIT-REASON DISTRIBUTION:");
const reasonBuckets: Record<string, number> = {};
for (const t of result.trades) {
  const key = t.reason.includes("normalised") ? "normalised"
    : t.reason.includes("max-hold")           ? "max-hold"
    : t.reason.includes("Stop-loss")          ? "stop-loss"
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
