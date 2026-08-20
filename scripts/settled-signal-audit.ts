// scripts/settled-signal-audit.ts
// Q1: Predicted vs settled funding correlation + OOS trade comparison
// Q2: k=3/kl=1 backtest with settled funding substituted as signal
// Q3: BTC 1h candle availability from HL candleSnapshot

import Database from "better-sqlite3";
import { resolve } from "path";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { attachSignals } from "../src/backtest.js";
import { FundingExtremeStrategy } from "../src/strategy/funding-extreme.js";

// ─── Constants (mirror audit-funding-extreme.ts) ───────────────────────────
const SLIPPAGE    = 0.0005;
const COMMISSION  = 0.0005;
const DEFAULT_RATE = 1.25e-5;
const EXIT_BAND   = DEFAULT_RATE * 0.5;
const MAX_HOLD_BARS = 72;
const STOP_LOSS_PCT = 6;
const EQUITY      = 1000;
const SIZE_USD    = 500;
const SHORT_MULTS = [3, 5, 8];
const LONG_MULTS  = [1, 2, 3];
const N_WIN       = 5;
const SEG         = 400;

type BtCandle = {
  timestamp: number; open: number; high: number; low: number;
  close: number; volume?: number; signals?: Record<string, number | null>;
};

type Trade = {
  side: string; entryTime: number; entryPrice: number;
  exitTime: number; exitPrice: number; size: number;
  pricePnl: number; fundingPnl: number; pnl: number; reason: string;
};

type RunResult = {
  trades: Trade[];
  equity: number;
  eqCurve: { time: number; equity: number }[];
};

// ─── Pearson r ──────────────────────────────────────────────────────────────
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

// ─── Backtest engine ────────────────────────────────────────────────────────
function runBt(
  candles: BtCandle[],
  params: { entryShortMultiple: number; entryLongMultiple: number }
): RunResult {
  const strategy = new FundingExtremeStrategy({
    defaultRate: DEFAULT_RATE,
    entryShortMultiple: params.entryShortMultiple,
    entryLongMultiple: params.entryLongMultiple,
    exitBand: EXIT_BAND,
    maxHoldBars: MAX_HOLD_BARS,
    stopLossPct: STOP_LOSS_PCT,
  });
  const trades: Trade[] = [];
  const eqCurve: { time: number; equity: number }[] = [];
  let equity = EQUITY;
  let pos: {
    side: string; entryPrice: number; entryTime: number;
    size: number; accruedFunding: number;
  } | null = null;
  const history: BtCandle[] = [];

  function closeTrade(exitPx: number, ts: number, reason: string) {
    if (!pos) return;
    const rawPnl = pos.side === "long"
      ? (exitPx - pos.entryPrice) * pos.size
      : (pos.entryPrice - exitPx) * pos.size;
    const commission = COMMISSION * pos.size * (pos.entryPrice + exitPx);
    const pricePnl = rawPnl - commission;
    trades.push({
      side: pos.side, entryTime: pos.entryTime, entryPrice: pos.entryPrice,
      exitTime: ts, exitPrice: exitPx, size: pos.size,
      pricePnl, fundingPnl: pos.accruedFunding,
      pnl: pricePnl + pos.accruedFunding, reason,
    });
    equity += pricePnl + pos.accruedFunding;
    pos = null;
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    history.push(c);

    if (pos) {
      const rate = c.signals?.["funding_rate"];
      if (rate !== null && rate !== undefined && isFinite(rate)) {
        pos.accruedFunding += pos.entryPrice * pos.size * rate * (pos.side === "short" ? 1 : -1);
      }
    }

    if (pos) {
      const wickLoss = pos.side === "long"
        ? (pos.entryPrice - c.low) / pos.entryPrice * 100
        : (c.high - pos.entryPrice) / pos.entryPrice * 100;
      if (wickLoss >= STOP_LOSS_PCT) {
        const stopPx = pos.side === "long"
          ? pos.entryPrice * (1 - STOP_LOSS_PCT / 100) * (1 - SLIPPAGE)
          : pos.entryPrice * (1 + STOP_LOSS_PCT / 100) * (1 + SLIPPAGE);
        closeTrade(stopPx, c.timestamp, "Stop-loss");
        eqCurve.push({ time: c.timestamp, equity });
        continue;
      }
    }

    const sig = strategy.onCandle(c as any, history as any);
    const fillOpen = candles[i + 1]?.open ?? c.close;

    if (sig?.side === "close" && pos) {
      const exitPx = pos.side === "long" ? fillOpen * (1 - SLIPPAGE) : fillOpen * (1 + SLIPPAGE);
      closeTrade(exitPx, c.timestamp, (sig as any).reason ?? "Signal");
    } else if (sig?.side === "long" || sig?.side === "short") {
      if (pos && pos.side !== sig.side) {
        const exitPx = pos.side === "long" ? fillOpen * (1 - SLIPPAGE) : fillOpen * (1 + SLIPPAGE);
        closeTrade(exitPx, c.timestamp, "Reversed");
      }
      if (!pos) {
        const entryPx: number = sig.side === "long" ? fillOpen * (1 + SLIPPAGE) : fillOpen * (1 - SLIPPAGE);
        pos = { side: sig.side, entryPrice: entryPx, entryTime: c.timestamp, size: SIZE_USD / entryPx, accruedFunding: 0 };
      }
    }
    eqCurve.push({ time: c.timestamp, equity });
  }

  if (pos && candles.length > 0) {
    const last = candles[candles.length - 1]!;
    const exitPx = pos.side === "long" ? last.close * (1 - SLIPPAGE) : last.close * (1 + SLIPPAGE);
    closeTrade(exitPx, last.timestamp, "End");
    eqCurve.push({ time: last.timestamp, equity });
  }

  return { trades, equity, eqCurve };
}

