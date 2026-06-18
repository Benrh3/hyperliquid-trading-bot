// Express router for /api/market/* endpoints (market-spec.md §7 stage 6).
//
// Observe-only: all endpoints are read-only. No trading-path import.
//   GET /api/market/scorecard        → scorecard.csv shape
//   GET /api/market/snapshots        → snapshots.csv shape
//   GET /api/market/bias?horizon=4   → BiasResponse JSON
//   GET /api/market/signals          → current signal values JSON
//   GET /api/market/candles          → HYPE candles always from mainnet

import { Router } from "express";
import { InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { loadManifest } from "./manifest.js";
import {
  buildScorecard,
  computeBias,
  scorecardToCsv,
  buildSnapshotsCsv,
  SCORING_HORIZONS_H,
} from "./scoring.js";
import type { MarketStore } from "./store.js";

/** Short TTL for scorecard cache — recomputing Spearman over 10K rows is fast (~10ms), but no need per-request. */
const SCORECARD_CACHE_MS = 60_000;

interface ScorecardCache {
  csv:       string;
  cells:     ReturnType<typeof buildScorecard>;
  builtAt:   number;
}

const caches = new Map<string, ScorecardCache>();

let liveCache: { data: object; expiresAt: number } | null = null;

function getScorecard(store: MarketStore, symbol: string): ScorecardCache {
  const cached = caches.get(symbol);
  if (cached && Date.now() - cached.builtAt < SCORECARD_CACHE_MS) return cached;
  const cells = buildScorecard(store, symbol);
  const csv   = scorecardToCsv(cells);
  const entry: ScorecardCache = { csv, cells, builtAt: Date.now() };
  caches.set(symbol, entry);
  return entry;
}

export function createMarketRouter(store: MarketStore): Router {
  const router = Router();

  // ── GET /api/market/scorecard ──────────────────────────────────────────────
  // ?format=json  returns JSON array of ScoreCell objects (default: CSV download)
  router.get("/api/market/scorecard", (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const format = typeof req.query.format === "string" ? req.query.format : "csv";
    const { csv, cells } = getScorecard(store, symbol);
    if (format === "json") {
      res.json({ symbol, cells });
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="scorecard-${symbol}.csv"`);
    res.send(csv);
  });

  // ── GET /api/market/snapshots ──────────────────────────────────────────────
  router.get("/api/market/snapshots", (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const csv    = buildSnapshotsCsv(store, symbol);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="snapshots-${symbol}.csv"`);
    res.send(csv);
  });

  // ── GET /api/market/bias?horizon=4 ────────────────────────────────────────
  router.get("/api/market/bias", (req, res) => {
    const symbol  = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const horizon = parseInt(typeof req.query.horizon === "string" ? req.query.horizon : "24");
    if (!SCORING_HORIZONS_H.includes(horizon as (typeof SCORING_HORIZONS_H)[number])) {
      res.status(400).json({ error: `horizon must be one of ${SCORING_HORIZONS_H.join(",")}` });
      return;
    }

    const { cells } = getScorecard(store, symbol);

    // Gather current (most recent) values of all signalForScoring metrics.
    const [latest] = store.getRecentSnapshots(symbol, 1);
    const currentValues: Record<string, number | null> = {};
    if (latest) {
      for (const [key, mv] of Object.entries(latest.metrics)) {
        currentValues[key] = mv.value;
      }
    }

    const bias = computeBias(cells, currentValues, horizon, symbol);
    res.json(bias);
  });

  // ── GET /api/market/signals ────────────────────────────────────────────────
  // ?subtab=leverage   filters to a single subtab (all returned if omitted)
  // When subtab is set all metrics in that subtab are returned, not just signalForScoring.
  router.get("/api/market/signals", (req, res) => {
    const symbol  = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const subtab  = typeof req.query.subtab === "string" ? req.query.subtab : null;
    const manifest = loadManifest();
    const [latest] = store.getRecentSnapshots(symbol, 1);

    const signals = manifest.metrics
      .filter((m) => subtab ? m.subtab === subtab : m.signalForScoring)
      .map((m) => ({
        key:          m.key,
        label:        m.label,
        source:       m.source,
        kind:         m.kind,
        subtab:       m.subtab,
        derived:      m.derived,
        read:         m.read ?? null,
        dir:          m.dir ?? null,
        currentValue: latest?.metrics[m.key]?.value ?? null,
        capturedAt:   latest?.metrics[m.key]?.capturedAt ?? null,
        staleAfterMs: m.staleAfterMs,
      }));

    res.json({ symbol, capturedAt: latest?.capturedAt ?? null, signals });
  });

  // ── GET /api/market/live ──────────────────────────────────────────────────
  // Display-only — not persisted. Always reads mainnet. 2s server-side cache
  // so burst browser polling stays cheap.
  router.get("/api/market/live", async (_req, res) => {
    if (liveCache && liveCache.expiresAt > Date.now()) { res.json(liveCache.data); return; }
    try {
      const client = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
      const [perpResult, book] = await Promise.all([
        client.metaAndAssetCtxs(),
        client.l2Book({ coin: "HYPE" }).catch(() => null),
      ]);
      const [perpMeta, perpCtxs] = perpResult;
      const idx = perpMeta.universe.findIndex((u) => u.name === "HYPE");
      const ctx = idx >= 0 ? perpCtxs[idx] : null;

      const markPx       = ctx ? parseFloat(ctx.markPx)       : null;
      const midPx        = ctx?.midPx ? parseFloat(ctx.midPx) : null;
      const funding      = ctx ? parseFloat(ctx.funding)       : null;
      const openInterest = ctx ? parseFloat(ctx.openInterest)  : null;

      // Bid-ask spread from top-of-book
      const topBid = book?.levels?.[0]?.[0]?.px ? parseFloat(String(book.levels[0][0].px)) : null;
      const topAsk = book?.levels?.[1]?.[0]?.px ? parseFloat(String(book.levels[1][0].px)) : null;
      const refPx  = midPx ?? markPx;
      const spreadBps = topBid && topAsk && refPx
        ? ((topAsk - topBid) / refPx) * 10_000
        : null;

      // CVD from latest snapshot (hourly cadence — display only)
      const [latest] = store.getRecentSnapshots("HYPE", 1);
      const cvd24h = latest?.metrics["cvd_perp_24h"]?.value ?? null;

      const data = { markPx, midPx, funding, openInterest, spreadBps, cvd24h, ts: Date.now() };
      liveCache = { data, expiresAt: Date.now() + 2_000 };
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/market/candles ───────────────────────────────────────────────
  // Always reads mainnet — market data is observe-only (spec §0 + §6).
  const CANDLE_INTERVALS = new Set(["1m","3m","5m","15m","30m","1h","2h","4h","8h","12h","1d"]);
  const CANDLE_TF_MS: Record<string, number> = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
    "12h": 43_200_000, "1d": 86_400_000,
  };
  const candleCache = new Map<string, { data: object; expiresAt: number }>();

  router.get("/api/market/candles", async (req, res) => {
    const coin     = typeof req.query.coin     === "string" ? req.query.coin.toUpperCase()     : "HYPE";
    const interval = typeof req.query.interval === "string" ? req.query.interval               : "4h";
    if (!CANDLE_INTERVALS.has(interval)) {
      res.status(400).json({ error: `Invalid interval: ${interval}` });
      return;
    }
    const cacheKey = `${coin}:${interval}`;
    const cached   = candleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) { res.json(cached.data); return; }

    try {
      const client    = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
      const now       = Date.now();
      const startTime = now - 200 * (CANDLE_TF_MS[interval] ?? 14_400_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await client.candleSnapshot({ coin, interval: interval as any, startTime, endTime: now });
      const candles = raw.map((c) => ({
        time:   Math.floor(Number(c.t) / 1000),
        open:   parseFloat(String(c.o)),
        high:   parseFloat(String(c.h)),
        low:    parseFloat(String(c.l)),
        close:  parseFloat(String(c.c)),
        volume: parseFloat(String(c.v)),
      }));
      const data = { coin, interval, candles };
      candleCache.set(cacheKey, { data, expiresAt: Date.now() + 60_000 });
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: `Failed to fetch candles: ${(e as Error).message}` });
    }
  });

  // ── GET /api/market/history ───────────────────────────────────────────────
  // Returns time-series rows for named metric fields from stored snapshots.
  // ?fields=funding_rate,perp_premium   comma-separated metric keys (required)
  // ?range=1W                           1D | 1W | 1M | 3M | All  (default: 1W)
  // ?symbol=HYPE
  // Returns: { rows: Array<{ ts: number, [field]: number|null }> }  oldest first
  const HISTORY_RANGE_MS: Record<string, number | null> = {
    "1D": 86_400_000, "1W": 604_800_000, "1M": 2_592_000_000,
    "3M": 7_776_000_000, "All": null,
  };

  router.get("/api/market/history", (req, res) => {
    const symbol     = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const fieldsRaw  = typeof req.query.fields === "string" ? req.query.fields : "";
    const rangeKey   = typeof req.query.range  === "string" ? req.query.range  : "1W";

    if (!fieldsRaw) { res.status(400).json({ error: "fields param required" }); return; }
    if (!(rangeKey in HISTORY_RANGE_MS)) {
      res.status(400).json({ error: `range must be one of ${Object.keys(HISTORY_RANGE_MS).join(",")}` });
      return;
    }

    const fields   = fieldsRaw.split(",").map((f) => f.trim()).filter(Boolean);
    const rangeMs  = HISTORY_RANGE_MS[rangeKey];
    const cutoffMs = rangeMs ? Date.now() - rangeMs : 0;

    // Fetch enough snapshots — 3M at hourly cadence ≈ 2200 rows; All ≈ no limit
    const snapshots = store.getRecentSnapshots(symbol, 5000);
    const filtered  = snapshots.filter((s) => s.capturedAt >= cutoffMs).reverse(); // oldest first

    const rows = filtered.map((snap) => {
      const row: Record<string, number | null | string> = { ts: snap.capturedAt };
      for (const field of fields) {
        row[field] = snap.metrics[field]?.value ?? null;
      }
      return row;
    });

    res.json({ symbol, range: rangeKey, fields, rows });
  });

  // ── GET /api/market/manifest ──────────────────────────────────────────────
  // Returns all metric definitions from the manifest for the Glossary + Data column picker.
  router.get("/api/market/manifest", (_req, res) => {
    const manifest = loadManifest();
    const metrics = manifest.metrics.map((m) => ({
      key:            m.key,
      label:          m.label,
      beginnerLabel:  m.beginnerLabel ?? null,
      source:         m.source,
      kind:           m.kind,
      subtab:         m.subtab,
      derived:        m.derived,
      signalForScoring: m.signalForScoring,
      read:           m.read ?? null,
      dir:            m.dir ?? null,
    }));
    res.json({ asset: manifest.asset, metrics });
  });

  // ── GET /api/market/replay?ts=<ms> ─────────────────────────────────────
  // Returns the snapshot at-or-just-before ts, directional tally, and forward returns.
  const REPLAY_HORIZONS = [4, 24, 72, 168];
  const REPLAY_KEY_METRICS = [
    "perp_mark_px", "funding_rate", "open_interest", "cvd_perp_24h",
    "cex_net_flow_hype", "total_staked_hype", "book_imbalance",
  ];

  router.get("/api/market/replay", (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const tsRaw  = typeof req.query.ts     === "string" ? parseInt(req.query.ts)          : NaN;
    if (!Number.isFinite(tsRaw)) { res.status(400).json({ error: "ts param required (ms)" }); return; }

    const manifest  = loadManifest();
    const snapshots = store.getRecentSnapshots(symbol, 5000);
    if (!snapshots.length) { res.json({ error: "no snapshots" }); return; }

    // Find snapshot at-or-just-before ts (snapshots are newest-first)
    let snap = snapshots[snapshots.length - 1]; // oldest as fallback
    for (const s of snapshots) {
      if (s.capturedAt <= tsRaw) { snap = s; break; }
    }

    // Price at snap time
    const priceSeries = store.getMetricTimeSeries(symbol, "perp_mark_px");
    const priceAtTs   = lookupNearestPrice(priceSeries, snap.capturedAt);

    // Forward returns
    const forwardReturns: Record<string, number | null> = {};
    for (const h of REPLAY_HORIZONS) {
      const futureMs = snap.capturedAt + h * 3_600_000;
      if (futureMs > Date.now()) { forwardReturns[`${h}h`] = null; continue; }
      const futurePrice = lookupNearestPrice(priceSeries, futureMs);
      forwardReturns[`${h}h`] = priceAtTs && futurePrice ? (futurePrice - priceAtTs) / priceAtTs : null;
    }

    // Directional tally: apply each scored signal's dir to its value at ts
    const scored = manifest.metrics.filter((m) => m.signalForScoring);
    let bullCount = 0, bearCount = 0, neutralCount = 0;
    const reads: Array<{ key: string; value: number | null; dir: string | null; read: string | null }> = [];

    for (const sig of scored) {
      const val = snap.metrics[sig.key]?.value ?? null;
      const dir = sig.dir ?? null;
      let read: string | null = null;

      if (val !== null && Number.isFinite(val) && dir) {
        // Derive direction from dir string
        const isBear = /Bear/i.test(dir);
        const isBull = /Bull/i.test(dir);
        // Zero-centered: positive value on a bear-mapped = bearish, on bull-mapped = bullish
        if (isBear && val > 0) { read = "bearish"; bearCount++; }
        else if (isBear && val < 0) { read = "bullish"; bullCount++; }
        else if (isBull && val > 0) { read = "bullish"; bullCount++; }
        else if (isBull && val < 0) { read = "bearish"; bearCount++; }
        else { read = "neutral"; neutralCount++; }
      } else {
        neutralCount++;
      }

      reads.push({ key: sig.key, value: val, dir, read });
    }

    // Key metrics for compact display
    const keyMetrics: Record<string, number | null> = {};
    for (const k of REPLAY_KEY_METRICS) {
      keyMetrics[k] = snap.metrics[k]?.value ?? null;
    }

    // Snapshot range for the slider
    const oldest = snapshots[snapshots.length - 1].capturedAt;
    const newest = snapshots[0].capturedAt;

    // Price window for mini chart: ±48h around snap
    const chartWindow = priceSeries
      .filter((p) => p.capturedAt >= snap.capturedAt - 48 * 3_600_000 && p.capturedAt <= snap.capturedAt + 48 * 3_600_000 && p.value !== null)
      .map((p) => ({ ts: p.capturedAt, px: p.value }));

    res.json({
      symbol,
      snapshotTs:    snap.capturedAt,
      priceAtTs,
      tally:         { bull: bullCount, bear: bearCount, neutral: neutralCount },
      forwardReturns,
      keyMetrics,
      reads,
      range:         { oldest, newest },
      chartWindow,
    });
  });

  return router;
}

function lookupNearestPrice(series: ReadonlyArray<{ capturedAt: number; value: number | null }>, targetMs: number): number | null {
  if (!series.length) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid].capturedAt < targetMs) lo = mid + 1;
    else hi = mid;
  }
  // lo is first >= targetMs; check lo and lo-1 for closest
  const candidates = [lo, lo - 1].filter((i) => i >= 0 && i < series.length);
  let best = candidates[0];
  for (const i of candidates) {
    if (Math.abs(series[i].capturedAt - targetMs) < Math.abs(series[best].capturedAt - targetMs)) best = i;
  }
  return series[best].value;
}
