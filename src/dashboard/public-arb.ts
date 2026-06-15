// Public read-only stats endpoint for HL Bot — powers the featured project
// card on benhowbrook.xyz.
//
// Exposes ONLY: BTC cross-venue funding (already-public market data, sourced
// from the same mainnet read-only funding-matrix poller that feeds the
// Overview "Funding Rate Matrix"), plus aggregate session stats (trade count,
// signal count, uptime, strategy count). No keys, positions, balances,
// account P&L, or config are ever returned.
//
// dYdX's testnet indexer does not publish funding, so the cross-venue spread
// can only be demonstrated against live mainnet funding (read-only, no orders
// are placed against it). Order execution stays on testnet — see `mode`.

import { Router } from "express";
import type { Logger } from "../logger.js";
import type { FundingMatrixPoller } from "../funding-matrix.js";
import type { BotState } from "./server.js";
import { STRATEGY_REGISTRY } from "../strategy/registry.js";

const ALLOWED_ORIGINS = new Set([
  "https://benhowbrook.xyz",
  "https://www.benhowbrook.xyz",
]);
const CACHE_TTL_MS = 30_000;

interface PublicArbBody {
  updated: string;
  mode: "testnet";
  funding: {
    source: "mainnet-read-only";
    btc: {
      hl:         number;
      hlApr:      number;
      dydx:       number;
      dydxApr:    number;
      spread:     number;
      spreadApr:  number;
      shortVenue: "hl" | "dydx";
    };
  };
  session: {
    trades:      number;
    signals:     number;
    uptimeHours: number;
    strategies:  number;
  };
}

let cache: { body: PublicArbBody | null; at: number } = { body: null, at: 0 };

// Reuses the FundingMatrixPoller's in-memory cache (already populated for the
// Funding Rate Matrix dashboard) — never makes a fresh exchange call.
function getBtcFunding(fundingMatrix: FundingMatrixPoller) {
  const btc = fundingMatrix.getMatrix().coins.find((c) => c.coin === "BTC");
  if (!btc || btc.rates.hyperliquid === null || btc.rates.dydx === null) {
    throw new Error("BTC funding rates not available in funding matrix");
  }

  // rates are hourly fractions (e.g. 0.0000125) — convert to % per hour and %/yr
  const toPct = (hourlyFrac: number) => hourlyFrac * 100;
  const toApr = (hourlyFrac: number) => hourlyFrac * 8_760 * 100;

  const hl    = toPct(btc.rates.hyperliquid);
  const dydx  = toPct(btc.rates.dydx);
  const hlApr = toApr(btc.rates.hyperliquid);
  const dydxApr = toApr(btc.rates.dydx);

  return {
    hl,
    hlApr,
    dydx,
    dydxApr,
    spread:     Math.abs(hl - dydx),
    spreadApr:  Math.abs(hlApr - dydxApr),
    shortVenue: (hl >= dydx ? "hl" : "dydx") as "hl" | "dydx",
  };
}

// Reuses the same sources as the Overview page: Logger for trade count,
// BotState.signalCount for signals, process.uptime() for uptime, and the
// strategy registry for the strategy count.
function getSessionStats(logger: Logger, state: BotState) {
  return {
    trades:      logger.getTradeCount(),
    signals:     state.signalCount,
    uptimeHours: process.uptime() / 3_600,
    strategies:  STRATEGY_REGISTRY.length,
  };
}

export function createPublicArbRouter(
  logger: Logger,
  state: BotState,
  fundingMatrix?: FundingMatrixPoller,
): Router {
  const router = Router();

  router.get("/api/public/arb", (req, res) => {
    const origin = req.get("origin");
    res.set(
      "Access-Control-Allow-Origin",
      origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://benhowbrook.xyz",
    );
    res.set("Vary", "Origin");
    res.set("Cache-Control", "public, max-age=30");

    try {
      if (cache.body && Date.now() - cache.at < CACHE_TTL_MS) {
        res.json(cache.body);
        return;
      }

      if (!fundingMatrix) throw new Error("Funding matrix poller not initialised");

      const btc     = getBtcFunding(fundingMatrix);
      const session = getSessionStats(logger, state);

      const body: PublicArbBody = {
        updated: new Date().toISOString(),
        mode: "testnet",
        funding: {
          source: "mainnet-read-only",
          btc: {
            hl:         Number(btc.hl.toFixed(4)),
            hlApr:      Number(btc.hlApr.toFixed(1)),
            dydx:       Number(btc.dydx.toFixed(4)),
            dydxApr:    Number(btc.dydxApr.toFixed(1)),
            spread:     Number(btc.spread.toFixed(4)),
            spreadApr:  Number(btc.spreadApr.toFixed(1)),
            shortVenue: btc.shortVenue,
          },
        },
        session,
      };

      cache = { body, at: Date.now() };
      res.json(body);
    } catch {
      // Never leak internals on the public route
      res.status(503).json({ error: "stats temporarily unavailable" });
    }
  });

  return router;
}
