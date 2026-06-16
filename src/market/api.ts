// Express router for /api/market/* endpoints (market-spec.md §7 stage 6).
//
// Observe-only: all endpoints are read-only. No trading-path import.
//   GET /api/market/scorecard        → scorecard.csv shape
//   GET /api/market/snapshots        → snapshots.csv shape
//   GET /api/market/bias?horizon=4   → BiasResponse JSON
//   GET /api/market/signals          → current signal values JSON

import { Router } from "express";
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
  router.get("/api/market/scorecard", (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const { csv } = getScorecard(store, symbol);
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
  router.get("/api/market/signals", (req, res) => {
    const symbol   = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "HYPE";
    const manifest = loadManifest();
    const [latest] = store.getRecentSnapshots(symbol, 1);

    const signals = manifest.metrics
      .filter((m) => m.signalForScoring)
      .map((m) => ({
        key:          m.key,
        label:        m.label,
        source:       m.source,
        kind:         m.kind,
        subtab:       m.subtab,
        derived:      m.derived,
        read:         (m as { read?: string }).read ?? null,
        currentValue: latest?.metrics[m.key]?.value ?? null,
        capturedAt:   latest?.metrics[m.key]?.capturedAt ?? null,
        staleAfterMs: m.staleAfterMs,
      }));

    res.json({ symbol, capturedAt: latest?.capturedAt ?? null, signals });
  });

  return router;
}
