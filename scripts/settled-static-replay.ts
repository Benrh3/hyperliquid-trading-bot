#!/usr/bin/env npx tsx
/**
 * settled-static-replay.ts
 *
 * STEP 1  Apply migration + backfill settled_funding from dYdX and HL
 *         historicalFunding endpoints.
 * STEP 2  Verify the HL series (source, network, median check).
 * STEP 3  Sign and correlation canary on inner-joined hours.
 * STEP 4  Static short-HL/long-dYdX replay: monthly, rolling, worst day,
 *         longest negative run, reversed position.
 * STEP 5  Sensitivity: fees doubled, quarterly round-trip, first/second half.
 *
 * Read-only from the bot perspective — only writes to settled_funding.
 * Safe to run against the live database while the bot is running.
 *
 * Usage:
 *   cd ~/hyperliquid-trading-bot
 *   npx tsx scripts/settled-static-replay.ts            # uses cached DB data if fresh
 *   npx tsx scripts/settled-static-replay.ts --refetch  # force re-download
 *   npx tsx scripts/settled-static-replay.ts --no-fetch # skip all API calls
 */

import Database from "better-sqlite3";
import { resolve } from "path";

const DB_PATH  = process.env["DB_PATH"] ?? resolve(process.cwd(), "data/bot.db");
const NOTIONAL = 1_000;
const TAKER_FEE  = 0.0005;
const ENTRY_FEE  = 2 * TAKER_FEE * NOTIONAL;   // $1.00 — two legs to open
const FLIP_FEE   = 4 * TAKER_FEE * NOTIONAL;   // $2.00 — four fills on direction change

const HOUR_MS    = 3_600_000;
const DAY_MS     = 24 * HOUR_MS;
const YEAR_HOURS = 8_760;

const argv      = process.argv.slice(2);
const REFETCH   = argv.includes("--refetch");
const NO_FETCH  = argv.includes("--no-fetch");

const NOW_MS    = Date.now();
const NOW_HOUR  = Math.floor(NOW_MS / HOUR_MS) * HOUR_MS;

// ── DB + migration ────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS settled_funding (
    venue           TEXT    NOT NULL,
    coin            TEXT    NOT NULL,
    hour_ts         INTEGER NOT NULL,
    rate            REAL    NOT NULL,
    source_endpoint TEXT    NOT NULL,
    fetched_at      INTEGER NOT NULL,
    PRIMARY KEY (venue, coin, hour_ts)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_sf_coin_ts ON settled_funding (coin, hour_ts);
