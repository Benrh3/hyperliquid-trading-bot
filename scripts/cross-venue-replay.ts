#!/usr/bin/env npx tsx
/**
 * Cross-venue funding-basis replay against the stored funding_spread_history.
 *
 * Read-only: queries data/bot.db but never writes to it and never touches any
 * bot state.  Safe to run against the live database while the bot is running.
 *
 * Policies evaluated for BTC and HYPE over the full stored window:
 *   (a) actual      — current flip logic: MIN_SPREAD gate on initial open,
 *                     FLIP_HURDLE × FLIP_COOLDOWN on subsequent direction changes.
 *   (b) static      — open short-HL / long-dYdX at the first clean row,
 *                     hold forever, never flip.
 *   (c) static+exit — as (b), but exit to flat when the net spread has been
 *                     continuously negative for N hours; re-enter when it has
 *                     been continuously positive for N hours.
 *                     Grid: N ∈ {6, 12, 24, 48, 72}.
 *
 * Costs applied exactly as the bot does:
 *   ENTRY_COST = 2 × TAKER_FEE = 0.001 × notional  ($1.00 per $1000)
 *   FLIP_COST  = 4 × TAKER_FEE = 0.002 × notional  ($2.00 per $1000)
 *
 * For static+exit each close-to-flat charges ENTRY_COST (2 fills) and each
 * reopen also charges ENTRY_COST, matching the bot's openLegs accounting.
 *
 * Accrual method: continuous time-weighted integral — sum of spread × Δt_hours
 * over each consecutive row interval.  The bot's bucket-accrual (exact hourly
 * boundaries) differs slightly but is negligible at ~60s resolution.
 *
 * Usage:
 *   cd ~/hyperliquid-trading-bot
 *   npx tsx scripts/cross-venue-replay.ts [--coin BTC] [--coin HYPE]
 *
 * Defaults to both coins.  Reads data/bot.db (or DB_PATH env override).
 */

import Database from "better-sqlite3";
import { resolve } from "path";

// ── Constants — exact copy from cross-venue-funding.ts, not imported ──────────
const TAKER_FEE    = 0.0005;
const ENTRY_COST   = 2 * TAKER_FEE;   // 0.001 — 2 fills per open or close
const FLIP_COST    = 4 * TAKER_FEE;   // 0.002 — 4 fills per direction change
const FLIP_HURDLE  = 1.3;
const MIN_SPREAD   = 0.00005;          // 0.005 %/hr
const FLIP_COOLDOWN_MS = 3_600_000;   // 1 hour
const NOTIONAL     = 1_000;           // $

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const coinArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--coin" && args[i + 1]) coinArgs.push(args[++i].toUpperCase());
}
const COINS = coinArgs.length ? coinArgs : ["BTC", "HYPE"];

// ── DB ────────────────────────────────────────────────────────────────────────
const dbPath = process.env["DB_PATH"] ?? resolve(process.cwd(), "data/bot.db");
const db = new Database(dbPath, { readonly: true });

interface Row { ts: number; hl: number | null; dydx: number | null }

/** Load rows from both raw and hourly-rollup tables, merged and sorted by ts. */
function loadRows(coin: string): Row[] {
  const raw = db.prepare<[string], Row>(
    "SELECT ts, hl_funding AS hl, dydx_funding AS dydx " +
    "FROM funding_spread_history WHERE coin = ? ORDER BY ts",
  ).all(coin);

  // Hourly rollup covers data older than 7 days
  const hourly = db.prepare<[string], Row>(
    "SELECT ts_hour AS ts, avg_hl_funding AS hl, avg_dydx_funding AS dydx " +
    "FROM funding_spread_history_hourly WHERE coin = ? ORDER BY ts_hour",
  ).all(coin);

  const rawTs = new Set(raw.map((r) => r.ts));
  const merged = [...hourly.filter((r) => !rawTs.has(r.ts)), ...raw];
  merged.sort((a, b) => a.ts - b.ts);
  return merged;
}

// ── Result type ───────────────────────────────────────────────────────────────
interface SimResult {
  policy:       string;
  coin:         string;
  windowH:      number;
  grossFunding: number;
  totalFees:    number;
  netPnl:       number;
  posChanges:   number;   // opens + flips + exits + re-entries
  posHours:     number;
  flatHours:    number;
}

