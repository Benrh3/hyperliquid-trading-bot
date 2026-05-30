import { HttpTransport, InfoClient, ExchangeClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { bus } from "./events.js";
import { config, getPrivateKey } from "./config.js";
import type { Signal } from "./events.js";

// Market order via limit-IOC with a slippage cushion so it always crosses the spread.
const SLIPPAGE = 0.02;

interface Position {
  coin:       string;
  side:       "long" | "short";
  size:       number;
  entryPrice: number;
}

interface AssetInfo {
  index:      number;
  szDecimals: number;
}

export class Executor {
  private readonly exchange: ExchangeClient;
  private readonly info:     InfoClient;
  private readonly walletAddress: string;
  private readonly dryRun: boolean;

  private readonly assetCache = new Map<string, AssetInfo>();
  private currentPrices = new Map<string, number>(); // per-coin live prices

  private position: Position | null = null;
  // Guard: prevents a second close attempt while one is already in flight
  // (e.g. stop-loss tick fires again before the REST call returns).
  private closing = false;

  constructor(dryRun = true) {
    this.dryRun = dryRun;

    const isTestnet = config.exchange.network === "testnet";
    const key    = getPrivateKey();
    const wallet = privateKeyToAccount(key);
    this.walletAddress = wallet.address;

    // Each client gets its own HttpTransport — REST only, no WebSocket,
    // so order placement is never affected by subscription socket churn.
    this.exchange = new ExchangeClient({
      wallet,
      transport: new HttpTransport({ isTestnet }),
    });
    this.info = new InfoClient({
      transport: new HttpTransport({ isTestnet }),
    });

    const modeTag = dryRun ? "DRY-RUN" : "LIVE";
    console.log(`[executor] Ready — ${modeTag} on ${config.exchange.network}`);
    console.log(`[executor] Wallet: ${this.walletAddress}`);

    bus.on("tick", (tick) => {
      if (tick.bid > 0) {
        this.currentPrices.set(tick.coin, tick.mid);
        this.checkStopLoss();
      }
    });

    bus.on("signal:approved", (signal) => {
      this.handleSignal(signal).catch((err: Error) => {
        console.error("[executor] Unhandled error in handleSignal:", err);
        bus.emit("error", "executor", err);
      });
    });
  }

  // ── Public API ────────────────────────────────────────────────────────

  getPosition(): {
    coin: string;
    side: "long" | "short";
    size: number;
    entryPrice: number;
    unrealisedPnl: number;
    unrealisedPnlPercent: number;
  } | null {
    if (!this.position) return null;
    const { coin, side, size, entryPrice } = this.position;
    const currentPrice = this.currentPrices.get(coin) ?? 0;
    if (currentPrice === 0) return null;
    const unrealisedPnl = side === "long"
      ? (currentPrice - entryPrice) * size
      : (entryPrice - currentPrice) * size;
    const unrealisedPnlPercent = entryPrice > 0
      ? (unrealisedPnl / (entryPrice * size)) * 100
      : 0;
    return { coin, side, size, entryPrice, unrealisedPnl, unrealisedPnlPercent };
  }

  // ── Signal routing ────────────────────────────────────────────────────

  private async handleSignal(signal: Signal): Promise<void> {
    if (signal.side === "close") {
      await this.closePosition("Close signal from strategy");
      return;
    }

    // Duplicate direction — already in this trade, nothing to do
    if (this.position?.side === signal.side) {
      console.log(`[executor] Already in ${signal.side} — ignoring duplicate signal`);
      return;
    }

    // Opposite direction — close existing position first, then reverse
    if (this.position) {
      console.log(`[executor] Reversing ${this.position.side} → ${signal.side}`);
      await this.closePosition(`Reversing to ${signal.side}`);
      // If close failed the position reference is still set; abort the reversal
      if (this.position) {
        console.warn("[executor] Close failed — aborting reversal");
        return;
      }
    }

    await this.openPosition(signal);
  }

  // ── Stop-loss (called on every tick with valid bid/ask) ───────────────

  private checkStopLoss(): void {
    if (!this.position || this.closing) return;
    const { coin, side, entryPrice } = this.position;
    const currentPrice = this.currentPrices.get(coin) ?? 0;
    if (currentPrice === 0) return;

    const loss = side === "long"
      ? (entryPrice - currentPrice) / entryPrice * 100
      : (currentPrice - entryPrice) / entryPrice * 100;

    if (loss >= config.risk.stopLossPercent) {
      console.warn(
        `[executor] Stop-loss triggered: ${loss.toFixed(2)}% loss on ` +
        `${side} ${coin} entered @ $${entryPrice} (now $${currentPrice.toFixed(1)})`,
      );
      this.closePosition(`Stop-loss ${loss.toFixed(2)}%`).catch((err: Error) => {
        bus.emit("error", "executor", err);
      });
    }
  }

  // ── Asset resolution (per-coin cache) ────────────────────────────────

  private async resolveAsset(coin: string): Promise<AssetInfo> {
    const cached = this.assetCache.get(coin);
    if (cached) return cached;

    const { universe } = await this.info.meta();
    const idx = universe.findIndex((u) => u.name.toUpperCase() === coin.toUpperCase());
    if (idx === -1) throw new Error(`Coin "${coin}" not found in perpetuals universe`);

    const asset: AssetInfo = { index: idx, szDecimals: universe[idx].szDecimals };
    this.assetCache.set(coin, asset);
    console.log(`[executor] ${coin} → asset index ${idx} (szDecimals=${asset.szDecimals})`);
    return asset;
  }

  // ── Open a new position ───────────────────────────────────────────────

  private async openPosition(signal: Signal): Promise<void> {
    if (signal.side === "close") return; // narrowing guard; should never reach here
    const coin         = signal.coin;
    const currentPrice = this.currentPrices.get(coin) ?? 0;
    try {
      if (currentPrice === 0) {
        console.warn(`[executor] No price for ${coin} yet — skipping signal`);
        return;
      }

      const { index: assetIndex, szDecimals } = await this.resolveAsset(coin);

      const isLong  = signal.side === "long";
      const rawSize = config.risk.maxPositionSizeUsd / currentPrice;
      const size    = parseFloat(rawSize.toFixed(szDecimals));

      const limitPrice = isLong
        ? currentPrice * (1 + SLIPPAGE)
        : currentPrice * (1 - SLIPPAGE);
      const priceStr = limitPrice.toPrecision(5);
      const sizeStr  = size.toString();

      console.log(
        `[executor] ${this.dryRun ? "DRY-RUN " : ""}OPEN ${signal.side.toUpperCase()} ` +
        `${sizeStr} ${coin} @ ~$${priceStr} (${signal.reason})`,
      );

      if (this.dryRun) {
        this.position = { coin, side: signal.side, size, entryPrice: currentPrice };
        bus.emit("trade", {
          orderId:   `dry-${Date.now()}`,
          coin,
          side:      signal.side,
          size,
          price:     currentPrice,
          timestamp: Date.now(),
          success:   true,
          reason:    signal.reason,
        });
        return;
      }

      console.log(`[executor] POST open order → ${config.exchange.network} REST`);

      let resp: Awaited<ReturnType<typeof this.exchange.order>>;
      try {
        resp = await this.exchange.order({
          orders: [{
            a: assetIndex,
            b: isLong,
            p: priceStr,
            s: sizeStr,
            r: false,
            t: { limit: { tif: "Ioc" } },
          }],
          grouping: "na",
        });
        console.log("[executor] Open response:", JSON.stringify(resp, null, 2));
      } catch (orderErr) {
        if (orderErr !== null && typeof orderErr === "object" && "response" in orderErr) {
          console.error(
            "[executor] Exchange API error:\n" +
            JSON.stringify((orderErr as { response: unknown }).response, null, 2),
          );
        }
        throw orderErr;
      }

      const status = resp.response.data.statuses[0];

      if (typeof status === "string") {
        console.log(`[executor] Open order pending: ${status}`);
        this.position = { coin, side: signal.side, size, entryPrice: currentPrice };
        bus.emit("trade", {
          orderId:   `pending-${Date.now()}`,
          coin,
          side:      signal.side,
          size,
          price:     currentPrice,
          timestamp: Date.now(),
          success:   true,
        });
        return;
      }

      if ("error" in status) {
        throw new Error(`Open order rejected: ${status.error}`);
      }

      const filled    = "filled" in status ? status.filled : null;
      const orderId   = filled?.oid.toString() ??
        ("resting" in status ? status.resting.oid.toString() : `oid-${Date.now()}`);
      const fillPrice = filled ? parseFloat(filled.avgPx)   : currentPrice;
      const fillSize  = filled ? parseFloat(filled.totalSz) : size;

      console.log(`[executor] Opened ${signal.side} ${coin} oid=${orderId} sz=${fillSize} avgPx=${fillPrice}`);

      this.position = { coin, side: signal.side, size: fillSize, entryPrice: fillPrice };

      bus.emit("trade", {
        orderId,
        coin,
        side:      signal.side,
        size:      fillSize,
        price:     fillPrice,
        timestamp: Date.now(),
        success:   true,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[executor] Open failed: ${error.message}`);
      bus.emit("error", "executor", error);
      const asset      = this.assetCache.get(coin);
      const szDecimals = asset?.szDecimals ?? 5;
      const fallbackSize = currentPrice > 0
        ? parseFloat((config.risk.maxPositionSizeUsd / currentPrice).toFixed(szDecimals))
        : 0;
      bus.emit("trade", {
        orderId:   `failed-${Date.now()}`,
        coin,
        side:      signal.side,
        size:      fallbackSize,
        price:     currentPrice,
        timestamp: Date.now(),
        success:   false,
        error:     error.message,
      });
    }
  }

  // ── Close the current position ────────────────────────────────────────

  private async closePosition(reason: string): Promise<void> {
    if (!this.position) {
      console.log("[executor] closePosition called with no open position — ignoring");
      return;
    }
    if (this.closing) {
      console.log("[executor] Close already in progress — skipping");
      return;
    }
    this.closing = true;

    const { coin, side: localSide, size: localSize, entryPrice } = this.position;
    const currentPrice = this.currentPrices.get(coin) ?? 0;

    try {
      if (this.dryRun) {
        const pnl = localSide === "long"
          ? (currentPrice - entryPrice) * localSize
          : (entryPrice - currentPrice) * localSize;
        console.log(
          `[executor] DRY-RUN CLOSE ${localSide.toUpperCase()} ` +
          `${localSize} ${coin} @ ~$${currentPrice.toFixed(1)} (${reason}) ` +
          `est. PnL: $${pnl.toFixed(2)}`,
        );
        this.position = null;
        bus.emit("trade", {
          orderId:   `dry-close-${Date.now()}`,
          coin,
          side:      localSide,
          size:      localSize,
          price:     currentPrice,
          timestamp: Date.now(),
          success:   true,
          pnl,
          reason,
        });
        return;
      }

      if (currentPrice === 0) {
        // No tick received yet — cannot compute a valid limit price; stop-loss will retry on next tick
        console.warn(`[executor] No price for ${coin} yet — deferring close`);
        return;
      }

      // Query the exchange for the actual signed position size (szi).
      // Using local size risks "reduce-only order would increase position" if the open IOC
      // partially filled, or if the position was externally modified since we opened it.
      const state = await this.info.clearinghouseState({
        user: this.walletAddress as `0x${string}`,
      });
      const exchPos = state.assetPositions.find((p) => p.position.coin === coin);
      const szi = exchPos ? parseFloat(exchPos.position.szi) : 0;

      if (szi === 0) {
        // Exchange has no position for this coin — already flat; sync local state
        console.warn(`[executor] Exchange reports no ${coin} position — clearing local state`);
        this.position = null;
        return;
      }

      // szi is signed: positive = long, negative = short
      const actualSide: "long" | "short" = szi > 0 ? "long" : "short";
      const actualSize = Math.abs(szi);

      if (actualSide !== localSide) {
        console.warn(
          `[executor] Position side mismatch: local=${localSide} exchange=${actualSide} — ` +
          `trusting exchange`,
        );
      }

      const { index: assetIndex, szDecimals } = await this.resolveAsset(coin);

      // To close a long we sell (b: false); to close a short we buy (b: true)
      const closingBuy  = actualSide === "short";
      const limitPrice  = closingBuy
        ? currentPrice * (1 + SLIPPAGE)   // buy back to close short
        : currentPrice * (1 - SLIPPAGE);  // sell to close long
      const priceStr = limitPrice.toPrecision(5);
      const sizeStr  = actualSize.toFixed(szDecimals);

      console.log(
        `[executor] CLOSE ${actualSide.toUpperCase()} ${sizeStr} ${coin} @ ~$${priceStr} (${reason})`,
      );
      console.log(`[executor] POST close order → ${config.exchange.network} REST`);

      let resp: Awaited<ReturnType<typeof this.exchange.order>>;
      try {
        resp = await this.exchange.order({
          orders: [{
            a: assetIndex,
            b: closingBuy,
            p: priceStr,
            s: sizeStr,
            r: true,   // reduce-only — never accidentally opens a new position
            t: { limit: { tif: "Ioc" } },
          }],
          grouping: "na",
        });
        console.log("[executor] Close response:", JSON.stringify(resp, null, 2));
      } catch (orderErr) {
        if (orderErr !== null && typeof orderErr === "object" && "response" in orderErr) {
          console.error(
            "[executor] Close API error:\n" +
            JSON.stringify((orderErr as { response: unknown }).response, null, 2),
          );
        }
        throw orderErr;
      }

      const status = resp.response.data.statuses[0];

      if (typeof status === "string") {
        console.log(`[executor] Close order pending: ${status}`);
        // Treat pending as closed — IOC should not rest
        this.position = null;
        bus.emit("trade", {
          orderId:   `close-pending-${Date.now()}`,
          coin,
          side:      localSide,
          size:      actualSize,
          price:     currentPrice,
          timestamp: Date.now(),
          success:   true,
        });
        return;
      }

      if ("error" in status) {
        throw new Error(`Close order rejected: ${status.error}`);
      }

      const filled    = "filled" in status ? status.filled : null;
      const orderId   = filled?.oid.toString() ??
        ("resting" in status ? status.resting.oid.toString() : `close-${Date.now()}`);
      const fillPrice = filled ? parseFloat(filled.avgPx)   : currentPrice;
      const fillSize  = filled ? parseFloat(filled.totalSz) : actualSize;

      const pnl = localSide === "long"
        ? (fillPrice - entryPrice) * fillSize
        : (entryPrice - fillPrice) * fillSize;

      console.log(
        `[executor] Closed ${localSide} ${coin} oid=${orderId} sz=${fillSize} avgPx=${fillPrice} ` +
        `PnL=$${pnl.toFixed(2)}`,
      );

      this.position = null;

      bus.emit("trade", {
        orderId,
        coin,
        side:      localSide,
        size:      fillSize,
        price:     fillPrice,
        timestamp: Date.now(),
        success:   true,
        pnl,
        reason,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[executor] Close failed: ${error.message}`);
      bus.emit("error", "executor", error);
      // Do NOT clear this.position on failure — the position may still be open
    } finally {
      this.closing = false;
    }
  }
}