`);
console.log("[migration] settled_funding table ready\n");

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s[Math.max(0, Math.floor((p / 100) * (s.length - 1)))];
}

function median(arr: number[]): number { return pct(arr, 50); }

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; sx += dx * dx; sy += dy * dy;
  }
  return sx === 0 || sy === 0 ? NaN : num / Math.sqrt(sx * sy);
}

function fmtUsd(v: number, w = 10): string {
  if (!Number.isFinite(v)) return "N/A".padStart(w);
  return ((v >= 0 ? "+" : "") + v.toFixed(2)).padStart(w);
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function isoMonth(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function hr(len: number, ch = "─"): string { return ch.repeat(len); }

// ── DB helpers ────────────────────────────────────────────────────────────────

interface DbRow { hour_ts: number; rate: number }

function rowCount(venue: string, coin: string): number {
  return (db.prepare<[string, string], { n: number }>(
    "SELECT COUNT(*) AS n FROM settled_funding WHERE venue=? AND coin=?"
  ).get(venue, coin)?.n) ?? 0;
}

function maxHourTs(venue: string, coin: string): number {
  return (db.prepare<[string, string], { m: number | null }>(
    "SELECT MAX(hour_ts) AS m FROM settled_funding WHERE venue=? AND coin=?"
  ).get(venue, coin)?.m) ?? 0;
}

function loadSettled(venue: string, coin: string): DbRow[] {
  return db.prepare<[string, string], DbRow>(
    "SELECT hour_ts, rate FROM settled_funding WHERE venue=? AND coin=? ORDER BY hour_ts"
  ).all(venue, coin);
}

const stmtUpsert = db.prepare<[string, string, number, number, string, number]>(
  "INSERT OR REPLACE INTO settled_funding " +
  "(venue, coin, hour_ts, rate, source_endpoint, fetched_at) VALUES (?,?,?,?,?,?)"
);

// ── Fetch: dYdX historicalFunding (paginated, newest first) ─────────────────

type FetchedRow = { hour_ts: number; rate: number };

async function fetchDydxFull(ticker: string): Promise<{ rows: FetchedRow[]; endpoint: string }> {
  const base = `https://indexer.dydx.trade/v4/historicalFunding/${encodeURIComponent(ticker)}`;
  const rows: FetchedRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    const url = cursor
      ? `${base}?limit=200&effectiveBeforeOrAt=${encodeURIComponent(cursor)}`
      : `${base}?limit=200`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error(`dYdX HTTP ${resp.status} — ${url}`);
    const data = await resp.json() as {
      historicalFunding?: Array<{ effectiveAt: string; rate: string }>
    };
    const entries = data.historicalFunding ?? [];

    for (const e of entries) {
      if (seen.has(e.effectiveAt)) continue;
      seen.add(e.effectiveAt);
      const rate = parseFloat(e.rate);
      if (!Number.isFinite(rate)) continue;
      // Floor to exact hour boundary — dYdX effectiveAt can have sub-second ms offsets
      const hour_ts = Math.floor(new Date(e.effectiveAt).getTime() / HOUR_MS) * HOUR_MS;
      rows.push({ hour_ts, rate });
    }

    page++;
    if (page % 25 === 0) process.stderr.write(`  dYdX ${ticker}: page ${page}, ${rows.length} unique\n`);
    if (entries.length < 200) break;
    cursor = entries[entries.length - 1]!.effectiveAt;
    await sleep(150);
  }

  process.stderr.write(`  dYdX ${ticker}: ${page} pages, ${rows.length} unique rows\n`);
  return { rows, endpoint: base };
}

// ── Fetch: HL fundingHistory (paginated, oldest first) ───────────────────────

async function fetchHLIncremental(
  coin: string, startMs: number
): Promise<{ rows: FetchedRow[]; endpoint: string }> {
  const url      = "https://api.hyperliquid.xyz/info";
  const endpoint = `${url} [POST type=fundingHistory coin=${coin}]`;
  const rows: FetchedRow[] = [];
  let startTime  = startMs;
  let page       = 0;

  while (true) {
    // Fetch with retry on 429
    let resp: Response;
    let retries = 0;
    while (true) {
      resp = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ type: "fundingHistory", coin, startTime }),
      });
      if (resp.status === 429) {
        retries++;
        const wait = retries * 10_000;
        process.stderr.write(`  HL ${coin}: 429 rate limit, waiting ${wait / 1000}s (retry ${retries})\n`);
        await sleep(wait);
        continue;
      }
      if (!resp.ok) throw new Error(`HL HTTP ${resp.status}`);
      break;
    }

    const entries = await resp.json() as Array<{ fundingRate: string; time: number }>;

    for (const e of entries) {
      const rate = parseFloat(e.fundingRate);
      if (!Number.isFinite(rate)) continue;
      // Floor to exact hour boundary — HL time field can have sub-ms offsets
      const hour_ts = Math.floor(e.time / HOUR_MS) * HOUR_MS;
      rows.push({ hour_ts, rate });
    }

    page++;
    if (rows.length % 5_000 === 0 && entries.length > 0) {
      process.stderr.write(`  HL ${coin}: ${rows.length} rows\n`);
    }
    if (entries.length < 500) break;
    startTime = entries[entries.length - 1]!.time + 1;

    // Longer pause every 20 pages to avoid sustained rate-limit pressure
    await sleep(page % 20 === 0 ? 3_000 : 300);
  }

  process.stderr.write(`  HL ${coin}: ${rows.length} rows fetched\n`);
  return { rows, endpoint };
}

