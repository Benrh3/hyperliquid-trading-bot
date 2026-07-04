#!/usr/bin/env npx tsx
/**
 * Crowd-positioning backtest — run this on the server to get actual results.
 *
 *   cd ~/hyperliquid-trading-bot && npx tsx scripts/backtest-crowd-positioning.ts
 *
 * What it does:
 *   1. Reads lsr_agg_long_frac signal history from data/bot.db
 *   2. Computes p20, p50, p80 from the full available window
 *   3. Fetches HYPE 1h candles covering that same window from HL API
 *   4. Attaches signals to candles (correct close-time cutoff via attachSignals)
 *   5. Runs the CrowdPositioningStrategy with computed thresholds
 *   6. Reports: trade log, aggregate stats, equity curve summary
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { attachSignals, runBacktest } from "../src/backtest.js";
import { CrowdPositioningStrategy, SIGNAL_KEY } from "../src/strategy/crowd-positioning.js";

// ── Config ────────────────────────────────────────────────────────────────────
const DB_PATH    = resolve(process.cwd(), "data/bot.db");
const COIN       = "HYPE";
const INTERVAL   = "1h";
const COMMISSION = 0.0005;      // 0.05%/side — matches live + paper paths
const MAX_HOLD   = 48;          // bars (48 × 1h = 2 days)
const EQUITY     = 1000;
const SIZE_USD   = 500;         // half-Kelly for a demo run
const STOP_LOSS  = 5;           // 5% stop (wide enough not to thrash, tight enough for risk mgmt)

// ── 1. Load signal history from DB ───────────────────────────────────────────
console.log(`\n[1/5] Loading signal history from ${DB_PATH}...`);
const db = new Database(DB_PATH, { readonly: true });

// Union raw snapshots + hourly rollup so the full history is available.
// Simple UNION ALL with ORDER BY at the top level — the column-list alias
// syntax `AS derived(col1, col2)` is not supported by the SQLite version
// bundled with better-sqlite3 (confirmed: `near "(": syntax error`).
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
  console.error(`\nERROR: No rows found for ${SIGNAL_KEY}. Has the snapshot-poller been running?`);
  process.exit(1);
}

const values = signalRows.filter(r => r.value !== null).map(r => r.value as number);
console.log(`  Signal rows: ${signalRows.length} (${values.length} non-null)`);
console.log(`  Date range:  ${new Date(signalRows[0].ts).toISOString()} → ${new Date(signalRows[signalRows.length - 1].ts).toISOString()}`);
console.log(`  Value range: ${Math.min(...values).toFixed(4)} – ${Math.max(...values).toFixed(4)}`);

// ── 2. Compute percentile thresholds ─────────────────────────────────────────
console.log("\n[2/5] Computing percentile thresholds...");
const sorted = [...values].sort((a, b) => a - b);
function pct(p: number): number {
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
  return sorted[idx];
}

const p10 = pct(0.10); const p20 = pct(0.20); const p30 = pct(0.30);
const p50 = pct(0.50);
const p70 = pct(0.70); const p80 = pct(0.80); const p90 = pct(0.90);

console.log(`  p10=${p10.toFixed(4)}  p20=${p20.toFixed(4)}  p30=${p30.toFixed(4)}`);
console.log(`  p50=${p50.toFixed(4)}`);
console.log(`  p70=${p70.toFixed(4)}  p80=${p80.toFixed(4)}  p90=${p90.toFixed(4)}`);
console.log(`  Using: entry long < p20 (${p20.toFixed(4)}), entry short > p80 (${p80.toFixed(4)}), exit at neutral p50 (${p50.toFixed(4)})`);

// ── 3. Fetch HYPE candles for the signal window ───────────────────────────────
console.log("\n[3/5] Fetching HYPE 1h candles from HL API...");
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
console.log("\n[4/5] Attaching signals to candles...");
const signalMap = new Map([[
  SIGNAL_KEY,
  signalRows.map(r => ({ capturedAt: r.ts, value: r.value })),
]]);
const coverage = attachSignals(candles, signalMap);
const cov = coverage[0];
console.log(`  Coverage: ${cov?.filled ?? 0} / ${cov?.total ?? 0} candles have signal (${cov ? ((cov.filled / cov.total) * 100).toFixed(1) : 0}%)`);

const canalesWithSignal = candles.filter(c => c.signals?.[SIGNAL_KEY] !== null && c.signals?.[SIGNAL_KEY] !== undefined);
if (canalesWithSignal.length < 10) {
  console.error("ERROR: Fewer than 10 candles with signal data. Cannot run meaningful backtest.");
  process.exit(1);
}

// ── 5. Run backtest ───────────────────────────────────────────────────────────
console.log("\n[5/5] Running backtest...\n");

const strategy = new CrowdPositioningStrategy({
  entryLongBelow:  p20,
  entryShortAbove: p80,
  exitNeutral:     p50,
  maxHoldBars:     MAX_HOLD,
});

const result = runBacktest(strategy, candles, {
  initialEquity:   EQUITY,
  positionSizeUsd: SIZE_USD,
  stopLossPct:     STOP_LOSS,
  commissionPct:   COMMISSION,
});

// ── Report ────────────────────────────────────────────────────────────────────
const pctReturn = EQUITY > 0 ? (result.totalPnl / EQUITY * 100) : 0;

console.log("═══════════════════════════════════════════════════════════");
console.log(" CROWD POSITIONING BACKTEST — HYPE lsr_agg_long_frac");
console.log("═══════════════════════════════════════════════════════════");
console.log(`  Signal window:  ${new Date(startTime).toISOString().slice(0,16)} → ${new Date(endTime).toISOString().slice(0,16)}`);
console.log(`  Thresholds:     long<${p20.toFixed(3)}  short>${p80.toFixed(3)}  neutral=${p50.toFixed(3)}`);
console.log(`  Max hold:       ${MAX_HOLD}h`);
console.log(`  Commission:     ${(COMMISSION * 100).toFixed(3)}%/side`);
console.log(`  Candles:        ${candles.length}  with signal: ${cov?.filled ?? 0}`);
console.log("───────────────────────────────────────────────────────────");
console.log(`  Trade count:    ${result.tradeCount}`);
console.log(`  Win rate:       ${(result.winRate * 100).toFixed(1)}%`);
console.log(`  Net P&L:        $${result.totalPnl.toFixed(2)}  (${pctReturn.toFixed(2)}%)`);
console.log(`  Profit factor:  ${result.profitFactor.toFixed(2)}`);
console.log(`  Sharpe:         ${result.sharpeRatio.toFixed(2)}`);
console.log(`  Max drawdown:   ${result.maxDrawdownPct.toFixed(1)}%`);
console.log(`  Buy-hold ret:   ${result.buyHold.returnPct.toFixed(2)}%`);
console.log("───────────────────────────────────────────────────────────");

// Trade log (showing signal values at entry so we can verify alignment)
if (result.trades.length > 0) {
  console.log("\n  TRADE LOG (signal value at entry candle):");
  console.log(`  ${"#".padEnd(3)} ${"Side".padEnd(6)} ${"Entry time".padEnd(20)} ${"Sig".padEnd(8)} ${"Entry $".padEnd(10)} ${"Exit $".padEnd(10)} ${"P&L".padEnd(10)} Reason`);
  for (let i = 0; i < Math.min(result.trades.length, 30); i++) {
    const t = result.trades[i];
    // Find the candle at entry time to get its signal value
    const ec = candles.find(c => c.timestamp === t.entryTime);
    const sv = ec?.signals?.[SIGNAL_KEY];
    const svStr = sv !== null && sv !== undefined ? (sv as number).toFixed(4) : "n/a";
    const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);
    console.log(`  ${String(i+1).padEnd(3)} ${t.side.padEnd(6)} ${new Date(t.entryTime).toISOString().slice(0,16).padEnd(20)} ${svStr.padEnd(8)} ${t.entryPrice.toFixed(2).padEnd(10)} ${t.exitPrice.toFixed(2).padEnd(10)} ${pnlStr.padEnd(10)} ${t.reason}`);
  }
  if (result.trades.length > 30) console.log(`  ... and ${result.trades.length - 30} more trades`);
}

// Equity curve (sampled)
console.log("\n  EQUITY CURVE (sampled every 24 bars):");
const eq = result.equityCurve;
const step = Math.max(1, Math.floor(eq.length / 24));
console.log(`  ${"Date".padEnd(20)} ${"Equity".padEnd(12)} vs start`);
for (let i = 0; i < eq.length; i += step) {
  const pt = eq[i];
  const diff = ((pt.equity - EQUITY) / EQUITY * 100);
  console.log(`  ${new Date(pt.time).toISOString().slice(0,16).padEnd(20)} $${pt.equity.toFixed(2).padEnd(10)}  ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}%`);
}
const last = eq[eq.length - 1];
if (last) {
  const diff = ((last.equity - EQUITY) / EQUITY * 100);
  console.log(`  ${new Date(last.time).toISOString().slice(0,16).padEnd(20)} $${last.equity.toFixed(2).padEnd(10)}  ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}% (final)`);
}
console.log("═══════════════════════════════════════════════════════════\n");

// Entry alignment check
const longEntries  = result.trades.filter(t => t.side === "long");
const shortEntries = result.trades.filter(t => t.side === "short");

if (longEntries.length > 0 || shortEntries.length > 0) {
  console.log("  ALIGNMENT CHECK — signal value at each entry:");
  if (longEntries.length > 0) {
    const longSigs = longEntries.map(t => {
      const c = candles.find(x => x.timestamp === t.entryTime);
      return c?.signals?.[SIGNAL_KEY] as number | null;
    }).filter(v => v !== null) as number[];
    const maxLong = Math.max(...longSigs);
    console.log(`  Long entries (${longEntries.length}): signal max=${maxLong.toFixed(4)}, all < p20 (${p20.toFixed(4)})? ${maxLong < p20 ? "✓ YES" : "✗ NO — ALIGNMENT BUG"}`);
  }
  if (shortEntries.length > 0) {
    const shortSigs = shortEntries.map(t => {
      const c = candles.find(x => x.timestamp === t.entryTime);
      return c?.signals?.[SIGNAL_KEY] as number | null;
    }).filter(v => v !== null) as number[];
    const minShort = Math.min(...shortSigs);
    console.log(`  Short entries (${shortEntries.length}): signal min=${minShort.toFixed(4)}, all > p80 (${p80.toFixed(4)})? ${minShort > p80 ? "✓ YES" : "✗ NO — ALIGNMENT BUG"}`);
  }
}
console.log();
