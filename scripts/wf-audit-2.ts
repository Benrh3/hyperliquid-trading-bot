// scripts/wf-audit-2.ts
// Three further analyses on top of wf-audit.ts:
// A. Settled-signal WF — same walk-forward but using settled_funding rates
//    instead of snapshot_metrics predictions. First clean comparison after the
//    rollup-lookahead fix (prior settled test used old leading alignment).
// B. Cost sensitivity on k=COST_K/kl=COST_KL (set below) — four scenarios:
//    baseline, 2× fees, 3× fees, 10bps slippage per fill.
// C. Regime breakdown of WITH-fix stitched OOS using swing_flip_log + robustness
//    (total OOS P&L ex-top-1 trade, ex-top-3 trades).
//
// Usage: npx tsx scripts/wf-audit-2.ts [--no-signals]
//   --no-signals  skip DB signal loading (zero-trade run for smoke-testing)

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
const COMMISSION_PCT = 0.0005;   // 5 bps — baseline
const STOP_LOSS_PCT  = 6;

// Cost sensitivity target params — adjust after seeing IS majority from wf-audit.ts
const COST_K  = 5;
const COST_KL = 3;

// Settled-funding capturedAt offset.
// Set by running scripts/settled-timing-audit.ts first:
//   corr_a > corr_b  →  hour_ts = settlement time → offset = 0         (rate known at H)
//   corr_b > corr_a  →  hour_ts = accrual start   → offset = HOUR_MS   (rate known at H+1h)
// Domain expectation: corr_a > corr_b (HL settles at the top of H, rate is final at H).
const SETTLED_OFFSET_MS = 0;

// FundingExtreme param grid
const K_VALS  = [3, 5, 8];
const KL_VALS = [1, 2, 3];
const GRID: { k: number; kl: number }[] = [];
for (const k of K_VALS) for (const kl of KL_VALS) GRID.push({ k, kl });

// ─── Helpers ────────────────────────────────────────────────────────────────

function oosSharpe(trades: BacktestTrade[]): number {
  if (trades.length < 2) return 0;
  const r    = trades.map(t => t.pnl / (t.entryPrice * t.size));
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
}

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
  window:        number;
  isK:           number;
  isKl:          number;
  isSharpe:      number;
  oosTradeCount: number;
  oosPnl:        number;
  oosSharpeVal:  number;
  oosMaxDD:      number;
  isSweep:       { k: number; kl: number; sharpe: number; trades: number; pnl: number }[];
  oosTrades:     BacktestTrade[];
}

