// scripts/wf-audit.ts
// Tasks 2–5: HYPE 1h candle backfill + gap audit, then FundingExtreme
// walk-forward with and without the rollup-lookahead fix.
//
// Usage:  npx tsx scripts/wf-audit.ts [--no-signals]
//   --no-signals  skip DB signal loading (use if running without production DB)
//
// Outputs: gap audit, full 9-combo IS sweep per window, stitched OOS metrics,
//          short/long split, P&L concentration, and fix vs no-fix comparison.

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import Database from "better-sqlite3";
import { resolve } from "path";
import { FundingExtremeStrategy } from "../src/strategy/funding-extreme.js";
import { runBacktest, attachSignals, type SignalTimeSeries } from "../src/backtest.js";
import type { BacktestTrade } from "../src/backtest.js";
import type { Candle } from "../src/events.js";

const HOUR_MS        = 3_600_000;
const DB_PATH        = process.env["DB_PATH"] ?? resolve(process.cwd(), "data/bot.db");
const NO_SIGNALS     = process.argv.includes("--no-signals");
const N_WINDOWS      = 5;
const WARMUP_BARS    = 250;
const INITIAL_EQUITY = 1000;
const POS_SIZE_USD   = 500;
const COMMISSION_PCT = 0.0005;
const STOP_LOSS_PCT  = 6;
const CAP            = 5000;

// FundingExtreme param grid: gridValues from registry
const K_VALS  = [3, 5, 8];
const KL_VALS = [1, 2, 3];
const GRID: { k: number; kl: number }[] = [];
for (const k of K_VALS) for (const kl of KL_VALS) GRID.push({ k, kl });

// ─── Helpers ────────────────────────────────────────────────────────────────

function oosSharpe(trades: BacktestTrade[]): number {
  if (trades.length < 2) return 0;
  const r = trades.map(t => t.pnl / (t.entryPrice * t.size));
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const std  = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / r.length);
  return std > 1e-10 ? (mean / std) * Math.sqrt(r.length) : 0;
}

function maxDD(trades: BacktestTrade[]): number {
  let eq = INITIAL_EQUITY, peak = INITIAL_EQUITY, dd = 0;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const cur = peak > 0 ? (peak - eq) / peak * 100 : 0;
    if (cur > dd) dd = cur;
  }
  return dd;
}

function summarise(trades: BacktestTrade[], label: string) {
  const pnl    = trades.reduce((s, t) => s + t.pnl, 0);
  const shorts = trades.filter(t => t.side === "short");
  const longs  = trades.filter(t => t.side === "long");

  console.log(`\n══ ${label} ══`);
  console.log(`  Total trades:  ${trades.length}`);
  console.log(`  Total P&L:     $${pnl.toFixed(2)}`);
  console.log(`  Sharpe:        ${oosSharpe(trades).toFixed(3)}`);
  console.log(`  MaxDD:         ${maxDD(trades).toFixed(2)}%`);

  console.log(`  Short trades:  ${shorts.length}  P&L=$${shorts.reduce((s,t)=>s+t.pnl,0).toFixed(2)}  ` +
    `WR=${shorts.length ? (shorts.filter(t=>t.pnl>0).length/shorts.length*100).toFixed(0) : "—"}%`);
  console.log(`  Long trades:   ${longs.length}  P&L=$${longs.reduce((s,t)=>s+t.pnl,0).toFixed(2)}  ` +
    `WR=${longs.length ? (longs.filter(t=>t.pnl>0).length/longs.length*100).toFixed(0) : "—"}%`);

  // Concentration: sort by descending P&L, report cumulative share
  if (trades.length === 0) return;
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  for (const pct of [1, 5, 10]) {
    const n   = Math.max(1, Math.ceil(trades.length * pct / 100));
    const top = sorted.slice(0, n).reduce((s, t) => s + t.pnl, 0);
    console.log(`  Top ${String(pct).padStart(2)}% trades (n=${n}):  ` +
      `P&L=$${top.toFixed(2)}  share=${pnl !== 0 ? (top/pnl*100).toFixed(1) : "—"}% of total`);
  }

  // Per-hour concentration: expand each trade into hold hours, rank by pnl/hr
  const hourPnls: number[] = [];
  for (const t of trades) {
    const hrs = Math.max(1, Math.round((t.exitTime - t.entryTime) / HOUR_MS));
    const perHr = t.pnl / hrs;
    for (let h = 0; h < hrs; h++) hourPnls.push(perHr);
  }
  hourPnls.sort((a, b) => b - a);
  for (const pct of [1, 5, 10]) {
    const n   = Math.max(1, Math.ceil(hourPnls.length * pct / 100));
    const top = hourPnls.slice(0, n).reduce((s, x) => s + x, 0);
    const totalHrPnl = hourPnls.reduce((s, x) => s + x, 0);
    console.log(`  Top ${String(pct).padStart(2)}% hold-hours (n=${n}/${hourPnls.length}): ` +
      `P&L=$${top.toFixed(2)}  share=${totalHrPnl !== 0 ? (top/totalHrPnl*100).toFixed(1) : "—"}% of total`);
  }
}

