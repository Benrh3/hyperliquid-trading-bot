#!/usr/bin/env npx tsx
/**
 * FundingExtreme audit — read-only.
 * Q1-Q6 of the funding-extreme strategy audit.
 *
 *   cd ~/hyperliquid-trading-bot && npx tsx scripts/audit-funding-extreme.ts
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { attachSignals } from "../src/backtest.js";
import { FundingExtremeStrategy } from "../src/strategy/funding-extreme.js";
import { classifyRegime } from "../src/swing-advisor/regime.js";

const DB_PATH       = resolve(process.cwd(), "data/bot.db");
const COIN          = "HYPE";
const INTERVAL      = "1h";
const INTERVAL_MS   = 3_600_000;
const DEFAULT_RATE  = 1.25e-5;
const EXIT_BAND     = DEFAULT_RATE * 0.5;
const MAX_HOLD_BARS = 72;
const STOP_LOSS_PCT = 6;
const EQUITY        = 1_000;
const SIZE_USD      = 500;
const COMMISSION    = 0.0005;
const SLIPPAGE      = 0.0005;
const N_WIN         = 5;
const TOTAL_CANDLES = 2_000;
const SEG_SIZE      = Math.floor(TOTAL_CANDLES / N_WIN);  // 400
const MAX_PAGE      = 500;

const SHORT_MULTS = [3, 5, 8];
const LONG_MULTS  = [1, 2, 3];
const DAILY_CFG   = { candleInterval: "1h", emaFast: 8, emaSlow: 21 };

interface BtCandle {
  timestamp: number; open: number; high: number; low: number;
  close: number; volume: number; coin?: string; signals?: Record<string, number | null>;
}

interface Trade {
  side: "long" | "short"; entryTime: number; entryPrice: number;
  exitTime: number; exitPrice: number; size: number;
  pricePnl: number; fundingPnl: number; pnl: number; reason: string;
}

interface RunResult {
  trades: Trade[]; equityCurve: { time: number; equity: number }[];
  sharpe: number; totalPnl: number; maxDdPct: number;
}

function runBt(
  candles: BtCandle[],
  params: { entryShortMultiple: number; entryLongMultiple: number },
  opts: { slippage?: number; commission?: number } = {}
): RunResult {
  const slip = opts.slippage  ?? SLIPPAGE;
  const comm = opts.commission ?? COMMISSION;

  const strategy = new FundingExtremeStrategy({
    defaultRate: DEFAULT_RATE, entryShortMultiple: params.entryShortMultiple,
    entryLongMultiple: params.entryLongMultiple, exitBand: EXIT_BAND,
    maxHoldBars: MAX_HOLD_BARS, stopLossPct: STOP_LOSS_PCT,
  });

  const trades: Trade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];
  let equity = EQUITY;
  let pos: { side: "long" | "short"; entryPrice: number; entryTime: number; size: number; accruedFunding: number } | null = null;
  const history: BtCandle[] = [];

  function closeTrade(exitPx: number, ts: number, reason: string) {
    if (!pos) return;
    const rawPnl = pos.side === "long" ? (exitPx - pos.entryPrice) * pos.size : (pos.entryPrice - exitPx) * pos.size;
    const commission = comm * pos.size * (pos.entryPrice + exitPx);
    const pricePnl = rawPnl - commission;
    const fundingPnl = pos.accruedFunding;
    trades.push({ side: pos.side, entryTime: pos.entryTime, entryPrice: pos.entryPrice,
      exitTime: ts, exitPrice: exitPx, size: pos.size, pricePnl, fundingPnl,
      pnl: pricePnl + fundingPnl, reason });
    equity += pricePnl + fundingPnl;
    pos = null;
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    history.push(c);

    if (pos) {
      const rate = c.signals?.["funding_rate"];
      if (rate !== null && rate !== undefined && isFinite(rate as number))
        pos.accruedFunding += pos.entryPrice * pos.size * (rate as number) * (pos.side === "short" ? 1 : -1);
    }

    if (pos) {
      const wickLoss = pos.side === "long"
        ? (pos.entryPrice - c.low)  / pos.entryPrice * 100
        : (c.high - pos.entryPrice) / pos.entryPrice * 100;
      if (wickLoss >= STOP_LOSS_PCT) {
        const stopPx = pos.side === "long"
          ? pos.entryPrice * (1 - STOP_LOSS_PCT / 100) * (1 - slip)
          : pos.entryPrice * (1 + STOP_LOSS_PCT / 100) * (1 + slip);
        closeTrade(stopPx, c.timestamp, "Stop-loss");
        equityCurve.push({ time: c.timestamp, equity });
        continue;
      }
    }

    const sig = strategy.onCandle(c as any, history as any);
    const fillOpen = candles[i + 1]?.open ?? c.close;

    if (sig?.side === "close" && pos) {
      closeTrade(pos.side === "long" ? fillOpen * (1 - slip) : fillOpen * (1 + slip), c.timestamp, sig.reason);
    } else if (sig?.side === "long" || sig?.side === "short") {
      if (pos && pos.side !== sig.side)
        closeTrade(pos.side === "long" ? fillOpen * (1 - slip) : fillOpen * (1 + slip), c.timestamp, "Reversed");
      if (!pos) {
        const entryPx = sig.side === "long" ? fillOpen * (1 + slip) : fillOpen * (1 - slip);
        pos = { side: sig.side, entryPrice: entryPx, entryTime: c.timestamp, size: SIZE_USD / entryPx, accruedFunding: 0 };
      }
    }
    equityCurve.push({ time: c.timestamp, equity });
  }

  if (pos && candles.length > 0) {
    const last = candles[candles.length - 1]!;
    closeTrade(pos.side === "long" ? last.close * (1 - slip) : last.close * (1 + slip), last.timestamp, "End");
    equityCurve.push({ time: last.timestamp, equity });
  }

  let sharpe = 0;
  if (trades.length > 1) {
    const rets = trades.map(t => t.pnl / (t.entryPrice * t.size));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
    const std = Math.sqrt(variance);
    sharpe = std > 1e-10 ? (mean / std) * Math.sqrt(rets.length) : 0;
  }

  let peak = EQUITY, maxDdPct = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? (peak - pt.equity) / peak * 100 : 0;
    if (dd > maxDdPct) maxDdPct = dd;
  }

  return { trades, equityCurve, sharpe, totalPnl: equity - EQUITY, maxDdPct };
}

function sharpeOf(trades: Trade[]): number {
  if (trades.length < 2) return NaN;
  const rets = trades.map(t => t.pnl / (t.entryPrice * t.size));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const std = Math.sqrt(variance);
  return std > 1e-10 ? (mean / std) * Math.sqrt(rets.length) : 0;
}

function pctile(arr: number[], q: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(Math.floor(q * s.length), s.length - 1)] ?? NaN;
}

function iso(ts: number) { return new Date(ts).toISOString().slice(0, 16); }

async function main() {
  // ── 1. Load signals ──────────────────────────────────────────────────────────
  const db = new Database(DB_PATH, { readonly: true });
  const rawRows = db.prepare(
    `SELECT sm.captured_at AS ts, sm.value AS value
     FROM snapshot_metrics sm JOIN snapshots s ON s.id=sm.snapshot_id
     WHERE s.symbol=? AND sm.metric_key=? ORDER BY sm.captured_at ASC`
  ).all(COIN, "funding_rate") as { ts: number; value: number | null }[];
  const hourlyRows = db.prepare(
    `SELECT ts_hour AS ts, avg_value AS value
     FROM snapshot_metrics_hourly WHERE symbol=? AND metric_key=? ORDER BY ts_hour ASC`
  ).all(COIN, "funding_rate") as { ts: number; value: number | null }[];
  db.close();

  const allSigs = [...hourlyRows, ...rawRows]
    .sort((a, b) => a.ts - b.ts)
    .filter((r, i, arr) => i === 0 || r.ts !== arr[i - 1]!.ts);
  console.log(`Signals: ${allSigs.length}  ${iso(allSigs[0]!.ts)} → ${iso(allSigs[allSigs.length - 1]!.ts)}`);

  // ── 2. Fetch candles ─────────────────────────────────────────────────────────
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
  type RC = Awaited<ReturnType<typeof info.candleSnapshot>>[number];

  process.stdout.write("Fetching candles... ");
  const probe = await info.candleSnapshot({ coin: COIN, interval: INTERVAL as "1h", startTime: allSigs[0]!.ts, endTime: Date.now() });
  const allRaw: RC[] = [...probe];
  let nextStart = probe[probe.length - 1]!.t + INTERVAL_MS;

  while (nextStart < Date.now()) {
    const raw = await info.candleSnapshot({ coin: COIN, interval: INTERVAL as "1h",
      startTime: nextStart, endTime: Math.min(nextStart + MAX_PAGE * INTERVAL_MS, Date.now()) });
    if (raw.length === 0) break;
    for (const c of raw) allRaw.push(c);
    const last = raw[raw.length - 1]!.t;
    if (last >= Date.now() - INTERVAL_MS) break;
    nextStart = last + INTERVAL_MS;
  }

  const seen = new Set<number>();
  const deduped = allRaw.filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; });
  const allCandles: BtCandle[] = deduped.map(c => ({
    timestamp: c.t, open: parseFloat(c.o as any), high: parseFloat(c.h as any),
    low: parseFloat(c.l as any), close: parseFloat(c.c as any), volume: parseFloat(c.v as any),
  }));
  console.log(`${allCandles.length} candles  ${iso(allCandles[0]!.timestamp)} → ${iso(allCandles[allCandles.length - 1]!.timestamp)}`);

  // ── 3. Attach signals + trim to last 2000 ────────────────────────────────────
  attachSignals(allCandles as any, new Map([["funding_rate", allSigs.map(r => ({ capturedAt: r.ts, value: r.value }))]]));

  const candles = allCandles.slice(-TOTAL_CANDLES);
  const sigCov  = candles.filter(c => c.signals?.["funding_rate"] != null).length;
  console.log(`WF window: ${candles.length} candles  ${iso(candles[0]!.timestamp)} → ${iso(candles[candles.length - 1]!.timestamp)}  signal coverage: ${sigCov}/${candles.length}\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q1  SIGNAL PROVENANCE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Backtest source : snapshot_metrics + snapshot_metrics_hourly");
  console.log("                    populated by SnapshotPoller via metaAndAssetCtxs().ctxs[i].funding");
  console.log("                    → PREDICTED next-period rate, NOT settled historical rate");
  console.log("  Live shadow bot : live-signal-provider.ts reads identical tables");
  console.log("                    staleness guard: NaN if capturedAt > 2h old → strategy abstains");
  console.log("  Verdict         : IDENTICAL source. No divergence. No re-run required.\n");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q2  COST MODEL");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  SLIPPAGE (backtest.ts:6, hardcoded) : ${SLIPPAGE} = ${(SLIPPAGE*100).toFixed(2)}% per fill, taker, both sides`);
  console.log(`  COMMISSION                           : ${COMMISSION} = ${(COMMISSION*100).toFixed(3)}% per side`);
  console.log(`  Round-trip on $${SIZE_USD} position        : ~$${(4*SLIPPAGE*SIZE_USD/2 + 2*COMMISSION*SIZE_USD).toFixed(3)}`);
  console.log(`    slippage ×2 fills: $${(2*SLIPPAGE*SIZE_USD).toFixed(3)}   commission ×2 sides: $${(2*COMMISSION*SIZE_USD).toFixed(3)}`);
  console.log(`  Commission formula : comm × size × (entryPrice + exitPrice)  — two-sided, charged at close`);
  console.log(`  Entry fill         : nextOpen × (1 ± SLIPPAGE)`);
  console.log(`  Exit fill          : nextOpen × (1 ∓ SLIPPAGE)`);
  console.log(`  Stop fill          : entryPrice × (1 ± stopPct%) × (1 ± SLIPPAGE)  — extra slip`);
  console.log(`  Funding accrual    : entryNotional × rate × direction  (constant notional)`);
  console.log(`  Position size      : $${SIZE_USD} fixed.  StopLoss: ${STOP_LOSS_PCT}%.  NO market impact, NO gap risk, NO liq model\n`);

  const base   = runBt(candles, { entryShortMultiple: 3, entryLongMultiple: 1 });
  const fee2x  = runBt(candles, { entryShortMultiple: 3, entryLongMultiple: 1 }, { commission: COMMISSION * 2 });
  const fee3x  = runBt(candles, { entryShortMultiple: 3, entryLongMultiple: 1 }, { commission: COMMISSION * 3 });
  const slip10 = runBt(candles, { entryShortMultiple: 3, entryLongMultiple: 1 }, { slippage: 0.001 });

  console.log(`  FEE SENSITIVITY  (k=3/kl=1, ${candles.length} candles):`);
  console.log(`  ${"Scenario".padEnd(24)} ${"Trades".padEnd(8)} ${"P&L $".padEnd(10)} ${"Sharpe".padEnd(8)} MaxDD%`);
  for (const [label, r] of [["Baseline (0.05%/side)", base], ["2× commission (0.10%)", fee2x], ["3× commission (0.15%)", fee3x], ["10bps slippage/fill", slip10]] as [string, RunResult][]) {
    console.log(`  ${label.padEnd(24)} ${r.trades.length.toString().padEnd(8)} $${r.totalPnl.toFixed(2).padEnd(9)} ${r.sharpe.toFixed(2).padEnd(8)} ${r.maxDdPct.toFixed(1)}%`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q3  SELECTION — 9-combo walk-forward");
  console.log(`    nWin=${N_WIN}  totalCandles=${TOTAL_CANDLES}  segSize=${SEG_SIZE}  ${N_WIN-1} OOS windows`);
  console.log(`    Grid: entryShortMultiple ∈ {3,5,8} × entryLongMultiple ∈ {1,2,3}  (9 combos)`);
  console.log(`    Fixed: defaultRate=1.25e-5  exitBand=6.25e-6  maxHoldBars=72  stopLossPct=6`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Grid uses runBt param names directly to avoid mismatch bugs
  const grid: { entryShortMultiple: number; entryLongMultiple: number }[] = [];
  for (const k of SHORT_MULTS) for (const kl of LONG_MULTS)
    grid.push({ entryShortMultiple: k, entryLongMultiple: kl });

  const oosMatrix: number[][] = grid.map(() => []);
  const winnerIdx: number[] = [];
  const stitchedOOS: Trade[] = [];

  for (let win = 1; win < N_WIN; win++) {
    const isEnd  = win * SEG_SIZE;
    const oosEnd = (win + 1) * SEG_SIZE;
    const isSlice = candles.slice(0, isEnd);
    const fullSl  = candles.slice(0, oosEnd);
    const oosTs   = candles[isEnd]!.timestamp;

    let bestIS = -Infinity, bestCI = 0;
    for (let ci = 0; ci < grid.length; ci++) {
      const r = runBt(isSlice, grid[ci]!);
      if (r.sharpe > bestIS) { bestIS = r.sharpe; bestCI = ci; }
    }
    winnerIdx.push(bestCI);

    const comboResults: RunResult[] = [];
    for (let ci = 0; ci < grid.length; ci++) {
      const r = runBt(fullSl, grid[ci]!);
      comboResults.push(r);
      const oos = r.trades.filter(t => t.entryTime >= oosTs);
      oosMatrix[ci]!.push(sharpeOf(oos));
    }
    for (const t of comboResults[bestCI]!.trades)
      if (t.entryTime >= oosTs) stitchedOOS.push(t);
  }

  const allOosSharpes = oosMatrix.flatMap(col => col.filter(s => isFinite(s)));
  console.log(`\n  Total combos evaluated: 9  Total OOS observations: ${allOosSharpes.length} (9 combos × ${N_WIN-1} windows)`);
  if (allOosSharpes.length > 0) {
    console.log(`  OOS Sharpe distribution across all combos:`);
    console.log(`    Min:${Math.min(...allOosSharpes).toFixed(2)}  P25:${pctile(allOosSharpes,0.25).toFixed(2)}  Med:${pctile(allOosSharpes,0.5).toFixed(2)}  P75:${pctile(allOosSharpes,0.75).toFixed(2)}  Max:${Math.max(...allOosSharpes).toFixed(2)}`);
  }

  console.log(`\n  PER-COMBO OOS SHARPE:`);
  console.log(`  ${"k/kl".padEnd(9)} ${"W1".padEnd(7)} ${"W2".padEnd(7)} ${"W3".padEnd(7)} ${"W4".padEnd(7)} ${"Mean".padEnd(7)} ${"Std".padEnd(7)} Selected?`);
  for (let ci = 0; ci < grid.length; ci++) {
    const { entryShortMultiple: k, entryLongMultiple: kl } = grid[ci]!;
    const sh   = oosMatrix[ci]!.filter(isFinite);
    const mean = sh.length > 0 ? sh.reduce((s, x) => s + x, 0) / sh.length : 0;
    const std  = sh.length > 0 ? Math.sqrt(sh.reduce((s, x) => s + (x - mean) ** 2, 0) / sh.length) : 0;
    const cols = oosMatrix[ci]!.map(s => (isFinite(s) ? s.toFixed(2) : " nan").padEnd(7)).join(" ");
    const wins = winnerIdx.map((w, i) => w === ci ? `W${i + 1}` : "").filter(Boolean).join(",");
    console.log(`  k${k}/kl${kl}`.padEnd(9) + ` ${cols} ${mean.toFixed(2).padEnd(7)} ${std.toFixed(2).padEnd(7)} ${wins || "-"}`);
  }

  console.log(`\n  IS-selected combo per window:`);
  for (let wi = 0; wi < winnerIdx.length; wi++) {
    const { entryShortMultiple: k, entryLongMultiple: kl } = grid[winnerIdx[wi]!]!;
    console.log(`    W${wi+1}: IS bars 0-${(wi+1)*SEG_SIZE-1}  OOS bars ${(wi+1)*SEG_SIZE}-${(wi+2)*SEG_SIZE-1}  → k=${k}, kl=${kl}`);
  }

  const stitchedSharpe = sharpeOf(stitchedOOS);
  const stitchedPnl    = stitchedOOS.reduce((s, t) => s + t.pnl, 0);
  console.log(`\n  Stitched OOS (IS-selected per window): ${stitchedOOS.length} trades  Sharpe=${stitchedSharpe.toFixed(2)}  P&L=$${stitchedPnl.toFixed(2)}\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q4  CONCENTRATION");
  console.log(`    Hourly P&L: k=3/kl=1 full run, OOS bars ${SEG_SIZE}-${TOTAL_CANDLES-1} (${TOTAL_CANDLES-SEG_SIZE} hours)`);
  console.log(`    Top-20 trades: stitched walk-forward OOS`);
  console.log("═══════════════════════════════════════════════════════════════");

  const eq = base.equityCurve;
  const oosBarPnls: number[] = [];
  const maxOosIdx = Math.min(eq.length, TOTAL_CANDLES);
  for (let i = SEG_SIZE; i < maxOosIdx; i++)
    oosBarPnls.push(eq[i]!.equity - eq[i - 1]!.equity);

  const totalPnl4 = oosBarPnls.reduce((s, x) => s + x, 0);
  const posHours  = oosBarPnls.filter(x => x > 0).length;
  const sortedDesc = [...oosBarPnls].sort((a, b) => b - a);

  console.log(`\n  OOS hours: ${oosBarPnls.length}  Total OOS P&L: $${totalPnl4.toFixed(2)}  Positive hours: ${posHours} (${(posHours/oosBarPnls.length*100).toFixed(1)}%)`);
  for (const p of [1, 5, 10]) {
    const n    = Math.max(1, Math.ceil(oosBarPnls.length * p / 100));
    const sum  = sortedDesc.slice(0, n).reduce((s, x) => s + x, 0);
    const share = totalPnl4 !== 0 ? (sum / totalPnl4 * 100).toFixed(1) : "n/a";
    console.log(`  Top ${p.toString().padStart(2)}% (${n.toString().padStart(4)} hours): $${sum.toFixed(2)} = ${share}% of OOS P&L`);
  }

  const top20 = [...stitchedOOS].sort((a, b) => b.pnl - a.pnl).slice(0, 20);
  let runPnl = 0;
  const stitchedTotal = stitchedOOS.reduce((s, t) => s + t.pnl, 0);
  console.log(`\n  TOP 20 OOS TRADES (stitched WF OOS):`);
  console.log(`  ${"#".padEnd(3)} ${"Side".padEnd(6)} ${"Entry".padEnd(17)} ${"Exit".padEnd(17)} ${"P&L".padEnd(10)} Cumul`);
  for (let i = 0; i < top20.length; i++) {
    const t = top20[i]!;
    runPnl += t.pnl;
    const cumPct = stitchedTotal !== 0 ? ` (${(runPnl/stitchedTotal*100).toFixed(0)}%)` : "";
    console.log(`  ${(i+1).toString().padEnd(3)} ${t.side.padEnd(6)} ${iso(t.entryTime).padEnd(17)} ${iso(t.exitTime).padEnd(17)} $${t.pnl.toFixed(2).padEnd(9)} $${runPnl.toFixed(2)}${cumPct}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q5  REGIME  (Swing Advisor daily: 1h candles, EMA 8/21, 168-bar lookback)");
  console.log(`    OOS bars ${SEG_SIZE}-${TOTAL_CANDLES-1} classified; trades from k=3/kl=1 full run`);
  console.log("═══════════════════════════════════════════════════════════════");

  type Regime = "CALM-TRENDING" | "HIGH-VOL" | "CHOP";
  const barRegime: Regime[] = [];

  for (let i = SEG_SIZE; i < TOTAL_CANDLES; i++) {
    const slice   = candles.slice(Math.max(0, i - 167), i + 1);
    const swSlice = slice.map(c => ({ t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
    const res     = classifyRegime(swSlice as any, DAILY_CFG as any);
    barRegime.push(res.regime as Regime);
  }

  const regimeCount: Record<Regime, number> = { "CALM-TRENDING": 0, "HIGH-VOL": 0, "CHOP": 0 };
  for (const r of barRegime) regimeCount[r]++;

  const tsToBarOosIdx = new Map<number, number>();
  for (let i = SEG_SIZE; i < TOTAL_CANDLES; i++)
    tsToBarOosIdx.set(candles[i]!.timestamp, i - SEG_SIZE);

  const regimeTrades: Record<Regime, Trade[]> = { "CALM-TRENDING": [], "HIGH-VOL": [], "CHOP": [] };
  const oosTrades = base.trades.filter(t => t.entryTime >= candles[SEG_SIZE]!.timestamp);
  for (const t of oosTrades) {
    const idx = tsToBarOosIdx.get(t.entryTime);
    if (idx !== undefined) regimeTrades[barRegime[idx]!]!.push(t);
  }

  console.log(`\n  MaxDD% = cumulative P&L sequence starting from $0 (not absolute equity — can exceed 100%)`);
  console.log(`  ${"Regime".padEnd(16)} ${"Bars".padEnd(6)} ${"Trades".padEnd(8)} ${"P&L $".padEnd(11)} ${"Sharpe".padEnd(8)} MaxDD%`);
  for (const reg of ["CALM-TRENDING", "HIGH-VOL", "CHOP"] as Regime[]) {
    const rt  = regimeTrades[reg];
    const bc  = regimeCount[reg];
    const pnl = rt.reduce((s, t) => s + t.pnl, 0);
    const sh  = sharpeOf(rt);
    let eq2 = 0, pk = 0, dd = 0;
    for (const t of [...rt].sort((a, b) => a.entryTime - b.entryTime)) {
      eq2 += t.pnl; if (eq2 > pk) pk = eq2;
      if (pk > 0) { const d = (pk - eq2) / pk * 100; if (d > dd) dd = d; }
    }
    console.log(
      `  ${reg.padEnd(16)} ${bc.toString().padEnd(6)} ${rt.length.toString().padEnd(8)} ` +
      `$${pnl.toFixed(2).padEnd(10)} ${(rt.length >= 2 && isFinite(sh) ? sh.toFixed(2) : "n/a").padEnd(8)} ${rt.length > 0 ? dd.toFixed(1) + "%" : "n/a"}`
    );
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q6  DRAWDOWN AND EXECUTION  (full 2000-candle run, k=3/kl=1)");
  console.log("═══════════════════════════════════════════════════════════════");

  const eqCurve = base.equityCurve;
  // Track running peak; save peak index AT THE MOMENT max drawdown is set,
  // so peak always precedes trough chronologically.
  let ddRunPk = EQUITY, ddRunPkIdx = 0, ddPct = 0, ddPkIdx = 0, ddTrIdx = 0;
  for (let i = 0; i < eqCurve.length; i++) {
    const e = eqCurve[i]!.equity;
    if (e > ddRunPk) { ddRunPk = e; ddRunPkIdx = i; }
    const d = ddRunPk > 0 ? (ddRunPk - e) / ddRunPk * 100 : 0;
    if (d > ddPct) { ddPct = d; ddTrIdx = i; ddPkIdx = ddRunPkIdx; }
  }
  const ddPkEq = eqCurve[ddPkIdx]!;
  const ddTrEq = eqCurve[ddTrIdx]!;
  let recIdx = -1;
  for (let i = ddTrIdx + 1; i < eqCurve.length; i++) {
    if (eqCurve[i]!.equity >= ddPkEq.equity) { recIdx = i; break; }
  }

  console.log(`\n  Max drawdown:`);
  console.log(`    Peak:     ${iso(ddPkEq.time)}  equity=$${ddPkEq.equity.toFixed(2)}`);
  console.log(`    Trough:   ${iso(ddTrEq.time)}  equity=$${ddTrEq.equity.toFixed(2)}`);
  console.log(`    Drawdown: ${ddPct.toFixed(2)}%   duration: ${ddTrIdx - ddPkIdx} hours peak-to-trough`);
  if (recIdx >= 0)
    console.log(`    Recovery: ${iso(eqCurve[recIdx]!.time)}  (${recIdx - ddTrIdx} hours after trough)`);
  else
    console.log(`    Recovery: NOT RECOVERED within backtest window`);

  const worstTrade = base.trades.length > 0
    ? base.trades.reduce((w, t) => t.pnl < w.pnl ? t : w)
    : null;
  const worstPct = worstTrade ? Math.abs(worstTrade.pnl) / (worstTrade.entryPrice * worstTrade.size) * 100 : 0;
  console.log(`\n  Worst single trade:  $${worstTrade?.pnl.toFixed(2) ?? "n/a"}  (${worstPct.toFixed(2)}% of notional, side=${worstTrade?.side})`);

  console.log(`\n  Liquidation model:   NOT MODELLED`);
  console.log(`    Only risk limit: ${STOP_LOSS_PCT}% stop-loss per trade (enforced by backtest engine).`);
  console.log(`    Fixed $${SIZE_USD} notional on $${EQUITY} equity — 0.5× notional/equity ratio at entry.`);
  console.log(`    Margin is never checked; drawdown can exceed any initial margin without liquidation.`);
  const liqLev = ddPct > 0 ? (100 / ddPct).toFixed(1) : "∞";
  console.log(`\n  Leverage at which max drawdown triggers liquidation: ${liqLev}×`);
  console.log(`    (${liqLev}× leverage → initial margin = equity/${liqLev}; a ${ddPct.toFixed(2)}% equity drawdown wipes it)`);
  console.log();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("AUDIT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(console.error);