// ── Populate settled_funding (idempotent) ─────────────────────────────────────

async function populate(
  venue:    string,
  coin:     string,
  fetchFn:  (fromMs: number) => Promise<{ rows: FetchedRow[]; endpoint: string }>,
  fullFetchAlways = false,   // dYdX pagination is backwards — can't do incremental
): Promise<void> {
  const currentMax = maxHourTs(venue, coin);
  const isFresh    = currentMax >= NOW_HOUR - 2 * HOUR_MS;

  if (NO_FETCH || (!REFETCH && isFresh)) {
    const n    = rowCount(venue, coin);
    const maxI = currentMax ? new Date(currentMax).toISOString() : "none";
    console.log(`[fetch] ${venue}/${coin}: ${n} rows in DB, maxTs=${maxI} — cached`);
    return;
  }

  // On --refetch, wipe existing rows first so stale non-floored hour_ts values
  // (different from freshly-floored ones) don't accumulate alongside new rows.
  if (REFETCH && currentMax > 0) {
    db.prepare<[string, string]>("DELETE FROM settled_funding WHERE venue=? AND coin=?")
      .run(venue, coin);
    console.log(`[fetch] ${venue}/${coin}: cleared existing rows for re-fetch`);
  }

  const fromMs = fullFetchAlways || currentMax === 0 || REFETCH ? 1_609_459_200_000 : currentMax + 1;
  const fromLabel = fromMs === 1_609_459_200_000
    ? "full history from 2021-01-01"
    : `incremental from ${new Date(fromMs).toISOString()}`;
  console.log(`[fetch] ${venue}/${coin}: ${fromLabel}`);

  const { rows, endpoint } = await fetchFn(fromMs);
  console.log(`[fetch] ${venue}/${coin}: ${rows.length} rows fetched, inserting...`);

  db.transaction(() => {
    for (const r of rows) stmtUpsert.run(venue, coin, r.hour_ts, r.rate, endpoint, NOW_MS);
  })();

  const n    = rowCount(venue, coin);
  const maxI = new Date(maxHourTs(venue, coin)).toISOString();
  console.log(`[fetch] ${venue}/${coin}: ${n} rows in DB after insert, maxTs=${maxI}`);
}

// ── STEP 1: Backfill ──────────────────────────────────────────────────────────

await populate("dydx",        "BTC",  () => fetchDydxFull("BTC-USD"),  true);
await populate("dydx",        "HYPE", () => fetchDydxFull("HYPE-USD"), true);
await populate("hyperliquid", "BTC",  (from) => fetchHLIncremental("BTC",  from));
await populate("hyperliquid", "HYPE", (from) => fetchHLIncremental("HYPE", from));

console.log();

// ── STEP 2: Verify HL series ──────────────────────────────────────────────────

const LINE = hr(80);
console.log(LINE);
console.log("STEP 2 — Verify HL series");
console.log(LINE + "\n");

