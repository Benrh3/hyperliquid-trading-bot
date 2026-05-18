import { HttpTransport, InfoClient, ExchangeClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { bus } from "./events.js";
import { config, getPrivateKey } from "./config.js";
import type { Signal } from "./events.js";

// Slippage applied to the mid price when submitting the limit-as-market order.
const SLIPPAGE = 0.02; // 2 %

export class Executor {
  private exchange: ExchangeClient;
  private info: InfoClient;
  private assetIndex = -1;
  private szDecimals = 5;
  private currentPrice = 0;
  private readonly dryRun: boolean;

  constructor(dryRun = true) {
    this.dryRun = dryRun;

    const isTestnet = config.exchange.network === "testnet";
    const transport = new HttpTransport({ isTestnet });

    const key = getPrivateKey();
    const wallet = privateKeyToAccount(key);

    this.exchange = new ExchangeClient({ wallet, transport });
    this.info = new InfoClient({ transport });

    // Track current price from tick events
    bus.on("tick", (tick) => {
      if (tick.bid > 0) this.currentPrice = tick.mid;
    });

    bus.on("signal:approved", (signal) => {
      this.execute(signal).catch((err: Error) => {
        bus.emit("error", "executor", err);
      });
    });

    const modeTag = dryRun ? "DRY-RUN" : "LIVE";
    console.log(`[executor] Ready — ${modeTag} mode, ${config.exchange.network}`);
  }

  /** Resolve coin → asset index once, before the first order. */
  private async resolveAssetIndex(): Promise<void> {
    if (this.assetIndex >= 0) return;

    const { universe } = await this.info.meta();
    const idx = universe.findIndex(
      (u) => u.name.toUpperCase() === config.exchange.coin.toUpperCase(),
    );
    if (idx === -1) {
      throw new Error(`Coin "${config.exchange.coin}" not found in perpetuals universe`);
    }
    this.assetIndex = idx;
    this.szDecimals = universe[idx].szDecimals;
    console.log(
      `[executor] ${config.exchange.coin} is asset index ${idx} (szDecimals=${this.szDecimals})`,
    );
  }

  private async execute(signal: Signal): Promise<void> {
    if (this.currentPrice === 0) {
      console.warn("[executor] No price available yet — skipping signal");
      return;
    }

    await this.resolveAssetIndex();

    const isLong = signal.side === "long";
    const rawSize = config.risk.maxPositionSizeUsd / this.currentPrice;
    const size = parseFloat(rawSize.toFixed(this.szDecimals));

    // Market order via limit IOC with slippage-adjusted price so it always fills.
    const limitPrice = isLong
      ? this.currentPrice * (1 + SLIPPAGE)
      : this.currentPrice * (1 - SLIPPAGE);

    // Hyperliquid prices must not exceed 6 significant figures.
    const priceStr = limitPrice.toPrecision(5);
    const sizeStr = size.toString();

    console.log(
      `[executor] ${this.dryRun ? "DRY-RUN " : ""}${signal.side.toUpperCase()} ` +
      `${sizeStr} ${config.exchange.coin} @ ~$${priceStr} ` +
      `(reason: ${signal.reason})`,
    );

    if (this.dryRun) {
      bus.emit("trade", {
        orderId: `dry-${Date.now()}`,
        coin: config.exchange.coin,
        side: signal.side,
        size,
        price: this.currentPrice,
        timestamp: Date.now(),
        success: true,
      });
      return;
    }

    try {
      const resp = await this.exchange.order({
        orders: [
          {
            a: this.assetIndex,
            b: isLong,
            p: priceStr,
            s: sizeStr,
            r: false,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      });

      const status = resp.response.data.statuses[0];

      if (typeof status === "string") {
        // "waitingForFill" or "waitingForTrigger" — treat as pending success
        console.log(`[executor] Order status: ${status}`);
        bus.emit("trade", {
          orderId: `pending-${Date.now()}`,
          coin: config.exchange.coin,
          side: signal.side,
          size,
          price: this.currentPrice,
          timestamp: Date.now(),
          success: true,
        });
        return;
      }

      if ("error" in status) {
        throw new Error(`Order rejected by exchange: ${status.error}`);
      }

      const filled = "filled" in status ? status.filled : null;
      const orderId =
        filled?.oid.toString() ??
        ("resting" in status ? status.resting.oid.toString() : `oid-${Date.now()}`);
      const fillPrice = filled ? parseFloat(filled.avgPx) : this.currentPrice;
      const fillSize = filled ? parseFloat(filled.totalSz) : size;

      console.log(
        `[executor] Filled oid=${orderId} sz=${fillSize} avgPx=${fillPrice}`,
      );

      bus.emit("trade", {
        orderId,
        coin: config.exchange.coin,
        side: signal.side,
        size: fillSize,
        price: fillPrice,
        timestamp: Date.now(),
        success: true,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[executor] Order failed: ${error.message}`);
      bus.emit("trade", {
        orderId: `failed-${Date.now()}`,
        coin: config.exchange.coin,
        side: signal.side,
        size,
        price: this.currentPrice,
        timestamp: Date.now(),
        success: false,
        error: error.message,
      });
    }
  }
}
