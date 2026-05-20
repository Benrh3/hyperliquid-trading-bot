import { RSI } from "technicalindicators";
import type { Strategy } from "./base.js";
import type { Candle, Signal } from "../events.js";
import { config, coins } from "../config.js";

export class RsiStrategy implements Strategy {
  name = "rsi";

  private period: number;
  private overbought: number;
  private oversold: number;
  private coin: string;

  constructor() {
    const s = config.strategy;
    this.period = (s.rsiPeriod as number) ?? 14;
    this.overbought = (s.overbought as number) ?? 70;
    this.oversold = (s.oversold as number) ?? 30;
    this.coin = coins[0];
  }

  onCandle(candle: Candle, history: Candle[]): Signal | null {
    if (history.length < this.period + 1) return null;

    const coin      = candle.coin ?? this.coin;
    const closes    = history.map((c) => c.close);
    const rsiValues = RSI.calculate({ values: closes, period: this.period });

    if (rsiValues.length === 0) return null;

    const currentRsi = rsiValues[rsiValues.length - 1];

    if (currentRsi <= this.oversold) {
      return {
        side:      "long",
        coin,
        reason:    `RSI ${currentRsi.toFixed(1)} below oversold (${this.oversold})`,
        timestamp: Date.now(),
      };
    }

    if (currentRsi >= this.overbought) {
      return {
        side:      "short",
        coin,
        reason:    `RSI ${currentRsi.toFixed(1)} above overbought (${this.overbought})`,
        timestamp: Date.now(),
      };
    }

    return null;
  }
}