console.log("What the existing funding_samples / funding_samples_hourly contain:");
console.log("  Table:   funding_samples (raw ~7d) + funding_samples_hourly (rollup ~70d)");
console.log("  Source:  metaAndAssetCtxs() → ctx.funding (HL predicted next-period rate)");
console.log("           perpetualMarkets.nextFundingRate (dYdX predicted next-period rate)");
console.log("  Code:    funding-matrix.ts:340 `const rate = safeNum(ctx.funding)` (HL)");
console.log("           funding-matrix.ts:392 `const rate = safeNum(mkt.nextFundingRate)` (dYdX)");
console.log("           → logger.ts:153 INSERT INTO funding_samples via stmtInsertFunding");
console.log("  Network: mainnet (funding-matrix.ts:43 — testnet returns zero rates)");
console.log("  Type:    PREDICTED — the rate expected for the current hour, not the");
console.log("           settled payment that already cleared at the last hour boundary");
console.log("  Coverage: ~70 days hourly (rollup) — NO 20-month backfill exists");
console.log();
console.log("settled_funding (this table, just populated):");
console.log("  Source:  HL: api.hyperliquid.xyz/info POST type=fundingHistory (MAINNET)");
console.log("           dYdX: indexer.dydx.trade/v4/historicalFunding (MAINNET)");
console.log("  Type:    SETTLED — each row is the rate that was actually applied to");
console.log("           positions at that hour boundary");
console.log();

for (const coin of ["BTC", "HYPE"]) {
  const rows  = loadSettled("hyperliquid", coin);
  const rates = rows.map((r) => r.rate);
  const n     = rows.length;
  const minTs = rows[0]?.hour_ts ?? 0;
  const maxTs = rows[rows.length - 1]?.hour_ts ?? 0;
  const med   = n > 0 ? median(rates) : 0;

  console.log(`HL ${coin} in settled_funding:`);
  console.log(`  Rows:    ${n}`);
  console.log(`  Window:  ${n > 0 ? new Date(minTs).toISOString() : "—"} — ${n > 0 ? new Date(maxTs).toISOString() : "—"}`);
  console.log(`  Median rate: ${med.toExponential(4)}/hr`);

  if (coin === "BTC") {
    // HL interest component = 0.01%/8h = 1.25e-5/hr; median should be near this.
    const deviation = Math.abs(med - 1.25e-5);
    if (deviation > 8e-6) {
      console.log(`  *** WARNING: median ${med.toExponential(4)} deviates from 1.25e-5 interest floor by ${deviation.toExponential(2)}`);
      console.log(`  *** Possible cause: source is predicted rates (not settled) or unit error. Halting.`);
      process.exit(1);
    } else {
      console.log(`  Median vs HL interest component (1.25e-5): within tolerance — OK`);
    }
  }
  console.log();
}

// ── STEP 3: Correlation canary ────────────────────────────────────────────────

console.log(LINE);
console.log("STEP 3 — Sign and correlation canary");
console.log(LINE + "\n");

for (const coin of ["BTC", "HYPE"]) {
  const hlMap  = new Map(loadSettled("hyperliquid", coin).map((r) => [r.hour_ts, r.rate]));
  const dyRows = loadSettled("dydx", coin);

  const joined: { ts: number; hl: number; dy: number }[] = [];
  for (const dr of dyRows) {
    const hl = hlMap.get(dr.hour_ts);
    if (hl !== undefined) joined.push({ ts: dr.hour_ts, hl, dy: dr.rate });
  }

  if (joined.length === 0) {
    console.log(`${coin}: NO inner-joined rows — check data. Halting.`);
    process.exit(1);
  }

  const hlRates = joined.map((r) => r.hl);
  const dyRates = joined.map((r) => r.dy);
  const r       = pearson(hlRates, dyRates);
  const hlMed   = median(hlRates);
  const hlP05   = pct(hlRates,  5);
  const hlP95   = pct(hlRates, 95);
  const dyMed   = median(dyRates);
  const dyP05   = pct(dyRates,  5);
  const dyP95   = pct(dyRates, 95);

  // Annual rate at median: median * 24h * 365d * 100 = %/yr
  const hlAnn = hlMed * YEAR_HOURS * 100;
  const dyAnn = dyMed * YEAR_HOURS * 100;

  console.log(`${coin} — ${joined.length} inner-joined hours`);
  console.log(`  Window: ${isoDate(joined[0].ts)} — ${isoDate(joined[joined.length - 1].ts)}`);
  console.log(`  Pearson r (HL vs dYdX): ${r.toFixed(4)}`);

  if (r < 0) {
    console.log("  *** STOP: negative Pearson correlation — sign inversion detected.");
    console.log("  *** One venue's rate sign is inverted. Fix before proceeding.");
    process.exit(1);
  }

  console.log(`  HL  — median ${hlMed.toExponential(4)}, p05 ${hlP05.toExponential(4)}, p95 ${hlP95.toExponential(4)}`);
  console.log(`  dYdX — median ${dyMed.toExponential(4)}, p05 ${dyP05.toExponential(4)}, p95 ${dyP95.toExponential(4)}`);
  console.log(`  Unit check — median HL  : ${hlMed.toExponential(4)}/hr × 8760 hr/yr × 100 = ${hlAnn.toFixed(2)}%/yr`);
  console.log(`             — median dYdX: ${dyMed.toExponential(4)}/hr × 8760 hr/yr × 100 = ${dyAnn.toFixed(2)}%/yr`);
  console.log(`  Both series are hourly fractions of notional (${NOTIONAL === 1 ? "1.0" : NOTIONAL} × rate × 1hr = $/hr).`);
  console.log();
}