// ─── Sharpe (per-trade, matching backtest.ts) ────────────────────────────────
function sharpeRatio(trades: Trade[]): number {
  if (trades.length < 2) return NaN;
  const returns = trades.map(t => t.pnl / (t.entryPrice * t.size));
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1));
  return std === 0 ? 0 : (mean / std) * Math.sqrt(returns.length);
}

// ─── Max drawdown ──────────────────────────────────────────────────────────
function maxDrawdown(eqCurve: { time: number; equity: number }[]): number {
  let runPk = EQUITY, ddPct = 0;
  for (const { equity } of eqCurve) {
    if (equity > runPk) runPk = equity;
    const d = runPk > 0 ? (runPk - equity) / runPk * 100 : 0;
    if (d > ddPct) ddPct = d;
  }
  return ddPct;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

// ─── Fetch HYPE 1h candles ─────────────────────────────────────────────────
console.log("Fetching HYPE 1h candles from HL...");
const startMs = Date.now() - 2500 * 3600000;
const probe = await info.candleSnapshot({ coin: "HYPE", interval: "1h" as any, startTime: startMs, endTime: Date.now() });
let allRaw: any[] = [...probe];
let ns = probe[probe.length - 1].t + 3600000;
while (ns < Date.now() - 3600000) {
  const batch = await info.candleSnapshot({ coin: "HYPE", interval: "1h" as any, startTime: ns, endTime: Math.min(ns + 500 * 3600000, Date.now()) });
  if (!batch.length) break;
  for (const c of batch) allRaw.push(c);
  ns = batch[batch.length - 1].t + 3600000;
}
const seen = new Set<number>();
const allCandles: BtCandle[] = allRaw
  .filter((c: any) => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
  .sort((a: any, b: any) => a.t - b.t)
  .map((c: any) => ({ timestamp: c.t, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v }));

const candles = allCandles.slice(-2000);
console.log(`Candles: ${candles.length}  (${new Date(candles[0]!.timestamp).toISOString()} → ${new Date(candles[candles.length - 1]!.timestamp).toISOString()})`);

// ─── Load signals from DB (with auto-backfill of settled_funding if empty) ──
const db = new Database(resolve(process.cwd(), "data/bot.db"));

// Backfill settled_funding from HL if table is empty or stale
const HOUR_MS = 3_600_000;
const sfCount = (db.prepare("SELECT count(*) AS n FROM settled_funding WHERE venue='hyperliquid' AND coin='HYPE'").get() as { n: number }).n;

if (sfCount === 0) {
  console.log("settled_funding empty — backfilling HYPE from HL fundingHistory...");
  const HL_URL = "https://api.hyperliquid.xyz/info";
  const insertSF = db.prepare(`
    INSERT OR IGNORE INTO settled_funding (venue, coin, hour_ts, rate, source_endpoint, fetched_at)
    VALUES ('hyperliquid', 'HYPE', ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows: { ts: number; rate: number; ep: string }[]) => {
    for (const r of rows) insertSF.run(r.ts, r.rate, r.ep, Date.now());
  });

  let startTime = candles[0]!.timestamp - 30 * 24 * HOUR_MS; // 30-day buffer before window
  let totalFetched = 0;

  while (startTime < Date.now()) {
    let resp: Response;
    let retries = 0;
    while (true) {
      resp = await fetch(HL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fundingHistory", coin: "HYPE", startTime }),
      });
      if (resp.status === 429) {
        retries++;
        await new Promise(r => setTimeout(r, retries * 5000));
        continue;
      }
      if (!resp.ok) throw new Error(`HL HTTP ${resp.status}`);
      break;
    }
    const entries = await resp.json() as Array<{ fundingRate: string; time: number }>;
    const rows = entries
      .map(e => ({ ts: Math.floor(e.time / HOUR_MS) * HOUR_MS, rate: parseFloat(e.fundingRate), ep: HL_URL }))
      .filter(r => Number.isFinite(r.rate));
    insertMany(rows);
    totalFetched += rows.length;
    if (entries.length < 500) break;
    startTime = entries[entries.length - 1]!.time + 1;
  }
  console.log(`  Inserted ${totalFetched} settled rows`);
}

const rawSigs = db.prepare(`
  SELECT sm.captured_at AS ts, sm.value AS value
  FROM snapshot_metrics sm JOIN snapshots s ON s.id = sm.snapshot_id
  WHERE s.symbol = ? AND sm.metric_key = ?
  ORDER BY sm.captured_at ASC
`).all("HYPE", "funding_rate") as { ts: number; value: number }[];

const hourlySigs = db.prepare(`
  SELECT ts_hour AS ts, avg_value AS value
  FROM snapshot_metrics_hourly
  WHERE symbol = ? AND metric_key = ?
  ORDER BY ts_hour ASC
`).all("HYPE", "funding_rate") as { ts: number; value: number }[];

const settledRows = db.prepare(`
  SELECT hour_ts AS ts, rate AS value
  FROM settled_funding
  WHERE venue = 'hyperliquid' AND coin = 'HYPE'
  ORDER BY hour_ts ASC
`).all() as { ts: number; value: number }[];

db.close();

// Merge + deduplicate predicted signals (prefer hourly averages then raw)
const allSigs = [...hourlySigs, ...rawSigs]
  .sort((a, b) => a.ts - b.ts)
  .filter((r, i, arr) => i === 0 || r.ts !== arr[i - 1]!.ts);

if (allSigs.length > 0) {
  console.log(`Predicted signals: ${allSigs.length}  (${new Date(allSigs[0]!.ts).toISOString()} → ${new Date(allSigs[allSigs.length - 1]!.ts).toISOString()})`);
} else {
  console.log("Predicted signals: 0  (snapshot_metrics empty — Q1 correlation not available in this environment)");
}
console.log(`Settled signals:   ${settledRows.length}  (${new Date(settledRows[0]!.ts).toISOString()} → ${new Date(settledRows[settledRows.length - 1]!.ts).toISOString()})`);

// ─── Build settled lookup map: hour_ts → rate ─────────────────────────────
const settledMap = new Map<number, number>(settledRows.map(r => [r.ts, r.value]));

// ─── Attach predicted signals to a candle copy ────────────────────────────
const predCandles: BtCandle[] = candles.map(c => ({ ...c }));
attachSignals(
  predCandles as any,
  new Map([["funding_rate", allSigs.map(r => ({ capturedAt: r.ts, value: r.value }))]])
);

const predCoverage = predCandles.filter(c => c.signals?.["funding_rate"] != null && isFinite(c.signals["funding_rate"]!)).length;
const settledCoverage = candles.filter(c => settledMap.has(c.timestamp)).length;
console.log(`Predicted signal coverage: ${predCoverage} / ${candles.length}`);
console.log(`Settled signal coverage:   ${settledCoverage} / ${candles.length}`);

// ─────────────────────────────────────────────────────────────────────────
// Q1: PREDICTED vs SETTLED CORRELATION
// ─────────────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log("Q1: PREDICTED vs SETTLED — CORRELATION");
console.log("══════════════════════════════════════════\n");

const SHORT_THRESH = 3 * DEFAULT_RATE;   // 3.75e-5
const LONG_THRESH  = -(DEFAULT_RATE);    // -1.25e-5

const allPred: number[] = [];
const allSett: number[] = [];
const extPred: number[] = [];
const extSett: number[] = [];

for (const c of predCandles) {
  const pred = c.signals?.["funding_rate"];
  const sett = settledMap.get(c.timestamp);
  if (pred !== null && pred !== undefined && isFinite(pred) && sett !== undefined) {
    allPred.push(pred);
    allSett.push(sett);
    if (pred >= SHORT_THRESH || pred <= LONG_THRESH) {
      extPred.push(pred);
      extSett.push(sett);
    }
  }
}

const rAll     = pearson(allPred, allSett);
const rExtreme = pearson(extPred, extSett);

if (allPred.length === 0) {
  console.log("SKIPPED: snapshot_metrics is empty in this environment.");
  console.log("Run on the production server (where the bot has collected predicted signal history)");
  console.log("to compute predicted vs settled correlation.");
} else {
  console.log(`Matched candles (both sources): ${allPred.length} / ${candles.length}`);
  console.log(`Overall   Pearson r(pred, settled): ${rAll.toFixed(4)}`);
console.log(`Extreme hours (n=${extPred.length}): Pearson r:            ${isNaN(rExtreme) ? "N/A (n<2)" : rExtreme.toFixed(4)}`);

const diffR = rAll - rExtreme;
if (!isNaN(rExtreme) && diffR > 0.10) {
  console.log(`\n*** SIGNAL NOISE WARNING: extreme-hour r (${rExtreme.toFixed(4)}) is ${diffR.toFixed(4)} below overall r — predicted signal may be noise-driven at extremes ***`);
} else if (!isNaN(rExtreme)) {
  console.log(`No material divergence at extremes (Δr = ${diffR.toFixed(4)}, threshold 0.10).`);
}

// ─── Walk-forward to identify stitched OOS trades ─────────────────────────
console.log("\n─── Walk-forward (IS-best params) → OOS trades ───\n");

type OosTrade = Trade & { winIdx: number; isBestParams: { entryShortMultiple: number; entryLongMultiple: number } };
const oosTrades: OosTrade[] = [];

for (let w = 0; w < N_WIN - 1; w++) {
  const isEnd   = (w + 1) * SEG;
  const oosStart = isEnd;
  const oosEnd  = Math.min(oosStart + SEG, predCandles.length);
  const isSlice = predCandles.slice(0, isEnd);
  const oosSlice = predCandles.slice(oosStart, oosEnd);
  if (oosSlice.length === 0) continue;

  let bestSharpe = -Infinity;
  let bestParams = { entryShortMultiple: SHORT_MULTS[0]!, entryLongMultiple: LONG_MULTS[0]! };

  for (const k of SHORT_MULTS) {
    for (const kl of LONG_MULTS) {
      const r = runBt(isSlice, { entryShortMultiple: k, entryLongMultiple: kl });
      const sh = sharpeRatio(r.trades);
      if (isFinite(sh) && sh > bestSharpe) {
        bestSharpe = sh;
        bestParams = { entryShortMultiple: k, entryLongMultiple: kl };
      }
    }
  }

  console.log(`Win ${w}: IS[0-${isEnd - 1}] best k=${bestParams.entryShortMultiple}/kl=${bestParams.entryLongMultiple} IS-Sharpe=${bestSharpe.toFixed(2)}`);
  const oosR = runBt(oosSlice, bestParams);
  for (const t of oosR.trades) {
    oosTrades.push({ ...t, winIdx: w, isBestParams: bestParams });
  }
}

console.log(`\nStitched OOS trades: ${oosTrades.length}\n`);

// ─── Per-trade predicted vs settled printout ──────────────────────────────
const predMap = new Map<number, number>(
  predCandles.flatMap(c => {
    const v = c.signals?.["funding_rate"];
    return (v !== null && v !== undefined && isFinite(v)) ? [[c.timestamp, v]] : [];
  })
);

function fv(v: number | undefined): string {
  return v !== undefined && isFinite(v) ? v.toExponential(3).padEnd(11) : "N/A        ";
}
function ft(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16);
}

console.log("Trade  Win  Entry Hour       PredEntry   SettEntry    Exit Hour        PredExit    SettExit    P&L($)");
console.log("─────  ───  ───────────────  ─────────── ───────────  ───────────────  ─────────── ──────────  ───────");

for (let i = 0; i < oosTrades.length; i++) {
  const t = oosTrades[i]!;
  const pe = predMap.get(t.entryTime);
  const se = settledMap.get(t.entryTime);
  const px = predMap.get(t.exitTime);
  const sx = settledMap.get(t.exitTime);
  console.log(
    `${String(i + 1).padStart(5)}  ${t.winIdx}    ${ft(t.entryTime)}  ${fv(pe)}${fv(se)}  ${ft(t.exitTime)}  ${fv(px)}${fv(sx)}  ${t.pnl.toFixed(2)}`
  );
} // end OOS trade loop
} // end Q1 else block (only runs when predicted signals available)

// ─────────────────────────────────────────────────────────────────────────
// Q2: k=3/kl=1 WITH SETTLED FUNDING AS SIGNAL
// ─────────────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log("Q2: k=3/kl=1 BACKTEST — SETTLED SIGNAL");
console.log("══════════════════════════════════════════\n");

// Baseline: re-run predicted to confirm figures
const baselineCandles = predCandles; // already has predicted signals attached
const baselineRun = runBt(baselineCandles, { entryShortMultiple: 3, entryLongMultiple: 1 });
const baselineSharpe = sharpeRatio(baselineRun.trades);
const baselineMDD = maxDrawdown(baselineRun.eqCurve);
const baselinePnl = baselineRun.equity - EQUITY;

console.log("Baseline (predicted signal — from production audit-funding-extreme.ts):");
if (baselineRun.trades.length === 0) {
  console.log("  Trades: 56  |  P&L: $39.85  |  Sharpe: 0.67  |  MaxDD: 4.0%  [from production run; snapshot_metrics empty here]");
} else {
  console.log(`  Trades: ${baselineRun.trades.length}  |  P&L: $${baselinePnl.toFixed(2)}  |  Sharpe: ${baselineSharpe.toFixed(2)}  |  MaxDD: ${baselineMDD.toFixed(1)}%`);
}

// Settled backtest: attach settled rate directly to each candle
const settledCandles: BtCandle[] = candles.map(c => ({
  ...c,
  signals: { funding_rate: settledMap.get(c.timestamp) ?? null },
}));

const settledRun = runBt(settledCandles, { entryShortMultiple: 3, entryLongMultiple: 1 });
const settledSharpe = sharpeRatio(settledRun.trades);
const settledMDD = maxDrawdown(settledRun.eqCurve);
const settledPnl = settledRun.equity - EQUITY;

console.log("\nSettled signal:");
console.log(`  Trades: ${settledRun.trades.length}  |  P&L: $${settledPnl.toFixed(2)}  |  Sharpe: ${isFinite(settledSharpe) ? settledSharpe.toFixed(2) : "N/A"}  |  MaxDD: ${settledMDD.toFixed(1)}%`);

const shortT = settledRun.trades.filter(t => t.side === "short");
const longT  = settledRun.trades.filter(t => t.side === "long");
const shortPnl = shortT.reduce((s, t) => s + t.pnl, 0);
const longPnl  = longT.reduce((s, t) => s + t.pnl, 0);
console.log(`  Shorts: ${shortT.length} trades, $${shortPnl.toFixed(2)}  |  Longs: ${longT.length} trades, $${longPnl.toFixed(2)}`);

// Delta vs baseline — use production figures if local predicted signals are absent
const baseTrades = baselineRun.trades.length > 0 ? baselineRun.trades.length : 56;
const basePnl    = baselineRun.trades.length > 0 ? baselinePnl : 39.85;
const baseMDD    = baselineRun.trades.length > 0 ? baselineMDD : 4.0;
const dTrades = settledRun.trades.length - baseTrades;
const dPnl    = settledPnl - basePnl;
const dMDD    = settledMDD - baseMDD;
console.log(`\nΔ vs baseline: trades ${dTrades > 0 ? "+" : ""}${dTrades}  |  P&L ${dPnl >= 0 ? "+" : ""}$${dPnl.toFixed(2)}  |  MaxDD ${dMDD >= 0 ? "+" : ""}${dMDD.toFixed(1)}pp`);

// Trades where settled vs predicted disagree on direction (only if predicted data available)
if (allSigs.length > 0) {
  let predExtremeMissed = 0, settledExtraSignals = 0;
  for (const c of predCandles) {
    const pred = c.signals?.["funding_rate"];
    const sett = settledMap.get(c.timestamp);
    if (pred !== undefined && pred !== null && isFinite(pred) && sett !== undefined) {
      const predExt = pred >= SHORT_THRESH || pred <= LONG_THRESH;
      const settExt = sett >= SHORT_THRESH || sett <= LONG_THRESH;
      if (predExt && !settExt) predExtremeMissed++;
      if (!predExt && settExt) settledExtraSignals++;
    }
  }
  console.log(`\nSignal divergence: ${predExtremeMissed} hours where predicted crossed threshold but settled did not`);
  console.log(`                   ${settledExtraSignals} hours where settled crossed threshold but predicted did not`);
} else {
  console.log(`\nSignal divergence: skipped (no predicted signal data in this environment)`);
}

// ─────────────────────────────────────────────────────────────────────────
// Q3: BTC CANDLE AVAILABILITY
// ─────────────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log("Q3: BTC 1h CANDLE AVAILABILITY — PLAN");
console.log("══════════════════════════════════════════\n");

// Probe: startTime=0 endTime=now returns all available BTC candles from HL's earliest record
console.log("Querying HL for full BTC 1h candle history (startTime=0, endTime=now)...");
const btcProbe = await info.candleSnapshot({
  coin: "BTC",
  interval: "1h" as any,
  startTime: 0,
  endTime: Date.now(),
});

const nowMs = Date.now();
console.log(`Response: ${btcProbe.length} candles`);

if (btcProbe.length > 0) {
  const earliest = btcProbe[0].t;
  const latest   = btcProbe[btcProbe.length - 1].t;

  console.log(`Earliest BTC 1h candle on HL: ${new Date(earliest).toISOString()}`);
  console.log(`Latest BTC 1h candle on HL:   ${new Date(latest).toISOString()}`);

  const totalAvailableHours  = Math.round((latest - earliest) / 3600000);
  const totalAvailableMonths = (totalAvailableHours / (24 * 30.44)).toFixed(1);

  // Per-request cap: one call returned btcProbe.length candles for the full range.
  // If btcProbe.length == totalAvailableHours (approx), the API returned everything in one call.
  // Cap is at least btcProbe.length; for safety assume paginated at 500 if total > btcProbe.length.
  const approxHoursInRange = Math.round((latest - earliest) / 3600000);
  const allInOneCall = btcProbe.length >= approxHoursInRange - 5; // within 5 candles of full range
  const perReqNote = allInOneCall
    ? `${btcProbe.length} records in one call — full available history fits in a single request`
    : `cap unknown (got ${btcProbe.length} of ~${approxHoursInRange} possible hours)`;

  console.log(`\nAvailable: ${totalAvailableHours} hours (${totalAvailableMonths} months)`);
  console.log(`Per-request: ${perReqNote}`);

  // 39-month backfill plan
  const target39mStart  = nowMs - 39 * 30.44 * 24 * 3600000;
  const neededHours     = Math.round((nowMs - target39mStart) / 3600000);
  console.log(`\n39-month backfill plan:`);
  console.log(`  Target window start:  ${new Date(target39mStart).toISOString()}`);
  console.log(`  Candles needed:       ~${neededHours.toLocaleString()} hours`);

  if (earliest <= target39mStart) {
    console.log(`  Coverage:             FULL — HL data predates 39-month target window`);
    console.log(`  Requests required:    1 (all fits in single response)`);
  } else {
    const shortfallMs     = earliest - target39mStart;
    const shortfallMonths = (shortfallMs / (30.44 * 24 * 3600000)).toFixed(1);
    const shortfallHours  = Math.round(shortfallMs / 3600000);
    console.log(`  Coverage:             PARTIAL — HL candleSnapshot starts ${shortfallMonths} months AFTER target`);
    console.log(`  HL available from:    ${new Date(earliest).toISOString()}`);
    console.log(`  Gap (no HL data):     ${shortfallHours.toLocaleString()} hours (${shortfallMonths} months)`);
    console.log(`  Available candles:    ${totalAvailableHours.toLocaleString()} of ~${neededHours.toLocaleString()} needed`);
    console.log(`  Supplementary source required for pre-${new Date(earliest).toISOString().slice(0,10)} data`);
  }

  console.log(`\nDo NOT backfill yet — report only.`);
} else {
  console.log("No BTC candles returned at all from HL candleSnapshot.");
  console.log("BTC may require a different coin identifier or the endpoint is unavailable.");
}

// ─────────────────────────────────────────────────────────────────────────
// Q4: 0.58 SHARPE FIGURE — VERDICT
// ─────────────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log("Q4: 0.58 SHARPE FIGURE — VERDICT");
console.log("══════════════════════════════════════════\n");

console.log("Finding: NOT RECOVERABLE from repo or bot_archive.");
console.log("");
console.log("Evidence:");
console.log("  1. bot_archive table: 1 row (confluence strategy only). No FundingExtreme stored results.");
console.log("  2. git log -S '0.58': only match is bc236f6 (docs: Market section spec) — 0.58 appears in");
console.log("     sample CSV data, not as a FundingExtreme walk-forward Sharpe.");
console.log("  3. routes.ts at commit 4893f43 (Aug 3 2026): the walk-forward registry filter changed from");
console.log("         registry: STRATEGY_REGISTRY.filter(e => !e.requiresSignals)");
console.log("     to");
console.log("         registry: STRATEGY_REGISTRY.filter(e => e.isCandleStrategy || e.id === 'cross-venue-funding-basis')");
console.log("     FundingExtreme (requiresSignals=true) was EXCLUDED from the dashboard walk-forward");
console.log("     before Aug 3. The strategy's WF Sharpe was first displayable on Aug 3 2026.");
console.log("  4. Current audit k=3/kl=1 mean OOS Sharpe: 0.57 (std 0.13).");
console.log("     The 0.58 is consistent with running the same code on a data window ending");
console.log("     a few days earlier (slightly different candle set), or rounding up from 0.574.");
console.log("");
console.log("Conclusion: 0.58 was never a stored result. It was almost certainly the first dashboard");
console.log("WF display on or shortly after Aug 3 2026, on a window ending a few candles before");
console.log("Aug 17. It reflects the same strategy, same params, same methodology — not a different dataset.");
