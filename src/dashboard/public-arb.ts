// Public read-only stats endpoint for HL Bot.
//
// Exposes ONLY: BTC funding rates (already-public market data), the spread,
// and an aggregate trade count. No keys, no positions, no balances, no config.

import { Router } from "express";
import type { Logger } from "../logger.js";
import type { FundingMatrixPoller } from "../funding-matrix.js";

const ALLOWED_ORIGIN = "https://benhowbrook.xyz";
const CACHE_TTL_MS = 30_000;

interface PublicArbBody {
  updated: string;
  btc: {
    hl:   { rate: number; apr: number };
    dydx: { rate: number; apr: number };
    spread: number;
    spreadApr: number;
  };
  trades: number;
}

let cache: { body: PublicArbBody | null; at: number } = { body: null, at: 0 };

// Reuses the FundingMatrixPoller's in-memory cache (already populated for the
// Funding Rate Matrix dashboard) — never makes a fresh exchange call.
function getBtcFunding(fundingMatrix: FundingMatrixPoller): {
  hl:   { rate: number; apr: number };
  dydx: { rate: number; apr: number };
} {
  const btc = fundingMatrix.getMatrix().coins.find((c) => c.coin === "BTC");
  if (!btc || btc.rates.hyperliquid === null || btc.rates.dydx === null) {
    throw new Error("BTC funding rates not available in funding matrix");
  }

  // rates are hourly fractions (e.g. 0.0000125) — convert to % per interval and %/yr
  const toPct = (hourlyFrac: number) => hourlyFrac * 100;
  const toApr = (hourlyFrac: number) => hourlyFrac * 8_760 * 100;

  return {
    hl:   { rate: toPct(btc.rates.hyperliquid), apr: toApr(btc.rates.hyperliquid) },
    dydx: { rate: toPct(btc.rates.dydx),        apr: toApr(btc.rates.dydx) },
  };
}

function getTradeCount(logger: Logger): number {
  return logger.getTradeCount();
}

export function createPublicArbRouter(logger: Logger, fundingMatrix?: FundingMatrixPoller): Router {
  const router = Router();

  router.get("/api/public/arb", (_req, res) => {
    res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.set("Cache-Control", "public, max-age=30");

    try {
      if (cache.body && Date.now() - cache.at < CACHE_TTL_MS) {
        res.json(cache.body);
        return;
      }

      if (!fundingMatrix) throw new Error("Funding matrix poller not initialised");

      const btc    = getBtcFunding(fundingMatrix);
      const trades = getTradeCount(logger);

      const spread    = Math.abs(btc.hl.rate - btc.dydx.rate);
      const spreadApr = Math.abs(btc.hl.apr - btc.dydx.apr);

      const body: PublicArbBody = {
        updated: new Date().toISOString(),
        btc: {
          hl:        btc.hl,
          dydx:      btc.dydx,
          spread:    Number(spread.toFixed(4)),
          spreadApr: Number(spreadApr.toFixed(1)),
        },
        trades,
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
