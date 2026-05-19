import { RSI, MACD, BollingerBands } from "technicalindicators";
import type { Strategy } from "./base.js";
import type { Candle, Signal } from "../events.js";
import { config } from "../config.js";

type Vote = "long" | "short" | "neutral";
interface IndicatorVote { label: string; vote: Vote }

// MACD needs slow(26) + signal(9) candles to produce one result, plus one
// more for crossover comparison — 36 total covers all four indicators.
const MIN_CANDLES = 36;

export class ConfluenceStrategy implements Strategy {
  name = "confluence";
  private readonly coin: string;

  constructor() {
    this.coin = config.exchange.coin;
  }

  onCandle(_candle: Candle, history: Candle[]): Signal | null {
    if (history.length < MIN_CANDLES) return null;

    const closes  = history.map((c) => c.close);
    const volumes = history.map((c) => c.volume);
    const current = history[history.length - 1];

    const votes: IndicatorVote[] = [
      this.voteRsi(closes),
      this.voteMacd(closes),
      this.voteBollinger(closes, current.close),
      this.voteVolume(volumes, current),
    ];

    const longs  = votes.filter((v) => v.vote === "long");
    const shorts = votes.filter((v) => v.vote === "short");

    if (longs.length >= 3) {
      return {
        side: "long",
        coin: this.coin,
        reason: longs.map((v) => v.label).join(" + "),
        timestamp: Date.now(),
      };
    }

    if (shorts.length >= 3) {
      return {
        side: "short",
        coin: this.coin,
        reason: shorts.map((v) => v.label).join(" + "),
        timestamp: Date.now(),
      };
    }

    return null;
  }

  // ── RSI: oversold → long, overbought → short ───────────────────────────
  private voteRsi(closes: number[]): IndicatorVote {
    const results = RSI.calculate({ values: closes, period: 14 });
    if (results.length === 0) return { label: "RSI", vote: "neutral" };

    const rsi = results[results.length - 1];
    if (rsi <= 30) return { label: `RSI ${rsi.toFixed(1)}`, vote: "long" };
    if (rsi >= 70) return { label: `RSI ${rsi.toFixed(1)}`, vote: "short" };
    return { label: "RSI", vote: "neutral" };
  }

  // ── MACD: crossover above signal line → long, below → short ───────────
  private voteMacd(closes: number[]): IndicatorVote {
    const results = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    if (results.length < 2) return { label: "MACD", vote: "neutral" };

    const prev = results[results.length - 2];
    const curr = results[results.length - 1];

    if (
      prev.MACD === undefined || prev.signal === undefined ||
      curr.MACD === undefined || curr.signal === undefined
    ) {
      return { label: "MACD", vote: "neutral" };
    }

    if (prev.MACD <= prev.signal && curr.MACD > curr.signal) {
      return { label: "MACD cross↑", vote: "long" };
    }
    if (prev.MACD >= prev.signal && curr.MACD < curr.signal) {
      return { label: "MACD cross↓", vote: "short" };
    }
    return { label: "MACD", vote: "neutral" };
  }

  // ── Bollinger Bands: price at/below lower → long, upper → short ────────
  private voteBollinger(closes: number[], close: number): IndicatorVote {
    const results = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    if (results.length === 0) return { label: "BB", vote: "neutral" };

    const { lower, upper } = results[results.length - 1];
    if (close <= lower) return { label: `BB lower ${lower.toFixed(1)}`, vote: "long" };
    if (close >= upper) return { label: `BB upper ${upper.toFixed(1)}`, vote: "short" };
    return { label: "BB", vote: "neutral" };
  }

  // ── Volume spike: >1.5× 20-period avg + bullish/bearish candle ─────────
  private voteVolume(volumes: number[], candle: Candle): IndicatorVote {
    const period = 20;
    if (volumes.length < period + 1) return { label: "Vol", vote: "neutral" };

    // Average of the 20 candles preceding the current one
    const prior = volumes.slice(-(period + 1), -1);
    const avg = prior.reduce((a, b) => a + b, 0) / period;
    const ratio = candle.volume / avg;

    if (ratio < 1.5) return { label: "Vol", vote: "neutral" };

    if (candle.close > candle.open) {
      return { label: `Vol spike ${ratio.toFixed(1)}×↑`, vote: "long" };
    }
    if (candle.close < candle.open) {
      return { label: `Vol spike ${ratio.toFixed(1)}×↓`, vote: "short" };
    }
    return { label: "Vol", vote: "neutral" };
  }
}
