import { bus } from "./events.js";
import { config } from "./config.js";
import type { Signal } from "./events.js";
import type { Venue } from "./venue.js";

// Market order via limit-IOC with a slippage cushion so it always crosses the spread.
// (Slippage is applied inside the venue; this constant is kept here for the dry-run simulation.)
const SLIPPAGE = 0.02;

interface LocalPosition {
  coin:       string;
  side:       "long" | "short";
  size:       number;
  entryPrice: number;
}

/**
 * Executor — bus-integrated order router.
 *
 * Listens for "signal:approved" events, opens/closes positions via the
 * injected Venue, and emits "trade" events for the logger.
 *
 * Dry-run mode simulates fills locally without calling the venue.
 */
export class Executor {
  private readonly venue:  Venue;
  private readonly dryRun: boolean;

  private currentPrices = new Map<string, number>(); // per-coin live prices from ticks
  private position:   LocalPosition | null = null;
  /** Prevents a concurrent close attempt while one REST call is in flight. */
  private closing = false;

  constructor(venue: Venue, dryRun = true) {
    this.venue  = venue;
    this.dryRun = dryRun;

    const modeTag = dryRun ? "DRY-RUN" : "LIVE";
    console.log(`[executor] Ready — ${modeTag} via ${venue.name}`);

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

  // ── Public API ────────────────────────────────────────────────────────────

  getPosition(): {
    coin: string; side: "long" | "short"; size: number; entryPrice: number;
    unrealisedPnl: number; unrealisedPnlPercent: number;
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

  // ── Signal routing ────────────────────────────────────────────────────────

  private async handleSignal(signal: Signal): Promise<void> {
    if (signal.side === "close") {
      await this.closePosition("Close signal from strategy");
      return;
    }
    if (this.position?.side === signal.side) {
      console.log(`[executor] Already in ${signal.side} — ignoring duplicate signal`);
      return;
    }
    if (this.position) {
      console.log(`[executor] Reversing ${this.position.side} → ${signal.side}`);
      await this.closePosition(`Reversing to ${signal.side}`);
      if (this.position) {
        console.warn("[executor] Close failed — aborting reversal");
        return;
      }
    }
    await this.openPosition(signal);
  }

  // ── Stop-loss ─────────────────────────────────────────────────────────────

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
        `[executor] Stop-loss triggered: ${loss.toFixed(2)}% on ` +
        `${side} ${coin} entered @ $${entryPrice} (now $${currentPrice.toFixed(1)})`,
      );
      this.closePosition(`Stop-loss ${loss.toFixed(2)}%`).catch((err: Error) => {
        bus.emit("error", "executor", err);
      });
    }
  }

  // ── Open position ─────────────────────────────────────────────────────────

  private async openPosition(signal: Signal): Promise<void> {
    if (signal.side === "close") return;
    const coin         = signal.coin;
    const currentPrice = this.currentPrices.get(coin) ?? 0;

    try {
      if (this.dryRun) {
        if (currentPrice === 0) {
          console.warn(`[executor] DRY-RUN: no price for ${coin} yet — skipping`);
          return;
        }
        const size = config.risk.maxPositionSizeUsd / currentPrice;
        console.log(`[executor] DRY-RUN OPEN ${signal.side.toUpperCase()} ${size.toFixed(5)} ${coin} @ ~$${currentPrice.toFixed(2)} (${signal.reason})`);
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

      const receipt = await this.venue.openPosition(coin, signal.side, config.risk.maxPositionSizeUsd);
      this.position  = { coin, side: signal.side, size: receipt.fillSize, entryPrice: receipt.fillPrice };
      bus.emit("trade", {
        orderId:   receipt.orderId,
        coin,
        side:      signal.side,
        size:      receipt.fillSize,
        price:     receipt.fillPrice,
        timestamp: Date.now(),
        success:   true,
        reason:    signal.reason,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[executor] Open failed: ${error.message}`);
      bus.emit("error", "executor", error);
      bus.emit("trade", {
        orderId:   `failed-${Date.now()}`,
        coin,
        side:      signal.side,
        size:      currentPrice > 0 ? config.risk.maxPositionSizeUsd / currentPrice : 0,
        price:     currentPrice,
        timestamp: Date.now(),
        success:   false,
        error:     error.message,
      });
    }
  }

  // ── Close position ────────────────────────────────────────────────────────

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
          `${localSize} ${coin} @ ~$${currentPrice.toFixed(2)} (${reason}) est. PnL: $${pnl.toFixed(2)}`,
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
        console.warn(`[executor] No price for ${coin} yet — deferring close`);
        return;
      }

      const receipt  = await this.venue.closePosition(coin);
      this.position  = null;
      const pnl      = localSide === "long"
        ? (receipt.fillPrice - entryPrice) * receipt.fillSize
        : (entryPrice - receipt.fillPrice) * receipt.fillSize;

      console.log(
        `[executor] Closed ${localSide} ${coin} oid=${receipt.orderId}` +
        ` sz=${receipt.fillSize} avgPx=${receipt.fillPrice} PnL=$${pnl.toFixed(2)}`,
      );
      bus.emit("trade", {
        orderId:   receipt.orderId,
        coin,
        side:      localSide,
        size:      receipt.fillSize,
        price:     receipt.fillPrice,
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
