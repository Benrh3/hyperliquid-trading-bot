import {
  HttpTransport,
  InfoClient,
  ExchangeClient,
} from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { Venue, VenuePosition, OrderReceipt } from "../venue.js";

const SLIPPAGE = 0.02; // IOC limit-order slippage cushion

interface AssetInfo {
  index:      number;
  szDecimals: number;
}

/**
 * Hyperliquid perpetuals venue.
 *
 * Owns the InfoClient + ExchangeClient and implements the full Venue interface.
 * No bus coupling — callers are responsible for emitting trade events.
 */
export class HyperliquidVenue implements Venue {
  readonly name = "hyperliquid";
  readonly walletAddress: string;

  private readonly info:       InfoClient;
  private readonly exchange:   ExchangeClient | null;
  private readonly assetCache = new Map<string, AssetInfo>();

  /**
   * @param privateKey  32-byte hex key.  Pass null for read-only mode (market
   *                    data only); trading methods will throw in that case.
   */
  constructor(privateKey: `0x${string}` | null, isTestnet: boolean) {
    this.info = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    if (privateKey != null) {
      const wallet       = privateKeyToAccount(privateKey);
      this.walletAddress = wallet.address;
      this.exchange      = new ExchangeClient({ wallet, transport: new HttpTransport({ isTestnet }) });
      console.log(`[hyperliquid-venue] Wallet ${this.walletAddress} (${isTestnet ? "testnet" : "mainnet"})`);
    } else {
      this.walletAddress = "";
      this.exchange      = null;
      console.log(`[hyperliquid-venue] Read-only mode (${isTestnet ? "testnet" : "mainnet"})`);
    }
  }

  // ── Market data ───────────────────────────────────────────────────────────

  async getFundingRate(coin: string): Promise<number | null> {
    const [meta, ctxs] = await this.info.metaAndAssetCtxs();
    const idx = this.findCoin(meta.universe, coin);
    if (idx === -1) return null;
    const rate = parseFloat(ctxs[idx].funding);
    return Number.isFinite(rate) ? rate : null;
  }

  async getMarkPrice(coin: string): Promise<number | null> {
    const [meta, ctxs] = await this.info.metaAndAssetCtxs();
    const idx = this.findCoin(meta.universe, coin);
    if (idx === -1) return null;
    const price = parseFloat(ctxs[idx].midPx ?? "0");
    return price > 0 ? price : null;
  }

  async getPosition(coin: string): Promise<VenuePosition | null> {
    const state   = await this.info.clearinghouseState({ user: this.walletAddress as `0x${string}` });
    const exchPos = state.assetPositions.find((p) => p.position.coin === coin);
    if (!exchPos) return null;
    const szi = parseFloat(exchPos.position.szi);
    if (szi === 0) return null;

    const side:       "long" | "short" = szi > 0 ? "long" : "short";
    const size        = Math.abs(szi);
    const entryPrice  = parseFloat(exchPos.position.entryPx ?? "0");
    const markPrice   = (await this.getMarkPrice(coin)) ?? 0;
    const unrealisedPnl = side === "long"
      ? (markPrice - entryPrice) * size
      : (entryPrice - markPrice) * size;

    return { coin, side, size, entryPrice, markPrice, unrealisedPnl };
  }

  // ── Trade execution ───────────────────────────────────────────────────────

  async openPosition(coin: string, side: "long" | "short", sizeUsd: number): Promise<OrderReceipt> {
    if (!this.exchange) throw new Error("HyperliquidVenue.openPosition: no wallet configured (read-only mode)");
    const { idx, szDecimals, midPx } = await this.resolveMarket(coin);

    const isLong     = side === "long";
    const size       = parseFloat((sizeUsd / midPx).toFixed(szDecimals));
    const limitPrice = isLong
      ? midPx * (1 + SLIPPAGE)
      : midPx * (1 - SLIPPAGE);

    console.log(`[hyperliquid-venue] OPEN ${side.toUpperCase()} ${size} ${coin} @ ~${limitPrice.toPrecision(5)}`);

    const resp = await this.exchange!.order({
      orders: [{
        a: idx,
        b: isLong,
        p: limitPrice.toPrecision(5),
        s: size.toString(),
        r: false,
        t: { limit: { tif: "Ioc" } },
      }],
      grouping: "na",
    });

    return this.parseReceipt(resp, midPx, size, undefined);
  }

