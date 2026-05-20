import { bus } from "./events.js";
import { config } from "./config.js";
import type { Signal } from "./events.js";

export class RiskManager {
  private dailyPnl = 0;
  private startingBalance: number;
  private currentBalance: number;
  private openPositionSize = 0;

  constructor(initialBalance: number) {
    this.startingBalance = initialBalance;
    this.currentBalance = initialBalance;

    // Listen for signals and gate them
    bus.on("signal", (signal) => this.evaluate(signal));

    // Track trade results to update P&L
    bus.on("trade", (result) => {
      if (result.success) {
        console.log(
          `[risk] Trade executed: ${result.side} ${result.size} ${result.coin} @ ${result.price}`,
        );
      }
    });

    // Reset daily P&L at midnight UTC
    this.scheduleDailyReset();
  }

  private evaluate(signal: Signal): void {
    // Close signals bypass all risk checks — never block an exit
    if (signal.side === "close") {
      bus.emit("signal:approved", signal);
      return;
    }

    const { maxPositionSizeUsd, maxDailyLossPercent, maxLeverage } =
      config.risk;

    // Check 1: Daily loss limit
    const dailyLossLimit = this.startingBalance * (maxDailyLossPercent / 100);
    if (this.dailyPnl <= -dailyLossLimit) {
      bus.emit(
        "signal:rejected",
        signal,
        `Daily loss limit reached (${this.dailyPnl.toFixed(2)} USD)`,
      );
      return;
    }

    // Check 2: Max position size
    if (this.openPositionSize >= maxPositionSizeUsd) {
      bus.emit(
        "signal:rejected",
        signal,
        `Max position size reached (${this.openPositionSize.toFixed(2)} / ${maxPositionSizeUsd} USD)`,
      );
      return;
    }

    // Check 3: Leverage within limits
    if (config.exchange.leverage > maxLeverage) {
      bus.emit(
        "signal:rejected",
        signal,
        `Configured leverage ${config.exchange.leverage}x exceeds max ${maxLeverage}x`,
      );
      return;
    }

    // All checks passed
    console.log(`[risk] Signal approved: ${signal.side} ${signal.coin}`);
    bus.emit("signal:approved", signal);
  }

  /** Call this when position size changes (from executor) */
  updatePosition(sizeUsd: number): void {
    this.openPositionSize = sizeUsd;
  }

  /** Call this when a trade closes to update daily P&L */
  recordPnl(pnl: number): void {
    this.dailyPnl += pnl;
    this.currentBalance += pnl;
  }

  private scheduleDailyReset(): void {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      this.dailyPnl = 0;
      this.startingBalance = this.currentBalance;
      console.log("[risk] Daily P&L reset");
      this.scheduleDailyReset();
    }, msUntilMidnight);
  }

  getStatus() {
    return {
      dailyPnl: this.dailyPnl,
      currentBalance: this.currentBalance,
      openPositionSize: this.openPositionSize,
      dailyLossLimit:
        this.startingBalance * (config.risk.maxDailyLossPercent / 100),
    };
  }
}
