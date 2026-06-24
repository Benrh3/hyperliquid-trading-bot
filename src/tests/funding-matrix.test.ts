/**
 * Unit tests for funding-matrix builder logic and SQLite retention/rollup.
 *
 * No network calls. Matrix builder tests use in-memory Maps.
 * Retention tests use an in-memory better-sqlite3 database.
 */

import { describe, it, expect } from "vitest";
import {
  buildMatrixEntries,
  computeSpread,
  computeBestPair,
  safeNum,
  type VenueCoinData,
} from "../funding-matrix.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function coin(rate: number, mark: number, oiBase: number): VenueCoinData {
  return { rateHourly: rate, markPriceUsd: mark, openInterestUsd: oiBase * mark };
}

// ── safeNum ───────────────────────────────────────────────────────────────────

describe("safeNum", () => {
  it("passes through finite numbers", () => {
    expect(safeNum(0.001)).toBe(0.001);
    expect(safeNum(0)).toBe(0);
    expect(safeNum(-5)).toBe(-5);
  });
  it("parses numeric strings", () => {
    expect(safeNum("0.00042")).toBeCloseTo(0.00042);
  });
  it("returns null for NaN, Infinity, null, undefined", () => {
    expect(safeNum(NaN)).toBeNull();
    expect(safeNum(Infinity)).toBeNull();
    expect(safeNum(-Infinity)).toBeNull();
    expect(safeNum(null)).toBeNull();
    expect(safeNum(undefined)).toBeNull();
  });
});

// ── computeSpread ─────────────────────────────────────────────────────────────

describe("computeSpread", () => {
  it("returns absolute difference between two rates", () => {
    expect(computeSpread(0.0010, 0.0004)).toBeCloseTo(0.0006);
    expect(computeSpread(0.0004, 0.0010)).toBeCloseTo(0.0006);
  });
  it("returns null when either rate is null", () => {
    expect(computeSpread(null, 0.0004)).toBeNull();
    expect(computeSpread(0.0010, null)).toBeNull();
    expect(computeSpread(null, null)).toBeNull();
  });
  it("spread is always non-negative", () => {
    expect(computeSpread(-0.001, 0.001)!).toBeGreaterThanOrEqual(0);
  });
});

// ── computeBestPair ───────────────────────────────────────────────────────────

describe("computeBestPair", () => {
  it("recommends HL short when HL rate is higher", () => {
    expect(computeBestPair(0.001, 0.0004)).toBe("hyperliquid_short_dydx_long");
  });
  it("recommends dYdX short when dYdX rate is higher", () => {
    expect(computeBestPair(0.0004, 0.001)).toBe("dydx_short_hyperliquid_long");
  });
  it("treats equal rates as HL short (tie-break)", () => {
    expect(computeBestPair(0.001, 0.001)).toBe("hyperliquid_short_dydx_long");
  });
  it("returns null when either rate is null", () => {
    expect(computeBestPair(null, 0.001)).toBeNull();
    expect(computeBestPair(0.001, null)).toBeNull();
  });
});

// ── buildMatrixEntries ────────────────────────────────────────────────────────

describe("buildMatrixEntries", () => {
  const hl = new Map<string, VenueCoinData>([
    ["BTC",  coin(0.001,  95_000, 10)],   // OI = $950,000
    ["ETH",  coin(0.0005, 3_500,  50)],   // OI = $175,000
    ["SOL",  coin(0.0002, 150,    500)],   // OI = $75,000
  ]);
  const dydx = new Map<string, VenueCoinData>([
    ["BTC",  coin(0.0004, 95_000, 8)],    // OI = $760,000
    ["ETH",  coin(0.0008, 3_500,  30)],   // OI = $105,000
    ["AVAX", coin(0.0003, 40,     1000)], // OI = $40,000  (only on dYdX)
  ]);

  it("ranks coins by max OI across venues descending", () => {
    const entries = buildMatrixEntries(hl, dydx, 10);
    const names   = entries.map((e) => e.coin);
    // BTC max(950k, 760k)=950k, ETH max(175k, 105k)=175k, SOL(75k, -), AVAX(-,40k)
    expect(names[0]).toBe("BTC");
    expect(names[1]).toBe("ETH");
    expect(names[2]).toBe("SOL");
    expect(names[3]).toBe("AVAX");
  });

  it("respects topN limit", () => {
    expect(buildMatrixEntries(hl, dydx, 2)).toHaveLength(2);
    expect(buildMatrixEntries(hl, dydx, 3)).toHaveLength(3);
  });

  it("fills null for rates missing on a venue", () => {
    const entries = buildMatrixEntries(hl, dydx, 10);
    const sol  = entries.find((e) => e.coin === "SOL")!;
    const avax = entries.find((e) => e.coin === "AVAX")!;

    expect(sol.rates.hyperliquid).toBeCloseTo(0.0002);
    expect(sol.rates.dydx).toBeNull();        // SOL not on dYdX

    expect(avax.rates.hyperliquid).toBeNull(); // AVAX not on HL
    expect(avax.rates.dydx).toBeCloseTo(0.0003);
  });

  it("computes spread and bestPair when both venues have the coin", () => {
    const entries = buildMatrixEntries(hl, dydx, 10);
    const btc = entries.find((e) => e.coin === "BTC")!;
    expect(btc.spread).toBeCloseTo(0.001 - 0.0004); // 0.0006
    expect(btc.bestPair).toBe("hyperliquid_short_dydx_long"); // HL rate higher
  });

  it("sets spread and bestPair to null when only one venue present", () => {
    const entries = buildMatrixEntries(hl, dydx, 10);
    const sol  = entries.find((e) => e.coin === "SOL")!;
    const avax = entries.find((e) => e.coin === "AVAX")!;
    expect(sol.spread).toBeNull();
    expect(sol.bestPair).toBeNull();
    expect(avax.spread).toBeNull();
    expect(avax.bestPair).toBeNull();
  });

  it("emits no NaN in oiUsd, rates, or spread", () => {
    const entries = buildMatrixEntries(hl, dydx, 10);
    for (const e of entries) {
      expect(Number.isNaN(e.oiUsd)).toBe(false);
      for (const v of Object.values(e.rates)) {
        if (v !== null) expect(Number.isNaN(v)).toBe(false);
      }
      if (e.spread !== null) expect(Number.isNaN(e.spread)).toBe(false);
    }
  });

  it("handles empty venue maps without throwing", () => {
    expect(() => buildMatrixEntries(new Map(), new Map(), 25)).not.toThrow();
    expect(buildMatrixEntries(new Map(), new Map(), 25)).toHaveLength(0);
  });

  it("handles one empty venue gracefully", () => {
    const entries = buildMatrixEntries(hl, new Map(), 10);
    expect(entries.every((e) => e.rates.dydx === null)).toBe(true);
    expect(entries.every((e) => e.spread === null)).toBe(true);
  });
});

