import type { Strategy } from "./base.js";
import { ConfluenceStrategy } from "./confluence.js";
import { TrendFollowStrategy } from "./trend-follow.js";

export interface StrategyParam {
  key:     string;
  label:   string;
  default: number;
  min:     number;
  max:     number;
  step:    number;
}

export type StrategyCategory = "mean-reversion" | "trend-following" | "market-neutral";

export interface StrategyRegistryEntry {
  id:               string;
  displayName:      string;
  category:         StrategyCategory;
  categoryLabel:    string;
  summary:          string;
  howItWorks:       string;
  signals:          string[];
  whenItWorks:      string;
  whenItStruggles:  string;
  params:           StrategyParam[];
  /**
   * true  → driven by OHLCV candles; factory produces a live Strategy instance.
   * false → driven by an alternative data source (e.g. funding history); factory is null.
   */
  isCandleStrategy: boolean;
  factory:          (() => Strategy) | null;
}

export const STRATEGY_REGISTRY: StrategyRegistryEntry[] = [
  {
    id:            "confluence",
    displayName:   "Confluence",
    category:      "mean-reversion",
    categoryLabel: "Mean-reversion (multi-indicator)",
    summary:
      "Combines four indicators and acts only when at least two agree.",
    howItWorks:
      "It reads RSI, MACD, Bollinger Bands, and Volume on each candle. RSI below 30 signals " +
      "oversold (a long bias) and above 70 overbought (a short bias); MACD crossing its signal " +
      "line indicates momentum direction; Bollinger %B near the lower band is oversold and near " +
      "the upper band overbought; a volume spike adds confirmation. When at least 2 of the 4 " +
      "agree, it opens a position, and closes when RSI returns toward neutral (around 50) or a " +
      "stop-loss is hit.",
    signals: [
      "RSI(14)",
      "MACD",
      "Bollinger Bands",
      "Volume",
    ],
    whenItWorks:
      "Range-bound, choppy markets where price oscillates around an average.",
    whenItStruggles:
      "Strong sustained trends, where it repeatedly fades the move and gets stopped out.",
    params: [
      { key: "minConfluence", label: "Min votes to enter",   default: 3,  min: 1,  max: 4,  step: 1  },
      { key: "rsiPeriod",    label: "RSI period",            default: 14, min: 5,  max: 30, step: 1  },
      { key: "overbought",   label: "RSI overbought level",  default: 70, min: 60, max: 90, step: 1  },
      { key: "oversold",     label: "RSI oversold level",    default: 30, min: 10, max: 40, step: 1  },
    ],
    isCandleStrategy: true,
    factory: () => new ConfluenceStrategy(),
  },

  {
    id:            "trend-follow",
    displayName:   "Trend Follow",
    category:      "trend-following",
    categoryLabel: "Trend-following",
    summary:
      "Trades moving-average crossovers, but only in the direction of the longer-term trend.",
    howItWorks:
      "When the fast EMA(21) crosses above the slow EMA(55) it's a long signal; crossing below " +
      "is a short signal. A higher-timeframe filter only allows longs when price is above EMA(200) " +
      "and shorts when below, so trades go with the broader trend. It exits on the opposite crossover.",
    signals: [
      "EMA(21) — fast moving average",
      "EMA(55) — slow moving average (crossover trigger)",
      "EMA(200) — higher-timeframe trend filter",
    ],
    whenItWorks:
      "Strong, sustained trends in one direction.",
    whenItStruggles:
      "Sideways or choppy markets, where crossovers flip back and forth (whipsaw) and produce " +
      "repeated small losses.",
    params: [],
    isCandleStrategy: true,
    factory: () => new TrendFollowStrategy(),
  },

  {
    id:            "funding-basis",
    displayName:   "Funding Basis",
    category:      "market-neutral",
    categoryLabel: "Market-neutral (carry)",
    summary:
      "Holds offsetting spot and perpetual positions to earn the funding rate without betting on price direction.",
    howItWorks:
      "It holds a long spot position and an equal short perpetual position, so gains and losses " +
      "from price movement cancel out. Income comes from the perpetual funding rate — when funding " +
      "is positive, short positions are paid by longs each funding period (hourly on Hyperliquid). " +
      "The return is the accumulated funding minus trading fees.",
    signals: [
      "Perpetual funding rate (hourly accrual)",
    ],
    whenItWorks:
      "When funding rates stay positive over the holding period.",
    whenItStruggles:
      "When funding turns negative, meaning the position pays funding instead of collecting it; " +
      "it also carries liquidation risk on the short leg if margin isn't managed.",
    params: [
      { key: "notionalUsd", label: "Notional size (USD)", default: 1000, min: 100, max: 100_000, step: 100 },
    ],
    isCandleStrategy: false,
    factory: null,
  },
];

/** Look up an entry by id. */
export function getStrategyEntry(id: string): StrategyRegistryEntry | undefined {
  return STRATEGY_REGISTRY.find((e) => e.id === id);
}

/** All entries backed by a candle-driven Strategy implementation. */
export const CANDLE_STRATEGIES = STRATEGY_REGISTRY.filter(
  (e): e is StrategyRegistryEntry & { factory: () => Strategy } =>
    e.isCandleStrategy && e.factory !== null,
);