// ─── WF engine ───────────────────────────────────────────────────────────────

function makeStrat(k: number, kl: number) {
  return new FundingExtremeStrategy({
    defaultRate:        1.25e-5,
    entryShortMultiple: k,
    entryLongMultiple:  kl,
    exitBand:           0.00000625,
    maxHoldBars:        72,
    stopLossPct:        STOP_LOSS_PCT,
  });
}

interface WFWindowResult {
  window:         number;
  isK:            number;
  isKl:           number;
  isSharpe:       number;
  oosTradeCount:  number;
  oosPnl:         number;
  oosSharpeVal:   number;
  oosMaxDD:       number;
  isSweep:        { k: number; kl: number; sharpe: number; trades: number; pnl: number }[];
  oosTrades:      BacktestTrade[];
}

function runWF(candles: Candle[], label: string): { windows: WFWindowResult[]; allOos: BacktestTrade[] } {
  const segSize = Math.floor(candles.length / N_WINDOWS);
  const windows: WFWindowResult[] = [];

  console.log(`\n── ${label}: WF (${N_WINDOWS} windows, segSize=${segSize}) ──`);

  for (let i = 1; i < N_WINDOWS; i++) {
    const isSamples = candles.slice(0, i * segSize);
    const oosStart  = i * segSize;
    const oosEnd    = Math.min((i + 1) * segSize, candles.length);
    const rawOos    = candles.slice(oosStart, oosEnd);
    if (rawOos.length === 0) break;

    const warmupStart = Math.max(0, oosStart - WARMUP_BARS);
    const oosSamples  = [...candles.slice(warmupStart, oosStart), ...rawOos];

    // IS grid search
    let bestK = 3, bestKl = 1, bestMetric = -Infinity;
    let bestISResult: ReturnType<typeof runBacktest> | null = null;
    const sweep: WFWindowResult["isSweep"] = [];

    for (const { k, kl } of GRID) {
      const r = runBacktest(makeStrat(k, kl), isSamples, {
        initialEquity: INITIAL_EQUITY,
        positionSizeUsd: POS_SIZE_USD,
        commissionPct: COMMISSION_PCT,
        stopLossPct: STOP_LOSS_PCT,
      });
      const metric = r.sharpeRatio ?? 0;
      sweep.push({ k, kl, sharpe: metric, trades: r.tradeCount, pnl: r.totalPnl });
      if (metric > bestMetric) { bestMetric = metric; bestK = k; bestKl = kl; bestISResult = r; }
    }

    // OOS with best params
    const fullOos = runBacktest(makeStrat(bestK, bestKl), oosSamples, {
      initialEquity: INITIAL_EQUITY,
      positionSizeUsd: POS_SIZE_USD,
      commissionPct: COMMISSION_PCT,
      stopLossPct: STOP_LOSS_PCT,
    });
    const oosTrades = fullOos.trades.filter(t => t.entryTime >= rawOos[0]!.timestamp);
    const oosPnl    = oosTrades.reduce((s, t) => s + t.pnl, 0);

    windows.push({
      window: i,
      isK: bestK, isKl: bestKl, isSharpe: bestMetric,
      oosTradeCount: oosTrades.length, oosPnl,
      oosSharpeVal: oosSharpe(oosTrades), oosMaxDD: maxDD(oosTrades),
      isSweep: sweep, oosTrades,
    });

    const isSweepStr = sweep.map(s =>
      `k=${s.k}/kl=${s.kl}:sh=${s.sharpe.toFixed(2)}`
    ).join("  ");
    console.log(`  Win ${i}: IS selects k=${bestK}/kl=${bestKl} (sh=${bestMetric.toFixed(2)}) | ` +
      `OOS ${oosTrades.length}tr $${oosPnl.toFixed(2)} sh=${oosSharpe(oosTrades).toFixed(2)} dd=${maxDD(oosTrades).toFixed(1)}%`);
    console.log(`    IS sweep: ${isSweepStr}`);
  }

  const allOos = windows.flatMap(w => w.oosTrades);
  return { windows, allOos };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

// ── Task 2: Fetch HYPE 1h candles ─────────────────────────────────────────────
console.log("═══ Task 2: HYPE 1h candle backfill + gap audit ═══\n");

console.log("Fetching HYPE 1h candles (startTime=0, endTime=now)...");
const rawCandles = await info.candleSnapshot({
  coin: "HYPE", interval: "1h" as any, startTime: 0, endTime: Date.now(),
}) as any[];

rawCandles.sort((a: any, b: any) => (a.t as number) - (b.t as number));

const candles: Candle[] = rawCandles.map((c: any) => ({
  timestamp: c.t as number,
  open:   +c.o, high:  +c.h, low:   +c.l,
  close:  +c.c, volume: +c.v,
}));

const earliest = candles[0]!.timestamp;
const latest   = candles[candles.length - 1]!.timestamp;
const expected = Math.round((latest - earliest) / HOUR_MS) + 1;
const gaps: { from: string; to: string; hours: number }[] = [];
for (let i = 1; i < candles.length; i++) {
  const delta = candles[i]!.timestamp - candles[i - 1]!.timestamp;
  if (delta > HOUR_MS) {
    gaps.push({
      from:  new Date(candles[i - 1]!.timestamp).toISOString(),
      to:    new Date(candles[i]!.timestamp).toISOString(),
      hours: Math.round(delta / HOUR_MS) - 1,
    });
  }
}

console.log(`  Candles fetched:    ${candles.length}`);
console.log(`  Earliest:           ${new Date(earliest).toISOString()}`);
console.log(`  Latest:             ${new Date(latest).toISOString()}`);
console.log(`  Expected (no gaps): ${expected}`);
console.log(`  Gap hours:          ${expected - candles.length}`);
console.log(`  Gap events:         ${gaps.length}`);
console.log(`  Response = CAP(${CAP}): ${candles.length === CAP} (final batch truncated?)`);
if (gaps.length > 0) {
  for (const g of gaps) console.log(`    Gap: ${g.from} → ${g.to} (${g.hours}h)`);
}

// ── Load signals from DB ──────────────────────────────────────────────────────
let sigSeriesFixed:   SignalTimeSeries[] = [];
let sigSeriesNoFix:   SignalTimeSeries[] = [];

if (!NO_SIGNALS) {
  console.log(`\nLoading signals from ${DB_PATH}...`);
  const db = new Database(DB_PATH, { readonly: true });

  // WITH fix: getMetricTimeSeries uses ts_hour + HOUR_MS for hourly rows
  const rawRows = db.prepare(`
    SELECT sm.captured_at AS capturedAt, sm.value
    FROM snapshot_metrics sm JOIN snapshots s ON s.id = sm.snapshot_id
    WHERE s.symbol = 'HYPE' AND sm.metric_key = 'funding_rate'
    ORDER BY sm.captured_at ASC
  `).all() as SignalTimeSeries[];

  const spliceTs = (rawRows[0] as any)?.capturedAt ?? 9_999_999_999_999;

  const hourlyFixed = db.prepare(`
    SELECT ts_hour + ${HOUR_MS} AS capturedAt, avg_value AS value
    FROM snapshot_metrics_hourly
    WHERE symbol = 'HYPE' AND metric_key = 'funding_rate'
      AND ts_hour + ${HOUR_MS} <= ?
    ORDER BY ts_hour ASC
  `).all(spliceTs) as SignalTimeSeries[];

  const hourlyNoFix = db.prepare(`
    SELECT ts_hour AS capturedAt, avg_value AS value
    FROM snapshot_metrics_hourly
    WHERE symbol = 'HYPE' AND metric_key = 'funding_rate'
      AND ts_hour < ?
    ORDER BY ts_hour ASC
  `).all(spliceTs) as SignalTimeSeries[];

  sigSeriesFixed  = [...hourlyFixed,  ...rawRows];
  sigSeriesNoFix  = [...hourlyNoFix,  ...rawRows];

  console.log(`  Hourly rows:        ${hourlyFixed.length}  (earliest=${hourlyFixed.length > 0 ? new Date(hourlyFixed[0]!.capturedAt).toISOString() : "—"})`);
  console.log(`  Raw rows:           ${rawRows.length}      (splice at ${new Date(spliceTs).toISOString()})`);
  console.log(`  Total fixed series: ${sigSeriesFixed.length}`);
  db.close();
} else {
  console.log("\n--no-signals: skipping DB load. All candles will have null signals.");
}

// ── Attach signals to candle array (two separate copies for fix vs no-fix) ───
const candlesFix   = candles.map(c => ({ ...c }));
const candlesNoFix = candles.map(c => ({ ...c }));

if (sigSeriesFixed.length > 0) {
  attachSignals(candlesFix,   new Map([["funding_rate", sigSeriesFixed]]));
  attachSignals(candlesNoFix, new Map([["funding_rate", sigSeriesNoFix]]));
} else {
  // No signals at all — still run to show 0-trade baseline
  attachSignals(candlesFix,   new Map());
  attachSignals(candlesNoFix, new Map());
}

const filledFixed  = candlesFix.filter(c => c.signals?.["funding_rate"] != null && !isNaN(c.signals["funding_rate"] as number)).length;
const filledNoFix  = candlesNoFix.filter(c => c.signals?.["funding_rate"] != null && !isNaN(c.signals["funding_rate"] as number)).length;
console.log(`\n  Signal coverage (with fix):    ${filledFixed} / ${candlesFix.length} candles`);
console.log(`  Signal coverage (without fix): ${filledNoFix} / ${candlesNoFix.length} candles`);

// ── Tasks 3 & 4: WF WITH rollup fix ──────────────────────────────────────────
console.log("\n\n═══ Tasks 3 & 4: FundingExtreme WF — WITH rollup fix ═══");
const { windows: wFixed, allOos: oosFixed } = runWF(candlesFix, "WITH fix");
summarise(oosFixed, "Stitched OOS — WITH fix");

// ── Full IS sweep distribution ────────────────────────────────────────────────
console.log("\n── IS parameter sweep distribution across windows ──");
const selectionCounts = new Map<string, number>();
for (const w of wFixed) {
  const key = `k=${w.isK}/kl=${w.isKl}`;
  selectionCounts.set(key, (selectionCounts.get(key) ?? 0) + 1);
}
console.log("  Combo selected (IS best) across all windows:");
for (const [combo, cnt] of [...selectionCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${combo}: ${cnt}× of ${N_WINDOWS - 1} windows`);
}

console.log("\n  Per-window IS sweep (all 9 combos):");
for (const w of wFixed) {
  console.log(`  Window ${w.window} IS sweep:`);
  for (const s of w.isSweep.sort((a, b) => b.sharpe - a.sharpe)) {
    const marker = (s.k === w.isK && s.kl === w.isKl) ? " ← SELECTED" : "";
    console.log(`    k=${s.k}/kl=${s.kl}: sh=${s.sharpe.toFixed(3)}  ${s.trades}tr  $${s.pnl.toFixed(2)}${marker}`);
  }
}

// ── Task 5: WF WITHOUT rollup fix ─────────────────────────────────────────────
console.log("\n\n═══ Task 5: FundingExtreme WF — WITHOUT rollup fix ═══");
const { windows: wNoFix, allOos: oosNoFix } = runWF(candlesNoFix, "WITHOUT fix");
summarise(oosNoFix, "Stitched OOS — WITHOUT fix");

// ── Comparison table ──────────────────────────────────────────────────────────
console.log("\n\n═══ Fix vs No-Fix comparison ═══");
const fPnl   = oosFixed.reduce((s, t) => s + t.pnl, 0);
const nfPnl  = oosNoFix.reduce((s, t) => s + t.pnl, 0);
console.log(`${"Metric".padEnd(25)} ${"WITH fix".padStart(12)} ${"NO fix".padStart(12)} ${"Δ".padStart(12)}`);
console.log("-".repeat(63));
const fmt = (v: number, d: number) => v.toFixed(d).padStart(12);
console.log(`${"OOS trades".padEnd(25)} ${fmt(oosFixed.length, 0)} ${fmt(oosNoFix.length, 0)} ${fmt(oosFixed.length - oosNoFix.length, 0)}`);
console.log(`${"OOS P&L ($)".padEnd(25)} ${fmt(fPnl, 2)} ${fmt(nfPnl, 2)} ${fmt(fPnl - nfPnl, 2)}`);
console.log(`${"OOS Sharpe".padEnd(25)} ${fmt(oosSharpe(oosFixed), 3)} ${fmt(oosSharpe(oosNoFix), 3)} ${fmt(oosSharpe(oosFixed) - oosSharpe(oosNoFix), 3)}`);
console.log(`${"OOS MaxDD (%)".padEnd(25)} ${fmt(maxDD(oosFixed), 2)} ${fmt(maxDD(oosNoFix), 2)} ${fmt(maxDD(oosFixed) - maxDD(oosNoFix), 2)}`);

const selFixed  = wFixed.map(w => `k=${w.isK}/kl=${w.isKl}`).join(", ");
const selNoFix  = wNoFix.map(w => `k=${w.isK}/kl=${w.isKl}`).join(", ");
console.log(`\nIS selections WITH fix:    ${selFixed}`);
console.log(`IS selections WITHOUT fix: ${selNoFix}`);

// ── Deployed params (IS majority vote across fixed-signal run) ────────────────
const votes = new Map<string, number>();
for (const w of wFixed) {
  const key = `k=${w.isK}/kl=${w.isKl}`;
  votes.set(key, (votes.get(key) ?? 0) + 1);
}
const [deployedCombo] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nDeployed params (IS majority): ${deployedCombo?.[0] ?? "k=3/kl=1 (default)"}`);