// ── Retention / rollup ────────────────────────────────────────────────────────
//
// We test the Logger retention logic using an in-memory database so there is
// no filesystem dependency and tests are fast.

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  // Load only the funding-matrix migration (tables we test here)
  const sql = readFileSync(
    join(process.cwd(), "migrations/002_funding_matrix.sql"),
    "utf-8",
  );
  db.exec(sql);
  return db;
}

const HOUR_MS     = 3_600_000;
const SEVEN_DAYS  = 7 * 24 * HOUR_MS;

/** Insert raw funding_samples rows with known timestamps. */
function seedFunding(db: Database.Database, rows: Array<{ ts: number; coin: string; venue: string; rate: number }>) {
  const stmt = db.prepare("INSERT OR REPLACE INTO funding_samples (ts, coin, venue, rate_hourly) VALUES (?, ?, ?, ?)");
  for (const r of rows) stmt.run(r.ts, r.coin, r.venue, r.rate);
}

/** Insert raw equity_history rows. */
function seedEquity(db: Database.Database, rows: Array<{ ts: number; equity: number }>) {
  const stmt = db.prepare("INSERT OR REPLACE INTO equity_history (ts, equity_usd) VALUES (?, ?)");
  for (const r of rows) stmt.run(r.ts, r.equity);
}

