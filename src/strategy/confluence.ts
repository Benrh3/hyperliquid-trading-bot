import { computeRSI, computeMACD, computeBB, lastValue } from "./indicators.js";
import type { Strategy } from "./base.js";
import type { Candle, Signal } from "../events.js";
import { config, coins } from "../config.js";

type Vote = "long" | "short" | "neutral";
interface IndicatorVote { label: string; vote: Vote }

const MIN_CANDLES   = 36;
const RSI_CLOSE_LOW = 40;
const RSI_CLOSE_HIGH = 60;

export class ConfluenceStrategy implements Strategy {
  name = "confluence";
  private readonly coin: string;
  private readonly minConfluence: number;

  private lastRsi:           number | null  = null;
  private lastMacdAboveSignal: boolean | null = null;
  private lastBbPctB:        number | null  = null;
  private lastVolumeRatio:   number | null  = null;
  private lastVotes:         Vote[]         = [];
  private signalCount = 0;
  private inTrade: "long" | "short" | null = null;

  // Grid-search configurable fields (match registry param keys)
  rsiPeriod    = 14;
  overbought   = 70;
  oversold     = 30;
  minConfluenceParam = 3;

  constructor() {
    this.coin = coins[0];
    this.minConfluence = config.strategy.minConfluence ?? 3;
  }

  getState(): Record<string, unknown> {
    return {
      signalCount:     this.signalCount,
      lastRsi:         this.lastRsi,
      macdAboveSignal: this.lastMacdAboveSignal,
      bbPctB:          this.lastBbPctB,
      volumeRatio:     this.lastVolumeRatio,
      votes:           this.lastVotes,
      inTrade:         this.inTrade,
      minConfluence:   this.minConfluence,
    };
  }

  onCandle(candle: Candle, history: Candle[]): Signal | null {
    if (history.length < MIN_CANDLES) return null;
    const coin = candle.coin ?? this.coin;

    const rsiVote  = this.voteRsi(history);
    const macdVote = this.voteMacd(history);
    const bbVote   = this.voteBollinger(history);
    const volVote  = this.voteVolume(history);
    const votes: IndicatorVote[] = [rsiVote, macdVote, bbVote, volVote];
    this.lastVotes = votes.map(v => v.vote);

    const minC = (this.minConfluenceParam ?? this.minConfluence);

    // Exit when RSI returns to neutral
    if (this.inTrade !== null && this.lastRsi !== null) {
      const rsiNeutral = this.lastRsi >= RSI_CLOSE_LOW && this.lastRsi <= RSI_CLOSE_HIGH;
      if (rsiNeutral) {
        const side = this.inTrade; this.inTrade = null; this.signalCount++;
        return { side: "close", coin, reason: `RSI ${this.lastRsi.toFixed(1)} neutral — closing ${side}`, timestamp: Date.now() };
      }
    }

    const longs  = votes.filter(v => v.vote === "long");
    const shorts = votes.filter(v => v.vote === "short");
    if (longs.length >= minC)  { this.inTrade = "long";  this.signalCount++; return { side: "long",  coin, reason: longs.map(v => v.label).join(" + "),  timestamp: Date.now() }; }
    if (shorts.length >= minC) { this.inTrade = "short"; this.signalCount++; return { side: "short", coin, reason: shorts.map(v => v.label).join(" + "), timestamp: Date.now() }; }
    return null;
  }

  private voteRsi(history: Candle[]): IndicatorVote {
    const period = this.rsiPeriod || 14;
    const ob     = this.overbought || 70;
    const os     = this.oversold   || 30;
    const rsi    = lastValue(computeRSI(history, { period }).values);
    this.lastRsi = isNaN(rsi) ? null : rsi;
    if (!isNaN(rsi) && rsi <= os) return { label: `RSI ${rsi.toFixed(1)}`, vote: "long" };
    if (!isNaN(rsi) && rsi >= ob) return { label: `RSI ${rsi.toFixed(1)}`, vote: "short" };
    return { label: "RSI", vote: "neutral" };
  }

  private voteMacd(history: Candle[]): IndicatorVote {
    const { values: macd, extra } = computeMACD(history, { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const sig  = extra?.signal ?? [];
    const n    = macd.length;
    if (n < 2 || isNaN(macd[n - 1]) || isNaN(sig[n - 1])) return { label: "MACD", vote: "neutral" };
    this.lastMacdAboveSignal = macd[n - 1] > sig[n - 1];
    if (macd[n - 2] <= sig[n - 2] && macd[n - 1] > sig[n - 1]) return { label: "MACD cross↑", vote: "long" };
    if (macd[n - 2] >= sig[n - 2] && macd[n - 1] < sig[n - 1]) return { label: "MACD cross↓", vote: "short" };
    return { label: "MACD", vote: "neutral" };
  }

  private voteBollinger(history: Candle[]): IndicatorVote {
    const { values: mid, extra } = computeBB(history, { period: 20, stdDev: 2 });
    const upper = extra?.upper ?? [];
    const lower = extra?.lower ?? [];
    const n     = mid.length;
    const close = history[n - 1].close;
    const u = upper[n - 1], l = lower[n - 1];
    if (isNaN(u) || isNaN(l)) return { label: "BB", vote: "neutral" };
    const bw = u - l;
    this.lastBbPctB = bw > 0 ? (close - l) / bw : 0.5;
    void mid;
    if (close <= l) return { label: `BB lower ${l.toFixed(1)}`, vote: "long" };
    if (close >= u) return { label: `BB upper ${u.toFixed(1)}`, vote: "short" };
    return { label: "BB", vote: "neutral" };
  }

  private voteVolume(history: Candle[]): IndicatorVote {
    const period = 20;
    if (history.length < period + 1) return { label: "Vol", vote: "neutral" };
    const vols = history.map(c => c.volume);
    const prior = vols.slice(-(period + 1), -1);
    const avg   = prior.reduce((a, b) => a + b, 0) / period;
    const candle = history[history.length - 1];
    const ratio  = candle.volume / avg;
    this.lastVolumeRatio = ratio;
    if (ratio < 1.5) return { label: "Vol", vote: "neutral" };
    if (candle.close > candle.open) return { label: `Vol spike ${ratio.toFixed(1)}×↑`, vote: "long" };
    if (candle.close < candle.open) return { label: `Vol spike ${ratio.toFixed(1)}×↓`, vote: "short" };
    return { label: "Vol", vote: "neutral" };
  }
}