function runWF(
  candles:       Candle[],
  label:         string,
  commissionPct: number = COMMISSION_PCT,
  fixedK?: number,
  fixedKl?: number,
  silent = false,
): { windows: WFWindowResult[]; allOos: BacktestTrade[] } {
  const segSize = Math.floor(candles.length / N_WINDOWS);
  const windows: WFWindowResult[] = [];
  const log = (...args: Parameters<typeof console.log>) => { if (!silent) console.log(...args); };

  log(`\n── ${label}: WF (${N_WINDOWS} windows, segSize=${segSize}, commission=${(commissionPct*10000).toFixed(1)}bps) ──`);

  for (let i = 1; i < N_WINDOWS; i++) {
    const isSamples = candles.slice(0, i * segSize);
    const oosStart  = i * segSize;
    const oosEnd    = Math.min((i + 1) * segSize, candles.length);
    const rawOos    = candles.slice(oosStart, oosEnd);
    if (rawOos.length === 0) break;

    const warmupStart = Math.max(0, oosStart - WARMUP_BARS);
    const oosSamples  = [...candles.slice(warmupStart, oosStart), ...rawOos];

    let bestK = fixedK ?? 3, bestKl = fixedKl ?? 1, bestMetric = -Infinity;
    const sweep: WFWindowResult["isSweep"] = [];

    if (fixedK === undefined) {
      // IS grid search
      for (const { k, kl } of GRID) {
        const r = runBacktest(makeStrat(k, kl), isSamples, {
          initialEquity:   INITIAL_EQUITY,
          positionSizeUsd: POS_SIZE_USD,
          commissionPct,
          stopLossPct:     STOP_LOSS_PCT,
        });
        const metric = r.sharpeRatio ?? 0;
        sweep.push({ k, kl, sharpe: metric, trades: r.tradeCount, pnl: r.totalPnl });
        if (metric > bestMetric) { bestMetric = metric; bestK = k; bestKl = kl; }
      }
    } else {
      // Fixed params — no IS search needed
      const r = runBacktest(makeStrat(fixedK, fixedKl ?? 1), isSamples, {
        initialEquity:   INITIAL_EQUITY,
        positionSizeUsd: POS_SIZE_USD,
        commissionPct,
        stopLossPct:     STOP_LOSS_PCT,
      });
      bestMetric = r.sharpeRatio ?? 0;
      sweep.push({ k: fixedK, kl: fixedKl ?? 1, sharpe: bestMetric, trades: r.tradeCount, pnl: r.totalPnl });
    }

    // OOS with best params
    const fullOos  = runBacktest(makeStrat(bestK, bestKl), oosSamples, {
      initialEquity:   INITIAL_EQUITY,
      positionSizeUsd: POS_SIZE_USD,
      commissionPct,
      stopLossPct:     STOP_LOSS_PCT,
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

    const paramsStr = fixedK !== undefined
      ? `fixed k=${fixedK}/kl=${fixedKl}`
      : `IS selects k=${bestK}/kl=${bestKl} (sh=${bestMetric.toFixed(2)})`;
    log(`  Win ${i}: ${paramsStr} | ` +
      `OOS ${oosTrades.length}tr $${oosPnl.toFixed(2)} sh=${oosSharpe(oosTrades).toFixed(2)} dd=${maxDD(oosTrades).toFixed(1)}%`);
    if (fixedK === undefined && sweep.length > 1) {
      log(`    IS sweep: ${sweep.map(s => `k=${s.k}/kl=${s.kl}:sh=${s.sharpe.toFixed(2)}`).join("  ")}`);
    }
  }

  const allOos = windows.flatMap(w => w.oosTrades);
  return { windows, allOos };
}

// ─── Regime helpers ──────────────────────────────────────────────────────────

interface FlipRow {
  created_at: number;
  horizon:    string;
  new_call:   string;
  regime:     string;
}

// Point-in-time regime: find the last flip before (or at) timeMs for a given horizon.
function regimeAt(flips: FlipRow[], timeMs: number): { call: string; regime: string } {
  let lo = 0, hi = flips.length - 1;
  let last: FlipRow | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flips[mid]!.created_at <= timeMs) { last = flips[mid]!; lo = mid + 1; }
    else hi = mid - 1;
  }
  return last ? { call: last.new_call, regime: last.regime } : { call: "UNKNOWN", regime: "UNKNOWN" };
}

interface RegimeStat { trades: number; pnl: number; winners: number }