/** Execute the same retention SQL the Logger uses (extracted for testing). */
function runRetention(db: Database.Database, cutoff: number) {
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO equity_history_hourly (ts_hour, avg_equity_usd, sample_count)
      SELECT (ts / ${HOUR_MS}) * ${HOUR_MS}, AVG(equity_usd), COUNT(*)
      FROM equity_history WHERE ts < ?
      GROUP BY (ts / ${HOUR_MS})
    `).run(cutoff);
    db.prepare("DELETE FROM equity_history WHERE ts < ?").run(cutoff);

    db.prepare(`
      INSERT OR IGNORE INTO funding_samples_hourly (ts_hour, coin, venue, avg_rate_hourly, sample_count)
      SELECT (ts / ${HOUR_MS}) * ${HOUR_MS}, coin, venue, AVG(rate_hourly), COUNT(*)
      FROM funding_samples WHERE ts < ?
      GROUP BY (ts / ${HOUR_MS}), coin, venue
    `).run(cutoff);
    db.prepare("DELETE FROM funding_samples WHERE ts < ?").run(cutoff);
  })();
}

describe("retention / rollup", () => {
  it("rolls up old equity rows into hourly table and deletes them", () => {
    const db  = makeTestDb();
    const now = Date.now();
    const old = now - SEVEN_DAYS - HOUR_MS; // definitely older than 7 days
    // Two readings in the same hour window
    seedEquity(db, [
      { ts: old,              equity: 1000 },
      { ts: old + 1_000,      equity: 1020 },
      { ts: now - 1_000,      equity: 1050 }, // recent — must NOT be rolled up
    ]);

    runRetention(db, now - SEVEN_DAYS);

    const raw    = db.prepare("SELECT * FROM equity_history").all();
    const hourly = db.prepare("SELECT * FROM equity_history_hourly").all() as Array<{ avg_equity_usd: number; sample_count: number }>;

    // Recent row stays in raw; old rows removed
    expect(raw).toHaveLength(1);
    // Old rows aggregated into one hourly bucket
    expect(hourly).toHaveLength(1);
    expect(hourly[0].sample_count).toBe(2);
    expect(hourly[0].avg_equity_usd).toBeCloseTo(1010); // avg(1000, 1020)
  });

  it("rolls up old funding samples per (coin, venue) and deletes them", () => {
    const db  = makeTestDb();
    const now = Date.now();
    const old = now - SEVEN_DAYS - HOUR_MS;

    seedFunding(db, [
      { ts: old,         coin: "BTC", venue: "hyperliquid", rate: 0.001 },
      { ts: old + 1_000, coin: "BTC", venue: "hyperliquid", rate: 0.002 },
      { ts: old,         coin: "BTC", venue: "dydx",        rate: 0.0005 },
      { ts: now - 1_000, coin: "BTC", venue: "hyperliquid", rate: 0.0015 }, // recent
    ]);

    runRetention(db, now - SEVEN_DAYS);

    const raw    = db.prepare("SELECT * FROM funding_samples").all();
    const hourly = db.prepare("SELECT * FROM funding_samples_hourly ORDER BY venue").all() as Array<{ coin: string; venue: string; avg_rate_hourly: number; sample_count: number }>;

    expect(raw).toHaveLength(1); // only the recent row remains
    expect(hourly).toHaveLength(2); // one per venue for the old hour
    const hl   = hourly.find((r) => r.venue === "hyperliquid")!;
    const dydx = hourly.find((r) => r.venue === "dydx")!;
    expect(hl.sample_count).toBe(2);
    expect(hl.avg_rate_hourly).toBeCloseTo(0.0015); // avg(0.001, 0.002)
    expect(dydx.sample_count).toBe(1);
    expect(dydx.avg_rate_hourly).toBeCloseTo(0.0005);
  });

  it("does not touch rows newer than the cutoff", () => {
    const db  = makeTestDb();
    const now = Date.now();
    seedEquity(db, [
      { ts: now - 1_000, equity: 999 },
      { ts: now - 2_000, equity: 888 },
    ]);
    runRetention(db, now - SEVEN_DAYS);

    const raw    = db.prepare("SELECT COUNT(*) as n FROM equity_history").get() as { n: number };
    const hourly = db.prepare("SELECT COUNT(*) as n FROM equity_history_hourly").get() as { n: number };
    expect(raw.n).toBe(2);
    expect(hourly.n).toBe(0);
  });

  it("is idempotent — running twice produces the same result", () => {
    const db  = makeTestDb();
    const now = Date.now();
    const old = now - SEVEN_DAYS - HOUR_MS;
    seedFunding(db, [{ ts: old, coin: "ETH", venue: "hyperliquid", rate: 0.0003 }]);
    const cutoff = now - SEVEN_DAYS;

    runRetention(db, cutoff);
    runRetention(db, cutoff); // second call must not throw or duplicate

    const hourly = db.prepare("SELECT COUNT(*) as n FROM funding_samples_hourly").get() as { n: number };
    expect(hourly.n).toBe(1);
  });
});

// ── Spread history persistence ───────────────────────────────────────────────

import { Logger } from "../logger.js";

describe("writeSpreadHistory", () => {
  it("writes one row per coin per refresh, queryable by coin + time range", () => {
    const logger = new Logger(":memory:");
    const ts = Date.now();

    logger.writeSpreadHistory(ts, [
      { coin: "BTC", hlFunding: 0.0001, dydxFunding: 0.00005, spreadAbs: 0.00005, spreadDir: "hl>dydx", hlOiUsd: 5e8 },
      { coin: "ETH", hlFunding: 0.0002, dydxFunding: 0.00015, spreadAbs: 0.00005, spreadDir: "hl>dydx", hlOiUsd: 3e8 },
      { coin: "SOL", hlFunding: 0.0003, dydxFunding: null,    spreadAbs: null,     spreadDir: null,       hlOiUsd: 1e8 },
    ]);

    // Query: all rows for this timestamp
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (logger as any).db;
    const rows = db.prepare("SELECT * FROM funding_spread_history WHERE ts = ?").all(ts) as unknown[];
    expect(rows).toHaveLength(3);

    // Query: BTC rows in time range
    const btcRows = db.prepare(
      "SELECT * FROM funding_spread_history WHERE coin = ? AND ts >= ? AND ts <= ?",
    ).all("BTC", ts - 1000, ts + 1000) as Array<{ hl_funding: number; spread_abs: number }>;
    expect(btcRows).toHaveLength(1);
    expect(btcRows[0].hl_funding).toBeCloseTo(0.0001);
    expect(btcRows[0].spread_abs).toBeCloseTo(0.00005);

    // SOL has null spread (dYdX doesn't list it)
    const solRows = db.prepare(
      "SELECT * FROM funding_spread_history WHERE coin = ?",
    ).all("SOL") as Array<{ spread_abs: number | null }>;
    expect(solRows[0].spread_abs).toBeNull();
  });
});
