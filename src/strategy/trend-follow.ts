import { EMA } from "technicalindicators";
import type { Strategy } from "./base.js";
import type { Candle, Signal } from "../events.js";
import { coins } from "../config.js";

// EMA(200) needs 200 data points; +1 more so we can compare prev vs curr EMA(200)
const MIN_CANDLES = 201;

export class TrendFollowStrategy implements Strategy {
  name = "trend-follow";

  private readonly coin: string;
  private lastEma21:  number | null = null;
  private lastEma55:  number | null = null;
  private lastEma200: number | null = null;
  private signalCount = 0;

  constructor() {
    this.coin = coins[0];
  }

  getState(): Record<string, unknown> {
    return {
      signalCount: this.signalCount,
      ema21:       this.lastEma21,
      ema55:       this.lastEma55,
      ema200:      this.lastEma200,
    };
  }

  onCandle(candle: Candle, history: Candle[]): Signal | null {
    if (history.length < MIN_CANDLES) return null;

    const coin   = candle.coin ?? this.coin;
    const closes = history.map((c) => c.close);

    const ema21  = EMA.calculate({ values: closes, period: 21 });
    const ema55  = EMA.calculate({ values: closes, period: 55 });
    const ema200 = EMA.calculate({ values: closes, period: 200 });

    // Need at least 2 values of each for crossover comparison
    if (ema21.length < 2 || ema55.length < 2 || ema200.length < 2) return null;

    const e21c = ema21[ema21.length - 1],   e21p = ema21[ema21.length - 2];
    const e55c = ema55[ema55.length - 1],   e55p = ema55[ema55.length - 2];
    const e200 = ema200[ema200.length - 1];

    this.lastEma21  = e21c;
    this.lastEma55  = e55c;
    this.lastEma200 = e200;

    const goldenCross = e21p <= e55p && e21c > e55c;
    const deathCross  = e21p >= e55p && e21c < e55c;
    const aboveEma200 = candle.close > e200;

    if (goldenCross) {
      this.signalCount++;
      if (aboveEma200) {
        return {
          side:      "long",
          coin,
          reason:    `EMA21 crossed above EMA55 (${e21c.toFixed(2)} > ${e55c.toFixed(2)}), price above EMA200 (${e200.toFixed(2)})`,
          timestamp: Date.now(),
        };
      }
      // Golden cross below EMA200 — only exit any short, don't enter long
      return {
        side:      "close",
        coin,
        reason:    `EMA21 crossed above EMA55 but price below EMA200 — exit short`,
        timestamp: Date.now(),
      };
    }

    if (deathCross) {
      this.signalCount++;
      if (!aboveEma200) {
        return {
          side:      "short",
          coin,
          reason:    `EMA21 crossed below EMA55 (${e21c.toFixed(2)} < ${e55c.toFixed(2)}), price below EMA200 (${e200.toFixed(2)})`,
          timestamp: Date.now(),
        };
      }
      // Death cross above EMA200 — only exit any long, don't enter short
      return {
        side:      "close",
        coin,
        reason:    `EMA21 crossed below EMA55 but price above EMA200 — exit long`,
        timestamp: Date.now(),
      };
    }

    return null;
  }
}
