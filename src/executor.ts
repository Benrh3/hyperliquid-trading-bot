import { HttpTransport, InfoClient, ExchangeClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { bus } from "./events.js";
import { config, getPrivateKey } from "./config.js";
import type { Signal } from "./events.js";

// Market order via limit-IOC with a slippage cushion so it always crosses the spread.
const SLIPPAGE = 0.02;

export class Executor {
  private readonly exchange: ExchangeClient;
  private readonly info: InfoClient;
  private readonly walletAddress: string;
  private assetIndex = -1;
  private szDecimals = 5;
  private currentPrice = 0;
  private readonly dryRun: boolean;

  constructor(dryRun = true) {
    this.dryRun = dryRun;

    const isTestnet = config.exchange.network === "testnet";
    const key = getPrivateKey();
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
      if (tick.bid > 0) this.currentPrice = tick.mid;
    });

    bus.on("signal:approved", (signal) => {
      this.execute(signal).catch((err: Error) => {
        // Safety net — execute() handles its own errors; this only fires
        // if something truly unexpected escapes.
        console.error("[executor] Unhandled error in execute():", err);
        bus.emit("error", "executor", err);
      });
    });
  }

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
      `[executor] ${config.exchange.coin} → asset index ${idx} (szDecimals=${this.szDecimals})`,
    );
  }

  private async execute(signal: Signal): Promise<void> {
    // Single try-catch covers the whole flow — including resolveAssetIndex —
    // so no error path can silently escape.
    try {
      if (this.currentPrice === 0) {
        console.warn("[executor] No price available yet — skipping signal");
        return;
      }

      await this.resolveAssetIndex();

      const isLong  = signal.side === "long";
      const rawSize = config.risk.maxPositionSizeUsd / this.currentPrice;
      const size    = parseFloat(rawSize.toFixed(this.szDecimals));

      const limitPrice = isLong
        ? this.currentPrice * (1 + SLIPPAGE)
        : this.currentPrice * (1 - SLIPPAGE);

      // Hyperliquid rejects prices with more than 5 significant figures.
      const priceStr = limitPrice.toPrecision(5);
      const sizeStr  = size.toString();

      console.log(
        `[executor] ${this.dryRun ? "DRY-RUN " : ""}${signal.side.toUpperCase()} ` +
        `${sizeStr} ${config.exchange.coin} @ ~$${priceStr} (${signal.reason})`,
      );

      if (this.dryRun) {
        bus.emit("trade", {
          orderId:   `dry-${Date.now()}`,
          coin:      config.exchange.coin,
          side:      signal.side,
          size,
          price:     this.currentPrice,
          timestamp: Date.now(),
          success:   true,
        });
        return;
      }

      // ── Place order via HTTP REST ────────────────────────────────────────
      console.log(`[executor] POST order → ${config.exchange.network} REST`);

      let resp: Awaited<ReturnType<typeof this.exchange.order>>;
      try {
        resp = await this.exchange.order({
          orders: [{
            a: this.assetIndex,
            b: isLong,
            p: priceStr,
            s: sizeStr,
            r: false,
            t: { limit: { tif: "Ioc" } },
          }],
          grouping: "na",
        });

        // Log the full response — critical for diagnosing partial fills,
        // rejected orders, or unexpected statuses.
        console.log("[executor] Exchange response:", JSON.stringify(resp, null, 2));
      } catch (orderErr) {
        // ApiRequestError carries a .response field with the raw exchange
        // payload (e.g. {"status":"err","response":"Insufficient margin"}).
        if (orderErr !== null && typeof orderErr === "object" && "response" in orderErr) {
          console.error(
            "[executor] Exchange API error response:\n" +
            JSON.stringify((orderErr as { response: unknown }).response, null, 2),
          );
        }
        throw orderErr;
      }

      // ── Parse status ─────────────────────────────────────────────────────
      const status = resp.response.data.statuses[0];

      if (typeof status === "string") {
        // "waitingForFill" or "waitingForTrigger" — should not occur for IOC
        // but handle defensively.
        console.log(`[executor] Unexpected pending status: ${status}`);
        bus.emit("trade", {
          orderId:   `pending-${Date.now()}`,
          coin:      config.exchange.coin,
          side:      signal.side,
          size,
          price:     this.currentPrice,
          timestamp: Date.now(),
          success:   true,
        });
        return;
      }

      if ("error" in status) {
        // Individual order error inside a top-level "ok" envelope.
        // The SDK may already have thrown for this; guard defensively.
        throw new Error(`Order status error: ${status.error}`);
      }

      const filled  = "filled" in status ? status.filled : null;
      const orderId = filled?.oid.toString() ??
        ("resting" in status ? status.resting.oid.toString() : `oid-${Date.now()}`);
      const fillPrice = filled ? parseFloat(filled.avgPx) : this.currentPrice;
      const fillSize  = filled ? parseFloat(filled.totalSz) : size;

      console.log(
        `[executor] Filled oid=${orderId} sz=${fillSize} avgPx=${fillPrice}`,
      );

      bus.emit("trade", {
        orderId,
        coin:      config.exchange.coin,
        side:      signal.side,
        size:      fillSize,
        price:     fillPrice,
        timestamp: Date.now(),
        success:   true,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[executor] Order failed: ${error.message}`);

      // Emit error so the logger records it as an event.
      bus.emit("error", "executor", error);

      // Emit a failed trade so the dashboard and DB reflect the attempt.
      const fallbackSize = this.currentPrice > 0
        ? parseFloat((config.risk.maxPositionSizeUsd / this.currentPrice).toFixed(this.szDecimals))
        : 0;

      bus.emit("trade", {
        orderId:   `failed-${Date.now()}`,
        coin:      config.exchange.coin,
        side:      signal.side,
        size:      fallbackSize,
        price:     this.currentPrice,
        timestamp: Date.now(),
        success:   false,
        error:     error.message,
      });
    }
  }
}