function regimeBreakdown(
  trades:          BacktestTrade[],
  flipsByHorizon:  Map<string, FlipRow[]>,
  horizons:        string[],
) {
  console.log("\n── Regime breakdown (Swing Advisor) ──");

  for (const horizon of horizons) {
    const flips = flipsByHorizon.get(horizon);
    if (!flips || flips.length === 0) {
      console.log(`\n  ${horizon}: no flip data`);
      continue;
    }

    const stats = new Map<string, RegimeStat>();
    let unknownCount = 0;

    for (const trade of trades) {
      const { regime } = regimeAt(flips, trade.entryTime);
      if (regime === "UNKNOWN") { unknownCount++; continue; }
      const s = stats.get(regime) ?? { trades: 0, pnl: 0, winners: 0 };
      s.trades++;
      s.pnl += trade.pnl;
      if (trade.pnl > 0) s.winners++;
      stats.set(regime, s);
    }

    console.log(`\n  ${horizon} horizon:`);
    console.log(`  ${"Regime".padEnd(20)} ${"Trades".padStart(7)} ${"P&L".padStart(9)} ${"WR%".padStart(6)} ${"Sharpe".padStart(8)}`);
    console.log(`  ${"-".repeat(54)}`);

    for (const [regime, s] of [...stats.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
      const regimeTrades = trades.filter(t => regimeAt(flips, t.entryTime).regime === regime);
      const sh           = oosSharpe(regimeTrades);
      const wr           = s.trades > 0 ? (s.winners / s.trades * 100).toFixed(0) : "—";
      console.log(`  ${regime.padEnd(20)} ${String(s.trades).padStart(7)} ${("$" + s.pnl.toFixed(2)).padStart(9)} ${(wr + "%").padStart(6)} ${sh.toFixed(3).padStart(8)}`);
    }
    if (unknownCount > 0) {
      console.log(`  ${"UNKNOWN (pre-swing)".padEnd(20)} ${String(unknownCount).padStart(7)} ${"—".padStart(9)}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

// ── Fetch HYPE 1h candles ─────────────────────────────────────────────────────
console.log("Fetching HYPE 1h candles...");
const rawCandles = await info.candleSnapshot({
  coin: "HYPE", interval: "1h" as any, startTime: 0, endTime: Date.now(),
}) as any[];

rawCandles.sort((a: any, b: any) => (a.t as number) - (b.t as number));
const candles: Candle[] = rawCandles.map((c: any) => ({
  timestamp: c.t as number,
  open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v,
}));
console.log(`  ${candles.length} candles, ${new Date(candles[0]!.timestamp).toISOString()} → ${new Date(candles[candles.length - 1]!.timestamp).toISOString()}`);

// ── Load signals from DB ──────────────────────────────────────────────────────
let sigSeriesFixed:    SignalTimeSeries[] = [];
let sigSeriesSettled:  SignalTimeSeries[] = [];
let flipsByHorizon     = new Map<string, FlipRow[]>();

if (!NO_SIGNALS) {
  console.log(`\nLoading signals from ${DB_PATH}...`);
  const db = new Database(DB_PATH, { readonly: true });

  // WITH-fix signal series (same query as wf-audit.ts)
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

  sigSeriesFixed = [...hourlyFixed, ...rawRows];
  console.log(`  WITH-fix signal series: ${sigSeriesFixed.length} rows (${hourlyFixed.length} hourly + ${rawRows.length} raw)`);

  // Settled funding signal series.
  // capturedAt = hour_ts + SETTLED_OFFSET_MS (see constant at top of file).
  // Run scripts/settled-timing-audit.ts to determine the correct offset empirically.
  const settledRows = db.prepare(`
    SELECT hour_ts + ${SETTLED_OFFSET_MS} AS capturedAt, rate AS value
    FROM settled_funding
    WHERE venue = 'HL' AND coin = 'HYPE'
    ORDER BY hour_ts ASC
  `).all() as SignalTimeSeries[];

  sigSeriesSettled = settledRows;
  console.log(`  Settled signal series:  ${settledRows.length} rows` +
    (settledRows.length > 0
      ? `  (${new Date((settledRows[0] as any).capturedAt).toISOString()} → ${new Date((settledRows[settledRows.length - 1] as any).capturedAt).toISOString()})`
      : ""));

  // Swing Advisor flip log — for regime breakdown of WITH-fix OOS trades
  const allFlips = db.prepare(`
    SELECT created_at, horizon, new_call, regime
    FROM swing_flip_log
    ORDER BY horizon, created_at ASC
  `).all() as FlipRow[];

  for (const flip of allFlips) {
    const list = flipsByHorizon.get(flip.horizon) ?? [];
    list.push(flip);
    flipsByHorizon.set(flip.horizon, list);
  }
  const flipSummary = [...flipsByHorizon.entries()]
    .map(([h, f]) => `${h}: ${f.length} flips`)
    .join(", ");
  console.log(`  Swing flip log:         ${allFlips.length} flips total (${flipSummary || "none"})`);

  db.close();
} else {
  console.log("\n--no-signals: skipping DB load.");
}

// ── Attach signals ────────────────────────────────────────────────────────────
const candlesFix     = candles.map(c => ({ ...c }));
const candlesSettled = candles.map(c => ({ ...c }));

attachSignals(candlesFix,     sigSeriesFixed.length   > 0 ? new Map([["funding_rate", sigSeriesFixed]])   : new Map());
attachSignals(candlesSettled, sigSeriesSettled.length  > 0 ? new Map([["funding_rate", sigSeriesSettled]]) : new Map());

const coverageFix     = candlesFix.filter(    c => c.signals?.["funding_rate"] != null && !isNaN(c.signals["funding_rate"] as number)).length;
const coverageSettled = candlesSettled.filter( c => c.signals?.["funding_rate"] != null && !isNaN(c.signals["funding_rate"] as number)).length;
console.log(`  Signal coverage (WITH fix):   ${coverageFix} / ${candles.length} candles`);
console.log(`  Signal coverage (settled):    ${coverageSettled} / ${candles.length} candles`);

// ══ Section A: Settled-signal WF ═════════════════════════════════════════════
console.log("\n\n═══ A. Walk-Forward — SETTLED funding signal ═══");
console.log("(capturedAt = hour_ts; no rollup offset — settlement is observable at hour_ts)");

const { windows: wSettled, allOos: oosSettled } = runWF(candlesSettled, "SETTLED signal WF");
summarise(oosSettled, "Stitched OOS — SETTLED signal");

console.log("\n── IS parameter distribution ──");
const settledVotes = new Map<string, number>();
for (const w of wSettled) {
  const key = `k=${w.isK}/kl=${w.isKl}`;
  settledVotes.set(key, (settledVotes.get(key) ?? 0) + 1);
}
console.log("  IS selection counts:");
for (const [combo, cnt] of [...settledVotes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${combo}: ${cnt}× of ${N_WINDOWS - 1} windows`);
}
console.log("\n  Per-window IS sweep:");
for (const w of wSettled) {
  console.log(`  Window ${w.window} IS sweep:`);
  for (const s of w.isSweep.sort((a, b) => b.sharpe - a.sharpe)) {
    const marker = (s.k === w.isK && s.kl === w.isKl) ? " ← SELECTED" : "";
    console.log(`    k=${s.k}/kl=${s.kl}: sh=${s.sharpe.toFixed(3)}  ${s.trades}tr  $${s.pnl.toFixed(2)}${marker}`);
  }
}

// Comparison: WITH-fix predicted vs settled
console.log("\n── Re-running WITH-fix WF for comparison ──");
const { windows: wFixed, allOos: oosFixed } = runWF(candlesFix, "WITH-fix predicted WF");
summarise(oosFixed, "Stitched OOS — WITH fix (predicted signal)");

const fPnl  = oosFixed.reduce((s, t) => s + t.pnl, 0);
const sPnl  = oosSettled.reduce((s, t) => s + t.pnl, 0);

console.log("\n── Predicted vs Settled comparison ──");
const fmt = (v: number, d: number) => v.toFixed(d).padStart(12);
console.log(`${"Metric".padEnd(25)} ${"Predicted".padStart(12)} ${"Settled".padStart(12)} ${"Δ (S−P)".padStart(12)}`);
console.log("-".repeat(63));
console.log(`${"OOS trades".padEnd(25)} ${fmt(oosFixed.length, 0)} ${fmt(oosSettled.length, 0)} ${fmt(oosSettled.length - oosFixed.length, 0)}`);
console.log(`${"OOS P&L ($)".padEnd(25)} ${fmt(fPnl, 2)} ${fmt(sPnl, 2)} ${fmt(sPnl - fPnl, 2)}`);
console.log(`${"OOS Sharpe".padEnd(25)} ${fmt(oosSharpe(oosFixed), 3)} ${fmt(oosSharpe(oosSettled), 3)} ${fmt(oosSharpe(oosSettled) - oosSharpe(oosFixed), 3)}`);
console.log(`${"OOS MaxDD (%)".padEnd(25)} ${fmt(maxDD(oosFixed), 2)} ${fmt(maxDD(oosSettled), 2)} ${fmt(maxDD(oosSettled) - maxDD(oosFixed), 2)}`);

const selFixed   = wFixed.map(w => `k=${w.isK}/kl=${w.isKl}`).join(", ");
const selSettled = wSettled.map(w => `k=${w.isK}/kl=${w.isKl}`).join(", ");
console.log(`\nIS selections predicted: ${selFixed}`);
console.log(`IS selections settled:   ${selSettled}`);

// ══ Section B: Cost sensitivity ═══════════════════════════════════════════════
console.log(`\n\n═══ B. Cost Sensitivity — k=${COST_K}/kl=${COST_KL} (fixed params, no IS re-opt) ═══`);
console.log("(Backtest SLIPPAGE=5bps is hardcoded in backtest.ts; each scenario adds to commission)");

const costScenarios: { label: string; commissionPct: number; note: string }[] = [
  { label: "Baseline",         commissionPct: 0.0005, note: "5bps commission + 5bps slippage (baked in) = 10bps/side" },
  { label: "2× fees",          commissionPct: 0.001,  note: "10bps commission + 5bps slippage = 15bps/side" },
  { label: "3× fees",          commissionPct: 0.0015, note: "15bps commission + 5bps slippage = 20bps/side" },
  { label: "10bps slippage",   commissionPct: 0.001,  note: "extra 5bps slippage modelled as extra commission; total 10bps slip + 5bps commish = 15bps/side" },
];

console.log(`\n${"Scenario".padEnd(20)} ${"Commission".padStart(12)} ${"OOS Trades".padStart(12)} ${"OOS P&L".padStart(12)} ${"OOS Sharpe".padStart(12)} ${"OOS MaxDD".padStart(11)}`);
console.log("-".repeat(82));

for (const sc of costScenarios) {
  const { allOos: oosC } = runWF(candlesFix, sc.label, sc.commissionPct, COST_K, COST_KL, true);
  const pnl = oosC.reduce((s, t) => s + t.pnl, 0);
  console.log(
    `${sc.label.padEnd(20)} ${(sc.commissionPct * 10000).toFixed(1).padStart(9) + "bps"} ` +
    `${String(oosC.length).padStart(12)} ` +
    `${"$" + pnl.toFixed(2).padStart(11)} ` +
    `${oosSharpe(oosC).toFixed(3).padStart(12)} ` +
    `${(maxDD(oosC).toFixed(2) + "%").padStart(11)}`
  );
  console.log(`  (${sc.note})`);
}

// ══ Section C: Regime breakdown + robustness ══════════════════════════════════
console.log("\n\n═══ C. Regime Breakdown + Robustness (WITH-fix OOS) ═══");

if (oosFixed.length === 0) {
  console.log("  No OOS trades — skipping (empty signal series in dev environment).");
} else {
  const horizons = ["daily", "weekly", "monthly"];
  regimeBreakdown(oosFixed, flipsByHorizon, horizons);

  // Robustness: P&L ex-top-1, ex-top-3
  console.log("\n── Concentration / robustness ──");
  const sortedByPnl = [...oosFixed].sort((a, b) => b.pnl - a.pnl);
  const totalPnl    = oosFixed.reduce((s, t) => s + t.pnl, 0);
  const top1Pnl     = sortedByPnl[0]!.pnl;
  const top3Pnl     = sortedByPnl.slice(0, 3).reduce((s, t) => s + t.pnl, 0);

  console.log(`  Total OOS P&L:                   $${totalPnl.toFixed(2)}`);
  console.log(`  Top 1 trade P&L:                 $${top1Pnl.toFixed(2)} (${(top1Pnl/totalPnl*100).toFixed(1)}% of total)`);
  console.log(`  P&L ex-top-1:                    $${(totalPnl - top1Pnl).toFixed(2)}`);
  console.log(`  P&L ex-top-1 Sharpe:             ${oosSharpe(sortedByPnl.slice(1)).toFixed(3)}`);
  console.log(`  Top 3 trades P&L:                $${top3Pnl.toFixed(2)} (${(top3Pnl/totalPnl*100).toFixed(1)}% of total)`);
  console.log(`  P&L ex-top-3:                    $${(totalPnl - top3Pnl).toFixed(2)}`);
  console.log(`  P&L ex-top-3 Sharpe:             ${oosSharpe(sortedByPnl.slice(3)).toFixed(3)}`);

  // Individual top trades
  console.log("\n  Top 5 individual OOS trades:");
  console.log(`  ${"#".padEnd(3)} ${"Side".padEnd(6)} ${"Entry".padEnd(25)} ${"Exit".padEnd(25)} ${"P&L".padStart(9)} ${"Hold(h)".padStart(8)}`);
  for (let i = 0; i < Math.min(5, sortedByPnl.length); i++) {
    const t  = sortedByPnl[i]!;
    const hr = Math.round((t.exitTime - t.entryTime) / HOUR_MS);
    console.log(`  ${String(i + 1).padEnd(3)} ${t.side.padEnd(6)} ${new Date(t.entryTime).toISOString().padEnd(25)} ${new Date(t.exitTime).toISOString().padEnd(25)} ${"$" + t.pnl.toFixed(2).padStart(8)} ${String(hr).padStart(8)}`);
  }
}
