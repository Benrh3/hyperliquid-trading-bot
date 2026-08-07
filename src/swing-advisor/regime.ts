import type { Candle, RegimeResult, HorizonConfig } from "./types.js";

/**
 * Classifies the current market regime from candle data alone.
 *
 * CALM-TRENDING — low realized vol, strong EMA trend.
 * HIGH-VOL      — high realized vol (relative to recent window).
 * CHOP          — moderate vol but no clear trend.
 *
 * All thresholds are relative to the candle window, not absolute,
 * so the classifier self-calibrates as market conditions change.
 */
export function classifyRegime(candles: Candle[], cfg: HorizonConfig): RegimeResult {
  if (candles.length < cfg.emaSlow + 2) {
    return {
      regime: "CHOP",
      realizedVol: 0,
      trendStrength: 0,
      inputs: { candle_count: candles.length, needed: cfg.emaSlow + 2 },
    };
  }

  // ── Realized vol: annualized close-to-close log-return stdev ─────────────
  const closes = candles.map((c) => c.c);
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / logReturns.length;
  const stdPerBar = Math.sqrt(variance);

  const BARS_PER_YEAR: Record<string, number> = { "1h": 8760, "4h": 2190, "1d": 365 };
  const barsPerYear   = BARS_PER_YEAR[cfg.candleInterval] ?? 8760;
  const realizedVol   = stdPerBar * Math.sqrt(barsPerYear);

  // ── Vol percentile: rank current realized vol vs rolling window ───────────
  // We use a shorter rolling window (last third of candles) vs full window
  const windowSize   = Math.floor(candles.length / 3);
  const rollingVols: number[] = [];
  for (let start = 0; start + windowSize <= candles.length; start++) {
    const slice   = candles.slice(start, start + windowSize);
    const sliceR  = slice.slice(1).map((c, i) =>
      slice[i].c > 0 ? Math.log(c.c / slice[i].c) : 0);
    const sliceMu = sliceR.reduce((a, b) => a + b, 0) / sliceR.length;
    const sliceVar = sliceR.reduce((a, b) => a + (b - sliceMu) ** 2, 0) / sliceR.length;
    rollingVols.push(Math.sqrt(sliceVar) * Math.sqrt(barsPerYear));
  }
  const sortedVols = [...rollingVols].sort((a, b) => a - b);
  const volRank    = sortedVols.filter((v) => v <= realizedVol).length / sortedVols.length;

  // ── Trend strength: |EMA_fast − EMA_slow| / ATR_14 ───────────────────────
  const k_fast = 2 / (cfg.emaFast + 1);
  const k_slow = 2 / (cfg.emaSlow + 1);
  let emaFast = closes[0], emaSlow = closes[0];
  for (let i = 1; i < closes.length; i++) {
    emaFast = closes[i] * k_fast + emaFast * (1 - k_fast);
    emaSlow = closes[i] * k_slow + emaSlow * (1 - k_slow);
  }

  const ATR_PERIOD = 14;
  const trueRanges = candles.slice(-ATR_PERIOD - 1).map((c, i, arr) => {
    if (i === 0) return c.h - c.l;
    const prev = arr[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  });
  const atr = trueRanges.slice(1).reduce((a, b) => a + b, 0) / ATR_PERIOD;
  const trendStrength = atr > 0 ? Math.abs(emaFast - emaSlow) / atr : 0;

  const inputs = {
    realized_vol:    realizedVol,
    vol_rank:        volRank,
    trend_strength:  trendStrength,
    ema_fast:        emaFast,
    ema_slow:        emaSlow,
    atr:             atr,
    candle_count:    candles.length,
  };

  // ── Regime classification ─────────────────────────────────────────────────
  // HIGH-VOL: top 30% of realized vol history
  if (volRank >= 0.70) {
    return { regime: "HIGH-VOL", realizedVol, trendStrength, inputs };
  }

  // CALM-TRENDING: low vol + meaningful trend divergence between EMAs
  // trendStrength > 1 means EMA spread > 1 ATR, a moderately reliable filter
  if (volRank <= 0.50 && trendStrength > 1.0) {
    return { regime: "CALM-TRENDING", realizedVol, trendStrength, inputs };
  }

  // Default: CHOP
  return { regime: "CHOP", realizedVol, trendStrength, inputs };
}
