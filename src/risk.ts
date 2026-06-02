import { bus } from "./events.js";
import { config } from "./config.js";
import type { Signal } from "./events.js";

export class RiskManager {
  private dailyPnl        = 0;
  private startingBalance: number;
  private currentBalance:  number;

  /**
   * Tracks the dollar-at-risk for each open live position, keyed by coin.
   * Populated by "trade" open events; cleared by "trade" close events.
   * Only live (non-paper) trade events reach the logger and bus, so this
   * map only covers real exchange positions.
   */
  private openRisks = new Map<string, number>(); // coin → dollar risk

  constructor(initialBalance: number) {
    this.startingBalance = initialBalance;
    this.currentBalance  = initialBalance;

    bus.on("signal", (signal) => this.evaluate(signal));

    bus.on("trade", (result) => {
      if (!result.success) return;
      const stopFrac = config.risk.stopLossPercent / 100;
      if (result.pnl === undefined) {
        // Open trade — record dollar risk for this coin
        const risk = result.size * result.price * stopFrac;
        this.openRisks.set(result.coin, risk);
      } else {
        // Close trade — position exited, remove its risk
        this.openRisks.delete(result.coin);
        if (result.pnl !== 0) {
          this.dailyPnl       += result.pnl;
          this.currentBalance += result.pnl;
        }
      }
    });

    // ── Reconcile risk map from ground truth (improvement 3) ──────────────
    // The reconciliation loop emits this event after every detectOrphans() call
    // with the complete list of positions currently open on the exchange.
    // Rebuilding from the exchange beats relying solely on trade events, which
    // can be missed if the process crashes mid-trade or the bus event is lost.
    bus.on("reconcile:positions", (positions) => {
      const stopFrac = config.risk.stopLossPercent / 100;
      this.openRisks.clear();
      for (const p of positions) {
        const risk = p.size * p.price * stopFrac;
        if (risk > 0) this.openRisks.set(p.coin, risk);
      }
    });

    this.scheduleDailyReset();
  }

  private evaluate(signal: Signal): void {
    if (signal.paper) return; // paper signals never route to executor

    // Close signals bypass all risk checks — never block an exit
    if (signal.side === "close") {
      bus.emit("signal:approved", signal);
      return;
    }

    const { maxDailyLossPercent, maxLeverage, riskPerTradePercent, maxConcurrentRiskPercent } =
      config.risk;

    // ── Check 1: Daily loss limit ────────────────────────────────────────────
    const dailyLossLimit = this.startingBalance * (maxDailyLossPercent / 100);
    if (this.dailyPnl <= -dailyLossLimit) {
      bus.emit(
        "signal:rejected",
        signal,
        `Daily loss limit reached (${this.dailyPnl.toFixed(2)} USD / -${dailyLossLimit.toFixed(2)} limit)`,
      );
      return;
    }

    // ── Check 2: Max leverage ────────────────────────────────────────────────
    if (config.exchange.leverage > maxLeverage) {
      bus.emit(
        "signal:rejected",
        signal,
        `Configured leverage ${config.exchange.leverage}x exceeds max ${maxLeverage}x`,
      );
      return;
    }

    // ── Check 3: Portfolio concurrent-risk cap ───────────────────────────────
    const existingRiskUsd  = [...this.openRisks.values()].reduce((a, b) => a + b, 0);
    const newTradeRiskUsd  = this.currentBalance * (riskPerTradePercent / 100);
    const maxRiskUsd       = this.currentBalance * (maxConcurrentRiskPercent / 100);
    if (existingRiskUsd + newTradeRiskUsd > maxRiskUsd) {
      const currentPct = (existingRiskUsd / this.currentBalance * 100).toFixed(1);
      const maxPct     = maxConcurrentRiskPercent.toFixed(1);
      bus.emit(
        "signal:rejected",
        signal,
        `[risk] Trade rejected — would exceed portfolio risk cap (current: ${currentPct}%, max: ${maxPct}%)`,
      );
      return;
    }

    console.log(
      `[risk] Signal approved: ${signal.side} ${signal.coin}` +
      ` (open risk: $${existingRiskUsd.toFixed(2)}, adding ~$${newTradeRiskUsd.toFixed(2)}, cap $${maxRiskUsd.toFixed(2)})`,
    );
    bus.emit("signal:approved", signal);
  }

  private scheduleDailyReset(): void {
    const now      = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);

    setTimeout(() => {
      this.dailyPnl        = 0;
      this.startingBalance = this.currentBalance;
      console.log("[risk] Daily P&L reset");
      this.scheduleDailyReset();
    }, tomorrow.getTime() - now.getTime());
  }

  getStatus() {
    const openRiskUsd   = [...this.openRisks.values()].reduce((a, b) => a + b, 0);
    const openRiskPct   = this.currentBalance > 0
      ? (openRiskUsd / this.currentBalance) * 100
      : 0;
    return {
      dailyPnl:             this.dailyPnl,
      currentBalance:       this.currentBalance,
      openRiskUsd,
      openRiskPct,
      maxConcurrentRiskPct: config.risk.maxConcurrentRiskPercent,
      riskPerTradePct:      config.risk.riskPerTradePercent,
      stopLossPct:          config.risk.stopLossPercent,
      dailyLossLimit:       this.startingBalance * (config.risk.maxDailyLossPercent / 100),
    };
  }
}