function fmtUsd(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}`;
}

// ── Policy (a): replicate actual flip logic ───────────────────────────────────
function simulateActual(rows: Row[], coin: string): SimResult {
  let positioned  = false;
  let shortHl     = true;   // true = short HL / long dYdX; false = reversed
  let lastFlipMs  = 0;
  let grossFund   = 0;
  let fees        = 0;
  let posChanges  = 0;
  let posMs       = 0;
  let flatMs      = 0;
  const firstTs   = rows[0]?.ts ?? 0;
  const lastTs    = rows[rows.length - 1]?.ts ?? 0;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur  = rows[i];
    if (prev.hl === null || prev.dydx === null) continue;
    if (cur.hl  === null || cur.dydx  === null) continue;

    const dtMs    = cur.ts - prev.ts;
    const dtH     = dtMs / 3_600_000;
    const rateHl  = cur.hl;
    const rateDy  = cur.dydx;

    if (!positioned) {
      const spread = Math.abs(rateHl - rateDy);
      if (spread >= MIN_SPREAD) {
        shortHl    = rateHl >= rateDy;
        fees      += ENTRY_COST * NOTIONAL;
        posChanges++;
        lastFlipMs = cur.ts;
        positioned = true;
      }
      flatMs += dtMs;
    } else {
      // Accrue
      const sRate = shortHl ? rateHl : rateDy;
      const lRate = shortHl ? rateDy : rateHl;
      grossFund  += (sRate - lRate) * NOTIONAL * dtH;
      posMs      += dtMs;

      // Flip check: direction reversed?
      const newShortHl = rateHl >= rateDy;
      if (newShortHl !== shortHl) {
        const curSpread = (shortHl ? rateHl : rateDy) - (shortHl ? rateDy : rateHl);
        const newSpread = Math.abs(rateHl - rateDy);
        const elapsed   = cur.ts - lastFlipMs;
        const cooldownOk = lastFlipMs === 0 || elapsed >= FLIP_COOLDOWN_MS;
        const hurdleOk   = newSpread >= curSpread * FLIP_HURDLE;
        if (cooldownOk && hurdleOk) {
          shortHl    = newShortHl;
          fees      += FLIP_COST * NOTIONAL;
          posChanges++;
          lastFlipMs = cur.ts;
        }
      }
    }
  }

  const windowH = (lastTs - firstTs) / 3_600_000;
  return {
    policy: "actual", coin, windowH,
    grossFunding: grossFund, totalFees: fees,
    netPnl: grossFund - fees,
    posChanges, posHours: posMs / 3_600_000, flatHours: flatMs / 3_600_000,
  };
}

// ── Policy (b): static short-HL / long-dYdX, never flip, never close ─────────
function simulateStatic(rows: Row[], coin: string): SimResult {
  let positioned = false;
  let grossFund  = 0;
  let fees       = 0;
  let posMs      = 0;
  let flatMs     = 0;
  const firstTs  = rows[0]?.ts ?? 0;
  const lastTs   = rows[rows.length - 1]?.ts ?? 0;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur  = rows[i];
    if (prev.hl === null || prev.dydx === null) continue;
    if (cur.hl  === null || cur.dydx  === null) continue;

    const dtMs = cur.ts - prev.ts;
    const dtH  = dtMs / 3_600_000;

    if (!positioned) {
      // Open immediately on first clean row — no MIN_SPREAD gate (static policy)
      positioned = true;
      fees      += ENTRY_COST * NOTIONAL;
      flatMs    += dtMs;
    } else {
      // Always short HL / long dYdX regardless of which is higher
      grossFund += (cur.hl - cur.dydx) * NOTIONAL * dtH;
      posMs     += dtMs;
    }
  }

  const windowH = (lastTs - firstTs) / 3_600_000;
  return {
    policy: "static", coin, windowH,
    grossFunding: grossFund, totalFees: fees,
    netPnl: grossFund - fees,
    posChanges: 1, posHours: posMs / 3_600_000, flatHours: flatMs / 3_600_000,
  };
}

// ── Policy (c): static+exit with rolling N-hour negative-spread threshold ──────
//
// Rules:
//   - Open: wait for N continuous positive-spread hours, then open short-HL/long-dYdX.
//   - Hold: accrue (hl - dydx) × notional × dt.
//   - Exit: if spread has been continuously negative for N hours, close to flat
//     (ENTRY_COST for 2 fills).  On any positive tick the negative counter resets.
//   - Re-enter: wait for N continuous positive-spread hours again (ENTRY_COST).
function simulateStaticExit(rows: Row[], coin: string, exitHours: number): SimResult {
  const exitMs   = exitHours * 3_600_000;
  let positioned = false;
  let negRunMs   = 0;   // continuous negative-spread time while positioned
  let posRunMs   = 0;   // continuous positive-spread time while flat
  let grossFund  = 0;
  let fees       = 0;
  let posChanges = 0;
  let posMs      = 0;
  let flatMs     = 0;
  const firstTs  = rows[0]?.ts ?? 0;
  const lastTs   = rows[rows.length - 1]?.ts ?? 0;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur  = rows[i];
    if (prev.hl === null || prev.dydx === null) continue;
    if (cur.hl  === null || cur.dydx  === null) continue;

    const dtMs   = cur.ts - prev.ts;
    const dtH    = dtMs / 3_600_000;
    const spread = cur.hl - cur.dydx;   // positive = HL > dYdX (good for short-HL)

    if (!positioned) {
      flatMs += dtMs;
      if (spread > 0) {
        posRunMs += dtMs;
        if (posRunMs >= exitMs) {
          // Re-enter (or initial entry)
          fees      += ENTRY_COST * NOTIONAL;
          posChanges++;
          positioned = true;
          posRunMs   = 0;
          negRunMs   = 0;
        }
      } else {
        posRunMs = 0;   // reset on any non-positive tick
      }
    } else {
      posMs     += dtMs;
      grossFund += spread * NOTIONAL * dtH;

      if (spread < 0) {
        negRunMs += dtMs;
        if (negRunMs >= exitMs) {
          // Exit to flat
          fees      += ENTRY_COST * NOTIONAL;   // close 2 legs
          posChanges++;
          positioned = false;
          negRunMs   = 0;
          posRunMs   = 0;
        }
      } else {
        negRunMs = 0;   // reset on any non-negative tick
      }
    }
  }

  const windowH = (lastTs - firstTs) / 3_600_000;
  return {
    policy: `static+exit(${exitHours}h)`, coin, windowH,
    grossFunding: grossFund, totalFees: fees,
    netPnl: grossFund - fees,
    posChanges, posHours: posMs / 3_600_000, flatHours: flatMs / 3_600_000,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────────
const EXIT_NS = [6, 12, 24, 48, 72];
const results: SimResult[] = [];

for (const coin of COINS) {
  const rows = loadRows(coin);
  const clean = rows.filter((r) => r.hl !== null && r.dydx !== null);
  console.log(
    `\n${coin}: ${rows.length} total rows, ${clean.length} clean — ` +
    `window ${((rows[rows.length-1]!.ts - rows[0]!.ts) / 3_600_000).toFixed(1)}h`,
  );

  results.push(simulateActual(rows, coin));
  results.push(simulateStatic(rows, coin));
  for (const n of EXIT_NS) {
    results.push(simulateStaticExit(rows, coin, n));
  }
}

// ── Print table ───────────────────────────────────────────────────────────────
const colW = { policy: 22, coin: 5, window: 7, gross: 9, fees: 8, net: 9, changes: 9, posH: 8, flatH: 8 };

const header = [
  "Policy".padEnd(colW.policy),
  "Coin".padEnd(colW.coin),
  "Window".padStart(colW.window),
  "Gross$".padStart(colW.gross),
  "Fees$".padStart(colW.fees),
  "Net$".padStart(colW.net),
  "Changes".padStart(colW.changes),
  "PosH".padStart(colW.posH),
  "FlatH".padStart(colW.flatH),
].join("  ");

console.log("\n" + "─".repeat(header.length));
console.log(header);
console.log("─".repeat(header.length));

let lastCoin = "";
for (const r of results) {
  if (r.coin !== lastCoin && lastCoin !== "") console.log("");
  lastCoin = r.coin;

  const row = [
    r.policy.padEnd(colW.policy),
    r.coin.padEnd(colW.coin),
    `${r.windowH.toFixed(0)}h`.padStart(colW.window),
    fmtUsd(r.grossFunding).padStart(colW.gross),
    fmtUsd(-r.totalFees).padStart(colW.fees),
    fmtUsd(r.netPnl).padStart(colW.net),
    String(r.posChanges).padStart(colW.changes),
    r.posHours.toFixed(1).padStart(colW.posH),
    r.flatHours.toFixed(1).padStart(colW.flatH),
  ].join("  ");
  console.log(row);
}
console.log("─".repeat(header.length));
console.log(
  "\nNotes:\n" +
  "  Gross$   = time-weighted ∫ spread × notional dt  (positive = funding captured)\n" +
  "  Fees$    = total entry/flip costs (shown as negative)\n" +
  "  Net$     = Gross$ + Fees$\n" +
  "  Changes  = position state transitions (opens + flips/exits + re-entries)\n" +
  "  PosH     = hours spent positioned\n" +
  "  FlatH    = hours spent flat (including initial pre-open wait)\n" +
  "  actual   uses MIN_SPREAD gate for initial open; static policies do not\n" +
  "  static+exit N-hour threshold is continuous negative-spread duration\n",
);
