import { InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { bus } from "../events.js";
import { config, coins } from "../config.js";
import type { Strategy } from "./base.js";
import type { Candle, Signal } from "../events.js";

// Signal when predicted hourly rate exceeds these thresholds
const THRESHOLD_HIGH = 0.0003; // > 0.03% → short to collect funding
const THRESHOLD_LOW  = 0.0000; // < 0.00% → long to collect negative funding

const POLL_INTERVAL_MS = 60_000;
const HOURS_PER_YEAR   = 24 * 365;

interface FundingState {
  currentRate:    number | null;
  predictedRate:  number | null;
  nextFundingTime: number | null;
  annualizedPct:  number | null;
  lastUpdated:    Date | null;
  signalCount:    number;
}

export class FundingRateStrategy implements Strategy {
  name = "funding-rate";

  private readonly coin: string;
  private readonly info: InfoClient;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private state: FundingState = {
    currentRate:    null,
    predictedRate:  null,
    nextFundingTime: null,
    annualizedPct:  null,
    lastUpdated:    null,
    signalCount:    0,
  };

  constructor() {
    this.coin = coins[0];
    const isTestnet = config.exchange.network === "testnet";
    this.info = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
  }

  onCandle(_candle: Candle, _history: Candle[]): Signal | null {
    return null; // operates on its own polling schedule
  }

  async init(_history: Candle[]): Promise<void> {
    await this.poll();
    this.pollTimer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
    console.log("[funding-rate] Polling started (60s interval)");
  }

  getState(): Record<string, unknown> {
    return { ...this.state };
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      // ── Current funding rate ───────────────────────────────────────────
      const [meta, assetCtxs] = await this.info.metaAndAssetCtxs();
      const idx = meta.universe.findIndex((u) => u.name === this.coin);
      if (idx === -1) {
        console.warn(`[funding-rate] ${this.coin} not found in universe`);
        return;
      }
      const currentRate = parseFloat(assetCtxs[idx].funding);

      // ── Predicted funding rate ─────────────────────────────────────────
      const predictions = await this.info.predictedFundings();
      let predictedRate:   number | null = null;
      let nextFundingTime: number | null = null;

      const entry = predictions.find(([asset]) => asset === this.coin);
      if (entry) {
        const [, exchanges] = entry;
        // Take the first exchange entry that has data (usually "HlPerp")
        for (const [, data] of exchanges) {
          if (data) {
            predictedRate   = parseFloat(data.fundingRate);
            nextFundingTime = data.nextFundingTime;
            break;
          }
        }
      }

      const annualizedPct = currentRate * HOURS_PER_YEAR * 100;

      this.state = {
        currentRate,
        predictedRate,
        nextFundingTime,
        annualizedPct,
        lastUpdated: new Date(),
        signalCount: this.state.signalCount,
      };

      console.log(
        `[funding-rate] ${this.coin} current=${(currentRate * 100).toFixed(4)}%` +
        (predictedRate !== null ? ` predicted=${(predictedRate * 100).toFixed(4)}%` : "") +
        ` annualized=${annualizedPct.toFixed(1)}%/yr`
      );

      // ── Signal logic ───────────────────────────────────────────────────
      if (predictedRate !== null) {
        const annPred = predictedRate * HOURS_PER_YEAR * 100;

        if (predictedRate > THRESHOLD_HIGH) {
          this.state.signalCount++;
          const signal: Signal = {
            side: "short",
            coin: this.coin,
            reason: `Funding ${(predictedRate * 100).toFixed(4)}%/hr → ${annPred.toFixed(1)}%/yr annualized`,
            timestamp: Date.now(),
          };
          console.log(`[funding-rate] Signal: ${signal.side} — ${signal.reason}`);
          bus.emit("signal", signal);
        } else if (predictedRate < THRESHOLD_LOW) {
          this.state.signalCount++;
          const signal: Signal = {
            side: "long",
            coin: this.coin,
            reason: `Negative funding ${(predictedRate * 100).toFixed(4)}%/hr → collect ${Math.abs(annPred).toFixed(1)}%/yr`,
            timestamp: Date.now(),
          };
          console.log(`[funding-rate] Signal: ${signal.side} — ${signal.reason}`);
          bus.emit("signal", signal);
        }
      }
    } catch (e) {
      console.error("[funding-rate] Poll failed:", (e as Error).message);
      bus.emit("error", "funding-rate", e as Error);
    }
  }
}