  async closePosition(coin: string): Promise<OrderReceipt> {
    if (!this.exchange) throw new Error("HyperliquidVenue.closePosition: no wallet configured (read-only mode)");
    // Query the exchange for the live position size to avoid "reduce-only would
    // increase position" if the open IOC only partially filled.
    const state   = await this.info.clearinghouseState({ user: this.walletAddress as `0x${string}` });
    const exchPos = state.assetPositions.find((p) => p.position.coin === coin);
    const szi     = exchPos ? parseFloat(exchPos.position.szi) : 0;

    if (szi === 0) throw new Error(`[hyperliquid-venue] closePosition: no open position for ${coin}`);

    const actualSide: "long" | "short" = szi > 0 ? "long" : "short";
    const actualSize  = Math.abs(szi);
    const entryPrice  = parseFloat(exchPos!.position.entryPx ?? "0");

    const { idx, szDecimals, midPx } = await this.resolveMarket(coin);

    const closingBuy  = actualSide === "short";
    const limitPrice  = closingBuy
      ? midPx * (1 + SLIPPAGE)
      : midPx * (1 - SLIPPAGE);
    const sizeStr = actualSize.toFixed(szDecimals);

    console.log(`[hyperliquid-venue] CLOSE ${actualSide.toUpperCase()} ${sizeStr} ${coin} @ ~${limitPrice.toPrecision(5)}`);

    const resp = await this.exchange!.order({
      orders: [{
        a: idx,
        b: closingBuy,
        p: limitPrice.toPrecision(5),
        s: sizeStr,
        r: true,  // reduce-only
        t: { limit: { tif: "Ioc" } },
      }],
      grouping: "na",
    });

    const pnl = actualSide === "long"
      ? (midPx - entryPrice) * actualSize
      : (entryPrice - midPx) * actualSize;

    return this.parseReceipt(resp, midPx, actualSize, pnl);
  }

  async checkTradingReady(): Promise<void> {
    if (!this.exchange) {
      throw new Error(
        "HyperliquidVenue: no wallet configured (read-only mode). " +
        "Set HL_PRIVATE_KEY in .env to enable live trading.",
      );
    }
    // exchange client is present — assumed healthy
  }

  async getAccountEquity(): Promise<number | null> {
    if (!this.walletAddress) return null; // read-only mode
    const state  = await this.info.clearinghouseState({ user: this.walletAddress as `0x${string}` });
    const equity = parseFloat(state.marginSummary.accountValue);
    return Number.isFinite(equity) && equity > 0 ? equity : null;
  }

  async getAllPositions(): Promise<import("../venue.js").VenuePosition[]> {
    if (!this.walletAddress) return [];
    const state = await this.info.clearinghouseState({ user: this.walletAddress as `0x${string}` });
    const results: import("../venue.js").VenuePosition[] = [];
    for (const ap of state.assetPositions) {
      const szi = parseFloat(ap.position.szi);
      if (szi === 0) continue;
      const side: "long" | "short" = szi > 0 ? "long" : "short";
      const size       = Math.abs(szi);
      const entryPrice = parseFloat(ap.position.entryPx ?? "0");
      const markPrice  = (await this.getMarkPrice(ap.position.coin)) ?? 0;
      const unrealisedPnl = side === "long"
        ? (markPrice - entryPrice) * size
        : (entryPrice - markPrice) * size;
      results.push({ coin: ap.position.coin, side, size, entryPrice, markPrice, unrealisedPnl });
    }
    return results;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private findCoin(universe: { name: string }[], coin: string): number {
    return universe.findIndex((u) => u.name.toUpperCase() === coin.toUpperCase());
  }

  private async resolveMarket(coin: string): Promise<{ idx: number; szDecimals: number; midPx: number }> {
    const [meta, ctxs] = await this.info.metaAndAssetCtxs();
    const idx = this.findCoin(meta.universe, coin);
    if (idx === -1) throw new Error(`Coin "${coin}" not found in Hyperliquid universe`);

    // Populate asset cache as a side-effect
    if (!this.assetCache.has(coin)) {
      this.assetCache.set(coin, { index: idx, szDecimals: meta.universe[idx].szDecimals });
    }

    const midPx = parseFloat(ctxs[idx].midPx ?? "0");
    if (midPx === 0) throw new Error(`No mark price for ${coin}`);

    return { idx, szDecimals: meta.universe[idx].szDecimals, midPx };
  }

  private parseReceipt(
    resp:      Awaited<ReturnType<ExchangeClient["order"]>>,
    fallbackPx: number,
    fallbackSz: number,
    pnl:       number | undefined,
  ): OrderReceipt {
    const status = resp.response.data.statuses[0];

    if (typeof status === "string") {
      // IOC acknowledged but not immediately filled — treat as filled at fallback price
      return { orderId: `pending-${Date.now()}`, fillPrice: fallbackPx, fillSize: fallbackSz, pnl };
    }

    if ("error" in status) {
      throw new Error(`Order rejected by exchange: ${status.error}`);
    }

    const filled    = "filled"  in status ? status.filled  : null;
    const resting   = "resting" in status ? status.resting : null;
    const orderId   = filled?.oid.toString() ?? resting?.oid.toString() ?? `oid-${Date.now()}`;
    const fillPrice = filled ? parseFloat(filled.avgPx)   : fallbackPx;
    const fillSize  = filled ? parseFloat(filled.totalSz) : fallbackSz;

    return { orderId, fillPrice, fillSize, pnl };
  }
}
