// Pure parsers for each venue's liquidation stream payload (market-spec.md
// §7 stage 4). Kept separate from the WS plumbing so they're unit-testable
// without a live socket.
//
// Sign convention: `side: "long"` = a long position was force-closed (forced
// SELL); `side: "short"` = a short position was force-closed (forced BUY).

import type { CexLiqEvent } from "./types.js";

/** Binance USDⓜ-Futures `<symbol>@forceOrder` — throttled to ~1 push/sec/symbol (undercount, expected). */
export function parseBinanceForceOrder(raw: unknown): CexLiqEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as { e?: string; o?: { S?: string; q?: string; T?: number }; E?: number };
  if (msg.e !== "forceOrder" || !msg.o) return null;

  const side = msg.o.S === "SELL" ? "long" : msg.o.S === "BUY" ? "short" : null;
  const qtyCoins = Number(msg.o.q);
  const timeMs = Number(msg.o.T ?? msg.E);
  if (!side || !Number.isFinite(qtyCoins) || !Number.isFinite(timeMs)) return null;

  return { side, qtyCoins, timeMs };
}

/** Bybit `allLiquidation.<symbol>` — batched, near-complete. */
export function parseBybitAllLiquidation(raw: unknown): CexLiqEvent[] {
  if (typeof raw !== "object" || raw === null) return [];
  const msg = raw as { topic?: string; data?: { S?: string; v?: string; T?: number }[] };
  if (typeof msg.topic !== "string" || !msg.topic.startsWith("allLiquidation") || !Array.isArray(msg.data)) return [];

  const events: CexLiqEvent[] = [];
  for (const d of msg.data) {
    const side = d.S === "Sell" ? "long" : d.S === "Buy" ? "short" : null;
    const qtyCoins = Number(d.v);
    const timeMs = Number(d.T);
    if (!side || !Number.isFinite(qtyCoins) || !Number.isFinite(timeMs)) continue;
    events.push({ side, qtyCoins, timeMs });
  }
  return events;
}

/**
 * OKX `liquidation-orders` (business WS). Sizes are in contracts — `ctVal`
 * converts to coin units (e.g. HYPE-USDT-SWAP has ctVal=0.1 HYPE/contract).
 * Only entries matching `instId` are returned (the channel can carry other
 * instruments for the same instType/instFamily).
 */
export function parseOkxLiquidationOrders(raw: unknown, instId: string, ctVal: number): CexLiqEvent[] {
  if (typeof raw !== "object" || raw === null) return [];
  const msg = raw as {
    arg?: { channel?: string };
    data?: { instId?: string; details?: { side?: string; sz?: string; ts?: string }[] }[];
  };
  if (msg.arg?.channel !== "liquidation-orders" || !Array.isArray(msg.data)) return [];

  const events: CexLiqEvent[] = [];
  for (const entry of msg.data) {
    if (entry.instId !== instId || !Array.isArray(entry.details)) continue;
    for (const d of entry.details) {
      const side = d.side === "sell" ? "long" : d.side === "buy" ? "short" : null;
      const sz = Number(d.sz);
      const timeMs = Number(d.ts);
      if (!side || !Number.isFinite(sz) || !Number.isFinite(timeMs)) continue;
      events.push({ side, qtyCoins: sz * ctVal, timeMs });
    }
  }
  return events;
}