// ── STEP 4 + 5: Replay and sensitivity ───────────────────────────────────────

function runCoin(coin: string): void {
  console.log(LINE);
  console.log(`STEP 4 — Settled static replay: ${coin}`);
  console.log(LINE + "\n");

  // Inner join
  const hlMap  = new Map(loadSettled("hyperliquid", coin).map((r) => [r.hour_ts, r.rate]));
  const hlTs   = new Set(hlMap.keys());
  const dyRows = loadSettled("dydx", coin);
  const dyTs   = new Set(dyRows.map((r) => r.hour_ts));

  const hlOnlyCount = [...hlTs].filter((t) => !dyTs.has(t)).length;
  const dyOnlyCount = dyRows.filter((r) => !hlTs.has(r.hour_ts)).length;

  const joined: { ts: number; hl: number; dy: number }[] = [];
  for (const dr of dyRows) {
    const hl = hlMap.get(dr.hour_ts);
    if (hl !== undefined) joined.push({ ts: dr.hour_ts, hl, dy: dr.rate });
  }
  joined.sort((a, b) => a.ts - b.ts);

  if (joined.length === 0) { console.log(`${coin}: no matched hours. Skipping.`); return; }

  const firstTs  = joined[0]!.ts;
  const lastTs   = joined[joined.length - 1]!.ts;
  const windowH  = (lastTs - firstTs) / HOUR_MS;
  const windowYr = windowH / YEAR_HOURS;

  console.log(`Inner join:`);
  console.log(`  Matched hours:  ${joined.length}`);
  console.log(`  Window:         ${new Date(firstTs).toISOString()} — ${new Date(lastTs).toISOString()} (${windowH.toFixed(0)}h)`);
  console.log(`  Excluded HL-only hours:   ${hlOnlyCount}`);
  console.log(`  Excluded dYdX-only hours: ${dyOnlyCount}`);
  console.log();

  // Per-hour net: short HL / long dYdX → collect HL rate, pay dYdX rate
  // net_per_hour = (rate_HL − rate_dYdX) × NOTIONAL
  const hourlyNets = joined.map((r) => (r.hl - r.dy) * NOTIONAL);

  // Prefix sums for rolling window computation
  const prefix = [0];
  for (const v of hourlyNets) prefix.push(prefix[prefix.length - 1]! + v);

  const grossFwd   = prefix[prefix.length - 1]!;
  const netFwd     = grossFwd - ENTRY_FEE;
  const annPct     = (netFwd / NOTIONAL) / windowYr * 100;

  // Reversed: long HL / short dYdX
  const grossRev   = -grossFwd;
  const netRev     = grossRev - ENTRY_FEE;
  const annPctRev  = (netRev / NOTIONAL) / windowYr * 100;

  // ── Full period ────────────────────────────────────────────────────────────
  console.log("Full period (short HL / long dYdX):");
  console.log(`  Gross:           ${fmtUsd(grossFwd)}`);
  console.log(`  Entry fee:       ${fmtUsd(-ENTRY_FEE)} ($${ENTRY_FEE.toFixed(2)} — 2 fills × $${NOTIONAL} × ${TAKER_FEE})`);
  console.log(`  Net:             ${fmtUsd(netFwd)}`);
  console.log(`  Net annualised:  ${annPct.toFixed(3)}% of $${NOTIONAL} notional`);
  console.log();
  console.log("Full period (reversed: long HL / short dYdX):");
  console.log(`  Gross:           ${fmtUsd(grossRev)}`);
  console.log(`  Entry fee:       ${fmtUsd(-ENTRY_FEE)}`);
  console.log(`  Net:             ${fmtUsd(netRev)}`);
  console.log(`  Net annualised:  ${annPctRev.toFixed(3)}% of $${NOTIONAL} notional`);
  console.log();

  // ── Monthly table ─────────────────────────────────────────────────────────
  const monthMap = new Map<string, { gross: number; hours: number }>();
  for (let i = 0; i < joined.length; i++) {
    const key  = isoMonth(joined[i]!.ts);
    const prev = monthMap.get(key) ?? { gross: 0, hours: 0 };
    monthMap.set(key, { gross: prev.gross + hourlyNets[i]!, hours: prev.hours + 1 });
  }

  const monthKeys   = [...monthMap.keys()].sort();
  let posMonths     = 0;
  const totalMonths = monthKeys.length;

  const mHdr = `  ${"Month".padEnd(10)} ${"Hours".padStart(6)} ${"Gross$".padStart(10)}`;
  console.log("Monthly gross (short HL / long dYdX):");
  console.log(mHdr);
  console.log("  " + hr(28));
  for (const key of monthKeys) {
    const { gross, hours } = monthMap.get(key)!;
    if (gross > 0) posMonths++;
    console.log(`  ${key.padEnd(10)} ${String(hours).padStart(6)} ${fmtUsd(gross, 10)}`);
  }
  console.log("  " + hr(28));
  console.log(`  ${totalMonths} months — ${posMonths} positive (${((posMonths / totalMonths) * 100).toFixed(0)}%)`);
  console.log();

  // ── Rolling worst windows ──────────────────────────────────────────────────
  function worstWindow(windowHours: number): { worst: number; start: string; end: string } {
    if (joined.length < windowHours) return { worst: NaN, start: "N/A", end: "N/A" };
    let worst    = Infinity;
    let worstEnd = windowHours;
    for (let i = windowHours; i < prefix.length; i++) {
      const v = prefix[i]! - prefix[i - windowHours]!;
      if (v < worst) { worst = v; worstEnd = i; }
    }
    return {
      worst,
      start: isoDate(joined[worstEnd - windowHours]!.ts),
      end:   isoDate(joined[worstEnd - 1]!.ts),
    };
  }

  const w30 = worstWindow(30 * 24);
  const w90 = worstWindow(90 * 24);

  console.log("Rolling windows (gross, no entry fee):");
  console.log(`  Worst 30-day:  ${fmtUsd(w30.worst)} (${w30.start} — ${w30.end})`);
  console.log(`  Worst 90-day:  ${fmtUsd(w90.worst)} (${w90.start} — ${w90.end})`);
  console.log();

  // ── Worst single day ───────────────────────────────────────────────────────
  const dayMap = new Map<string, number>();
  for (let i = 0; i < joined.length; i++) {
    const key = isoDate(joined[i]!.ts);
    dayMap.set(key, (dayMap.get(key) ?? 0) + hourlyNets[i]!);
  }
  const dayEntries = [...dayMap.entries()];
  const worstDay   = dayEntries.reduce((a, b) => b[1] < a[1]! ? b : a, dayEntries[0]!);
  const bestDay    = dayEntries.reduce((a, b) => b[1] > a[1]! ? b : a, dayEntries[0]!);

  console.log(`  Worst single day: ${worstDay[0]} ${fmtUsd(worstDay[1])}`);
  console.log(`  Best  single day: ${bestDay[0]}  ${fmtUsd(bestDay[1])}`);
  console.log();

  // ── Longest continuous negative-spread run ────────────────────────────────
  let longestNeg = 0, curNeg = 0, negStart = 0;
  let longestNegStartTs = 0, longestNegEndTs = 0;

  for (let i = 0; i < joined.length; i++) {
    const spread = joined[i]!.hl - joined[i]!.dy;
    if (spread < 0) {
      if (curNeg === 0) negStart = i;
      curNeg++;
      if (curNeg > longestNeg) {
        longestNeg = curNeg;
        longestNegStartTs = joined[negStart]!.ts;
        longestNegEndTs   = joined[i]!.ts;
      }
    } else {
      curNeg = 0;
    }
  }

  console.log(`Longest continuous negative spread: ${longestNeg} hours`);
  if (longestNeg > 0) {
    const lossInRun = hourlyNets.slice(
      joined.findIndex((r) => r.ts === longestNegStartTs),
      joined.findIndex((r) => r.ts === longestNegEndTs) + 1,
    ).reduce((a, b) => a + b, 0);
    console.log(`  ${new Date(longestNegStartTs).toISOString()} — ${new Date(longestNegEndTs).toISOString()}`);
    console.log(`  Gross during run: ${fmtUsd(lossInRun)}`);
  }
  console.log();

  // ── STEP 5: Sensitivity ───────────────────────────────────────────────────
  console.log(hr(64));
  console.log(`STEP 5 — Sensitivity: ${coin}`);
  console.log(hr(64) + "\n");

  const midIdx = Math.floor(joined.length / 2);
  const midTs  = joined[midIdx]!.ts;
  const halfH1Nets = hourlyNets.slice(0, midIdx);
  const halfH2Nets = hourlyNets.slice(midIdx);
  const grossH1    = halfH1Nets.reduce((a, b) => a + b, 0);
  const grossH2    = halfH2Nets.reduce((a, b) => a + b, 0);

  // Quarterly round-trip: 4 fills ($2) every 90 days
  const quartersInWindow  = Math.floor(windowH / (90 * 24));
  const quarterlyFee      = quartersInWindow * FLIP_FEE;
  const quarterlyFeeLabel = `${quartersInWindow}q × $${FLIP_FEE.toFixed(2)}`;

  const scenarios: [string, number, number][] = [
    ["Base (1× fees)",                         grossFwd, ENTRY_FEE],
    ["Fees doubled (2× entry fee)",             grossFwd, ENTRY_FEE * 2],
    [`+quarterly rebalance (${quarterlyFeeLabel})`, grossFwd, ENTRY_FEE + quarterlyFee],
    [`First half  (−${isoMonth(midTs)})`,       grossH1,  ENTRY_FEE],
    [`Second half (${isoMonth(midTs)}−)`,       grossH2,  ENTRY_FEE],
  ];

  const sHdr = `  ${"Scenario".padEnd(42)} ${"Gross$".padStart(10)} ${"Fees$".padStart(10)} ${"Net$".padStart(10)}`;
  console.log(sHdr);
  console.log("  " + hr(74));
  for (const [label, gross, fees] of scenarios) {
    const net = gross - fees;
    console.log(
      `  ${label.padEnd(42)} ${fmtUsd(gross, 10)} ${fmtUsd(-fees, 10)} ${fmtUsd(net, 10)}`
    );
  }
  console.log("  " + hr(74));
  console.log();
}

for (const coin of ["BTC", "HYPE"]) {
  runCoin(coin);
}
