import type { Candle } from "../events.js";
import { loadManifest } from "../market/manifest.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type IndicatorCategory = "Momentum" | "Trend" | "Volatility" | "Volume" | "Market Signal";
export type IndicatorOutputType = "single" | "multi" | "band";

export interface IndicatorParam {
  key:     string;
  label:   string;
  default: number;
  min:     number;
  max:     number;
  step:    number;
}

export interface IndicatorMeta {
  id:           string;
  displayName:  string;
  category:     IndicatorCategory;
  outputType:   IndicatorOutputType;
  outputKeys:   string[];          // primary key first; multi has ≥2
  defaultParams: IndicatorParam[];
  description:  string;
  commonUse:    string;
  typicalParams: string;
  exampleRule:  string;
}

export interface IndicatorResult {
  values: number[];                       // primary series, NaN-padded, length = candles.length
  extra?: Record<string, number[]>;       // secondary outputs, same length
}

export type IndicatorFn = (candles: Candle[], params: Record<string, number>) => IndicatorResult;

// ── Internal helpers ──────────────────────────────────────────────────────────

function nan(n: number): number[] { return new Array(n).fill(NaN); }

function closes(candles: Candle[]): number[] { return candles.map(c => c.close); }
function highs(candles: Candle[]): number[]  { return candles.map(c => c.high); }
function lows(candles: Candle[]): number[]   { return candles.map(c => c.low); }

function smaArr(vals: number[], period: number): number[] {
  const out = nan(vals.length);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function emaArr(vals: number[], period: number): number[] {
  const out = nan(vals.length);
  const k   = 2 / (period + 1);
  let sum   = 0;
  for (let i = 0; i < period - 1; i++) sum += vals[i];
  sum += vals[period - 1];
  out[period - 1] = sum / period;
  for (let i = period; i < vals.length; i++) {
    out[i] = vals[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function stddevArr(vals: number[], period: number, mean: number[]): number[] {
  const out = nan(vals.length);
  for (let i = period - 1; i < vals.length; i++) {
    let sumSq = 0;
    const m = mean[i];
    if (isNaN(m)) continue;
    for (let j = i - period + 1; j <= i; j++) sumSq += (vals[j] - m) ** 2;
    out[i] = Math.sqrt(sumSq / period);
  }
  return out;
}

function trueRange(candles: Candle[]): number[] {
  const tr = nan(candles.length);
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  if (candles.length > 0) {
    const { high, low } = candles[0];
    tr[0] = high - low;
  }
  return tr;
}

// Wilder smoothing (RMA): used for ATR, ADX, RSI
function wilderSmooth(vals: number[], period: number): number[] {
  const out = nan(vals.length);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    if (!isNaN(vals[i])) sum += vals[i];
  }
  out[period - 1] = sum / period;
  for (let i = period; i < vals.length; i++) {
    if (!isNaN(vals[i])) {
      out[i] = (out[i - 1] * (period - 1) + vals[i]) / period;
    }
  }
  return out;
}

// ── 1. SMA ────────────────────────────────────────────────────────────────────

export function computeSMA(candles: Candle[], p: Record<string, number>): IndicatorResult {
  return { values: smaArr(closes(candles), p["period"] | 0) };
}

// ── 2. EMA ────────────────────────────────────────────────────────────────────

export function computeEMA(candles: Candle[], p: Record<string, number>): IndicatorResult {
  return { values: emaArr(closes(candles), p["period"] | 0) };
}

// ── 3. WMA ────────────────────────────────────────────────────────────────────

export function computeWMA(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const cls    = closes(candles);
  const period = p["period"] | 0;
  const out    = nan(cls.length);
  const denom  = (period * (period + 1)) / 2;
  for (let i = period - 1; i < cls.length; i++) {
    let w = 0;
    for (let j = 0; j < period; j++) w += cls[i - j] * (period - j);
    out[i] = w / denom;
  }
  return { values: out };
}

// ── 4. RSI ────────────────────────────────────────────────────────────────────

export function computeRSI(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const cls    = closes(candles);
  const period = p["period"] | 0;
  const out    = nan(cls.length);
  if (cls.length < period + 1) return { values: out };

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = cls[i] - cls[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < cls.length; i++) {
    const d    = cls[i] - cls[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return { values: out };
}

// ── 5. MACD ───────────────────────────────────────────────────────────────────

export function computeMACD(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const cls    = closes(candles);
  const fast   = p["fastPeriod"]   | 0 || 12;
  const slow   = p["slowPeriod"]   | 0 || 26;
  const signal = p["signalPeriod"] | 0 || 9;

  const fastEma = emaArr(cls, fast);
  const slowEma = emaArr(cls, slow);
  const macd    = cls.map((_, i) =>
    isNaN(fastEma[i]) || isNaN(slowEma[i]) ? NaN : fastEma[i] - slowEma[i],
  );
  const signalLine = emaArr(macd.map(v => isNaN(v) ? 0 : v), signal);
  // Re-NaN the signal line where MACD was NaN
  for (let i = 0; i < macd.length; i++) {
    if (isNaN(macd[i])) signalLine[i] = NaN;
  }
  const histogram = macd.map((m, i) =>
    isNaN(m) || isNaN(signalLine[i]) ? NaN : m - signalLine[i],
  );

  return {
    values: macd,
    extra:  { signal: signalLine, histogram },
  };
}

// ── 6. Bollinger Bands ────────────────────────────────────────────────────────

export function computeBB(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const cls    = closes(candles);
  const period = p["period"] | 0 || 20;
  const mult   = p["stdDev"] ?? 2;

  const mid = smaArr(cls, period);
  const std = stddevArr(cls, period, mid);
  const upper = mid.map((m, i) => isNaN(m) ? NaN : m + mult * std[i]);
  const lower = mid.map((m, i) => isNaN(m) ? NaN : m - mult * std[i]);

  return { values: mid, extra: { upper, lower } };
}

// ── 7. Stochastic ─────────────────────────────────────────────────────────────

export function computeStochastic(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const kPeriod = p["kPeriod"] | 0 || 14;
  const dPeriod = p["dPeriod"] | 0 || 3;
  const hi      = highs(candles);
  const lo      = lows(candles);
  const cls     = closes(candles);
  const k       = nan(candles.length);

  for (let i = kPeriod - 1; i < candles.length; i++) {
    const highN = Math.max(...hi.slice(i - kPeriod + 1, i + 1));
    const lowN  = Math.min(...lo.slice(i - kPeriod + 1, i + 1));
    k[i] = highN === lowN ? 0 : (cls[i] - lowN) / (highN - lowN) * 100;
  }

  const d = smaArr(k.map(v => isNaN(v) ? 0 : v), dPeriod);
  for (let i = 0; i < kPeriod - 1; i++) d[i] = NaN;

  return { values: k, extra: { d } };
}

// ── 8. ATR ────────────────────────────────────────────────────────────────────

export function computeATR(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 14;
  const tr     = trueRange(candles);
  const atr    = wilderSmooth(tr, period);
  return { values: atr };
}

// ── 9. ADX ────────────────────────────────────────────────────────────────────

export function computeADX(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 14;
  const hi     = highs(candles);
  const lo     = lows(candles);
  const tr     = trueRange(candles);

  const plusDM  = nan(candles.length);
  const minusDM = nan(candles.length);
  for (let i = 1; i < candles.length; i++) {
    const upMove   = hi[i] - hi[i - 1];
    const downMove = lo[i - 1] - lo[i];
    plusDM[i]  = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const atr14     = wilderSmooth(tr, period);
  const plusDM14  = wilderSmooth(plusDM, period);
  const minusDM14 = wilderSmooth(minusDM, period);

  const plusDI  = atr14.map((a, i) => isNaN(a) || a === 0 ? NaN : (plusDM14[i] / a) * 100);
  const minusDI = atr14.map((a, i) => isNaN(a) || a === 0 ? NaN : (minusDM14[i] / a) * 100);

  const dx = plusDI.map((p2, i) => {
    if (isNaN(p2) || isNaN(minusDI[i])) return NaN;
    const sum = p2 + minusDI[i];
    return sum === 0 ? 0 : Math.abs(p2 - minusDI[i]) / sum * 100;
  });

  const adx = wilderSmooth(dx.map(v => isNaN(v) ? 0 : v), period);
  // NaN-clean the ADX where DX was NaN
  const firstValidDX = dx.findIndex(v => !isNaN(v));
  for (let i = 0; i < firstValidDX + period - 1; i++) adx[i] = NaN;

  return { values: adx, extra: { plusDI, minusDI } };
}

// ── 10. CCI ───────────────────────────────────────────────────────────────────

export function computeCCI(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 20;
  const tp     = candles.map(c => (c.high + c.low + c.close) / 3);
  const tpSma  = smaArr(tp, period);
  const out    = nan(candles.length);

  for (let i = period - 1; i < candles.length; i++) {
    const slice   = tp.slice(i - period + 1, i + 1);
    const m       = tpSma[i];
    const meanDev = slice.reduce((s, v) => s + Math.abs(v - m), 0) / period;
    out[i] = meanDev === 0 ? 0 : (tp[i] - m) / (0.015 * meanDev);
  }
  return { values: out };
}

// ── 11. Williams %R ───────────────────────────────────────────────────────────

export function computeWilliamsR(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 14;
  const hi     = highs(candles);
  const lo     = lows(candles);
  const cls    = closes(candles);
  const out    = nan(candles.length);

  for (let i = period - 1; i < candles.length; i++) {
    const highN = Math.max(...hi.slice(i - period + 1, i + 1));
    const lowN  = Math.min(...lo.slice(i - period + 1, i + 1));
    out[i] = highN === lowN ? -50 : (highN - cls[i]) / (highN - lowN) * -100;
  }
  return { values: out };
}

// ── 12. ROC ───────────────────────────────────────────────────────────────────

export function computeROC(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 10;
  const cls    = closes(candles);
  const out    = nan(cls.length);
  for (let i = period; i < cls.length; i++) {
    out[i] = cls[i - period] === 0 ? 0 : (cls[i] - cls[i - period]) / cls[i - period] * 100;
  }
  return { values: out };
}

// ── 13. Parabolic SAR ─────────────────────────────────────────────────────────

export function computeParabolicSAR(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const initialAF = p["initialAF"] ?? 0.02;
  const maxAF     = p["maxAF"]     ?? 0.2;
  const stepAF    = p["stepAF"]    ?? 0.02;

  const hi  = highs(candles);
  const lo  = lows(candles);
  const out = nan(candles.length);
  if (candles.length < 2) return { values: out };

  let bull = hi[0] < hi[1]; // initial direction
  let sar  = bull ? lo[0] : hi[0];
  let ep   = bull ? hi[0] : lo[0];
  let af   = initialAF;

  for (let i = 1; i < candles.length; i++) {
    const prevSar = sar;
    sar = prevSar + af * (ep - prevSar);

    if (bull) {
      sar = Math.min(sar, lo[i - 1], i > 1 ? lo[i - 2] : lo[i - 1]);
      if (lo[i] < sar) {
        bull = false; sar = ep; ep = lo[i]; af = initialAF;
      } else {
        if (hi[i] > ep) { ep = hi[i]; af = Math.min(af + stepAF, maxAF); }
      }
    } else {
      sar = Math.max(sar, hi[i - 1], i > 1 ? hi[i - 2] : hi[i - 1]);
      if (hi[i] > sar) {
        bull = true; sar = ep; ep = hi[i]; af = initialAF;
      } else {
        if (lo[i] < ep) { ep = lo[i]; af = Math.min(af + stepAF, maxAF); }
      }
    }
    out[i] = sar;
  }
  return { values: out };
}

// ── 14. OBV ───────────────────────────────────────────────────────────────────

export function computeOBV(candles: Candle[], _p: Record<string, number>): IndicatorResult {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const dir = candles[i].close > candles[i - 1].close ? 1 :
                candles[i].close < candles[i - 1].close ? -1 : 0;
    out[i] = out[i - 1] + dir * candles[i].volume;
  }
  return { values: out };
}

// ── 15. VWAP (rolling, same-session) ─────────────────────────────────────────

export function computeVWAP(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 20;
  const out    = nan(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    let tvSum = 0, vSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      tvSum += tp * candles[j].volume;
      vSum  += candles[j].volume;
    }
    out[i] = vSum === 0 ? NaN : tvSum / vSum;
  }
  return { values: out };
}

// ── 16. MFI ───────────────────────────────────────────────────────────────────

export function computeMFI(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 14;
  const out    = nan(candles.length);

  for (let i = period; i < candles.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp     = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const prevTp = (candles[j - 1].high + candles[j - 1].low + candles[j - 1].close) / 3;
      const mf     = tp * candles[j].volume;
      if (tp > prevTp) posFlow += mf;
      else if (tp < prevTp) negFlow += mf;
    }
    out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return { values: out };
}

// ── 17. Keltner Channels ──────────────────────────────────────────────────────

export function computeKeltner(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 20;
  const mult   = p["multiplier"] ?? 2;
  const atrP   = p["atrPeriod"]  | 0 || 10;

  const cls = closes(candles);
  const mid = emaArr(cls, period);
  const atr = computeATR(candles, { period: atrP }).values;

  const upper = mid.map((m, i) => isNaN(m) || isNaN(atr[i]) ? NaN : m + mult * atr[i]);
  const lower = mid.map((m, i) => isNaN(m) || isNaN(atr[i]) ? NaN : m - mult * atr[i]);

  return { values: mid, extra: { upper, lower } };
}

// ── 18. Donchian Channels ─────────────────────────────────────────────────────

export function computeDonchian(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 20;
  const hi     = highs(candles);
  const lo     = lows(candles);
  const upper  = nan(candles.length);
  const lower  = nan(candles.length);

  for (let i = period - 1; i < candles.length; i++) {
    upper[i] = Math.max(...hi.slice(i - period + 1, i + 1));
    lower[i] = Math.min(...lo.slice(i - period + 1, i + 1));
  }

  const mid = upper.map((u, i) => isNaN(u) ? NaN : (u + lower[i]) / 2);
  return { values: mid, extra: { upper, lower } };
}

// ── 19. Volume MA ─────────────────────────────────────────────────────────────

export function computeVolumeMA(candles: Candle[], p: Record<string, number>): IndicatorResult {
  const period = p["period"] | 0 || 20;
  const vols   = candles.map(c => c.volume);
  return { values: smaArr(vols, period) };
}

// ── 20. Heikin Ashi ───────────────────────────────────────────────────────────

export function computeHeikinAshi(candles: Candle[], _p: Record<string, number>): IndicatorResult {
  const haClose = candles.map(c => (c.open + c.high + c.low + c.close) / 4);
  const haOpen  = nan(candles.length);
  const haHigh  = nan(candles.length);
  const haLow   = nan(candles.length);

  haOpen[0] = (candles[0].open + candles[0].close) / 2;
  haHigh[0] = Math.max(candles[0].high, haOpen[0], haClose[0]);
  haLow[0]  = Math.min(candles[0].low,  haOpen[0], haClose[0]);

  for (let i = 1; i < candles.length; i++) {
    haOpen[i] = (haOpen[i - 1] + haClose[i - 1]) / 2;
    haHigh[i] = Math.max(candles[i].high, haOpen[i], haClose[i]);
    haLow[i]  = Math.min(candles[i].low,  haOpen[i], haClose[i]);
  }

  return { values: haClose, extra: { open: haOpen, high: haHigh, low: haLow } };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const INDICATOR_REGISTRY: (IndicatorMeta & { fn: IndicatorFn })[] = [
  {
    id: "SMA", displayName: "Simple Moving Average", category: "Trend",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 20, min: 2, max: 200, step: 5 }],
    description: "The SMA is the arithmetic mean of price over N periods. It smooths out short-term fluctuations to reveal the underlying trend direction. Longer periods produce smoother lines that lag more; shorter periods react faster but are noisier.",
    commonUse: "Identifying trend direction, dynamic support/resistance levels, and as a component in other indicators.",
    typicalParams: "Period 10–200. Short (10–50) for swing trading; long (100–200) for trend identification.",
    exampleRule: "Close > SMA(50) — price is above the 50-period average, suggesting an uptrend.",
    fn: computeSMA,
  },
  {
    id: "EMA", displayName: "Exponential Moving Average", category: "Trend",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 20, min: 2, max: 200, step: 5 }],
    description: "The EMA applies a weighting multiplier (2/N+1) that gives more importance to recent prices compared to older ones. This makes it more responsive to new information than the SMA, at the cost of being slightly more reactive to false signals.",
    commonUse: "Trend following, crossover systems (EMA21 × EMA55 golden/death cross), and as a dynamic support line in trending markets.",
    typicalParams: "Period 9, 12, 21, 26, 50, 200. Pairs like (12,26) drive MACD; (21,55,200) are classic trend-follow periods.",
    exampleRule: "EMA(21) crosses above EMA(55) — fast average crosses slow, signalling upward momentum.",
    fn: computeEMA,
  },
  {
    id: "WMA", displayName: "Weighted Moving Average", category: "Trend",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 14, min: 2, max: 100, step: 5 }],
    description: "The WMA assigns linearly increasing weights to recent prices (the most recent bar gets weight N, the previous N-1, and so on). It is more responsive than SMA and emphasises recency more aggressively than EMA, making it useful when recent price action should dominate.",
    commonUse: "Trend direction in fast-moving markets; alternative to EMA when even stronger recency bias is desired.",
    typicalParams: "Period 10–50. Used similarly to EMA, often chosen by traders who want quicker signal generation.",
    exampleRule: "Close > WMA(14) — price is above the weighted average, confirming near-term bullish bias.",
    fn: computeWMA,
  },
  {
    id: "RSI", displayName: "Relative Strength Index", category: "Momentum",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [
      { key: "period",     label: "Period",           default: 14, min: 2,  max: 50, step: 2 },
      { key: "overbought", label: "Overbought level", default: 70, min: 60, max: 90, step: 5 },
      { key: "oversold",   label: "Oversold level",   default: 30, min: 10, max: 40, step: 5 },
    ],
    description: "RSI measures the speed and change of price movements, oscillating between 0 and 100. Values above 70 traditionally signal overbought conditions (potential reversal down); below 30 signals oversold (potential reversal up). Wilder's smoothing makes it react gradually, reducing false signals.",
    commonUse: "Detecting overbought/oversold extremes, divergence with price, and momentum confirmation.",
    typicalParams: "Period 14 (standard). Overbought 70, oversold 30 for liquid markets; widen to 80/20 in strong trends.",
    exampleRule: "RSI(14) < 30 — momentum is in oversold territory, suggesting a potential long entry.",
    fn: computeRSI,
  },
  {
    id: "MACD", displayName: "MACD", category: "Momentum",
    outputType: "multi", outputKeys: ["values", "signal", "histogram"],
    defaultParams: [
      { key: "fastPeriod",   label: "Fast EMA",   default: 12, min: 2,  max: 50,  step: 2 },
      { key: "slowPeriod",   label: "Slow EMA",   default: 26, min: 10, max: 100, step: 2 },
      { key: "signalPeriod", label: "Signal EMA", default: 9,  min: 2,  max: 20,  step: 1 },
    ],
    description: "MACD is the difference between two EMAs (fast minus slow). When the MACD line crosses above its signal line (a 9-period EMA of MACD), it generates a bullish signal; crossing below is bearish. The histogram visualises the gap between MACD and signal — expanding bars indicate accelerating momentum.",
    commonUse: "Momentum crossover signals, divergence analysis, and confirming trend direction.",
    typicalParams: "Standard (12,26,9). Faster settings (8,17,9) for shorter timeframes; slower for weekly/monthly.",
    exampleRule: "MACD line crosses above signal line — bullish momentum crossover, classic long entry signal.",
    fn: computeMACD,
  },
  {
    id: "BB", displayName: "Bollinger Bands", category: "Volatility",
    outputType: "band", outputKeys: ["values", "upper", "lower"],
    defaultParams: [
      { key: "period", label: "Period",          default: 20, min: 5,   max: 50,  step: 5 },
      { key: "stdDev", label: "Std Dev multiplier", default: 2, min: 0.5, max: 4,  step: 0.5 },
    ],
    description: "Bollinger Bands place upper and lower envelopes at ±N standard deviations around a simple moving average. When price touches or breaks the upper band, the market is statistically stretched to the upside; lower band to the downside. Band width (squeeze) indicates low volatility, often preceding large moves.",
    commonUse: "Mean reversion entries at band extremes, squeeze breakouts, and dynamic support/resistance.",
    typicalParams: "Period 20, StdDev 2 (standard). Wider bands (2.5) reduce false signals in volatile markets.",
    exampleRule: "Close < BB lower band — price below statistical floor, suggesting oversold mean-reversion long.",
    fn: computeBB,
  },
  {
    id: "STOCH", displayName: "Stochastic Oscillator", category: "Momentum",
    outputType: "multi", outputKeys: ["values", "d"],
    defaultParams: [
      { key: "kPeriod", label: "%K period", default: 14, min: 5,  max: 30, step: 1 },
      { key: "dPeriod", label: "%D period", default: 3,  min: 1,  max: 10, step: 1 },
    ],
    description: "The Stochastic Oscillator compares closing price to the high-low range over N periods, expressing it as a percentage (0–100). %K is the raw oscillator; %D is a smoothed signal line. Values above 80 are overbought; below 20 are oversold. A %K cross above %D from oversold is a classic buy signal.",
    commonUse: "Identifying momentum reversals, %K/%D crossovers in overbought/oversold zones.",
    typicalParams: "%K 14, %D 3. Use %K 5 for scalping, %K 21 for position trading.",
    exampleRule: "Stochastic %K < 20 and %K crosses above %D — oversold bullish crossover signal.",
    fn: computeStochastic,
  },
  {
    id: "ATR", displayName: "Average True Range", category: "Volatility",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 14, min: 2, max: 50, step: 2 }],
    description: "ATR measures market volatility by averaging the True Range (the greatest of: high-low, |high-prevClose|, |low-prevClose|) over N periods using Wilder smoothing. It does not indicate direction, only the degree of price movement — higher ATR means more volatility.",
    commonUse: "Setting stop-loss distances (e.g., 2×ATR), position sizing, and filtering low-volatility environments.",
    typicalParams: "Period 14 (standard). Use in conjunction with a multiplier: ATR × 1.5 for tight stops, × 3 for wider.",
    exampleRule: "ATR(14) > 50 — sufficient volatility present, safe to enter; filter out flat markets.",
    fn: computeATR,
  },
  {
    id: "ADX", displayName: "Average Directional Index", category: "Trend",
    outputType: "multi", outputKeys: ["values", "plusDI", "minusDI"],
    defaultParams: [{ key: "period", label: "Period", default: 14, min: 5, max: 50, step: 2 }],
    description: "ADX measures the strength of a trend (0–100) without indicating direction. Values above 25 suggest a strong trend; below 20 suggests ranging conditions. The accompanying +DI and -DI lines show directional pressure: when +DI > -DI, bulls dominate; when -DI > +DI, bears dominate.",
    commonUse: "Filtering trend strength before entering directional trades; +DI/-DI crossovers as signals.",
    typicalParams: "Period 14. ADX > 25 to confirm trend; +DI/-DI crossover for direction.",
    exampleRule: "ADX(14) > 25 and +DI > -DI — strong uptrend confirmed, favour long trades only.",
    fn: computeADX,
  },
  {
    id: "CCI", displayName: "Commodity Channel Index", category: "Momentum",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 20, min: 5, max: 50, step: 5 }],
    description: "CCI compares the current typical price (average of high, low, close) to its N-period simple moving average, normalised by mean absolute deviation. Values above +100 indicate the instrument is above its statistical norm (strong upward momentum); below -100 indicates weak downward momentum.",
    commonUse: "Overbought/oversold signals, trend strength, and divergence with price.",
    typicalParams: "Period 20 (standard). Thresholds ±100 for signals; ±200 for extreme reversals.",
    exampleRule: "CCI(20) crosses below -100 — price moved significantly below average, potential long reversal.",
    fn: computeCCI,
  },
  {
    id: "WILLIAMSR", displayName: "Williams %R", category: "Momentum",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 14, min: 5, max: 50, step: 2 }],
    description: "Williams %R measures where the closing price sits relative to the high-low range over N periods, expressed as a negative percentage. Values near 0 (i.e., -20 or above) indicate the close is near the period's high (overbought); near -100 (i.e., below -80) indicates a close near the period's low (oversold).",
    commonUse: "Identifying momentum reversals, confirmation of overbought/oversold conditions alongside RSI.",
    typicalParams: "Period 14. Overbought above -20; oversold below -80.",
    exampleRule: "Williams %R(14) < -80 — price is near the period's low, oversold signal.",
    fn: computeWilliamsR,
  },
  {
    id: "ROC", displayName: "Rate of Change", category: "Momentum",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 10, min: 1, max: 100, step: 5 }],
    description: "ROC measures the percentage change in price over N periods: (current - Nago) / Nago × 100. Positive ROC means price is higher than N periods ago (upward momentum); negative means lower. Zero crossings signal momentum direction changes.",
    commonUse: "Momentum confirmation, zero-line crossovers, and divergence with price.",
    typicalParams: "Period 10–14 for short-term; 20–30 for medium-term momentum.",
    exampleRule: "ROC(10) crosses above 0 — price now higher than 10 periods ago, positive momentum shift.",
    fn: computeROC,
  },
  {
    id: "PSAR", displayName: "Parabolic SAR", category: "Trend",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [
      { key: "initialAF", label: "Initial AF", default: 0.02, min: 0.01, max: 0.1,  step: 0.01 },
      { key: "maxAF",     label: "Max AF",     default: 0.2,  min: 0.1,  max: 0.5,  step: 0.05 },
      { key: "stepAF",    label: "AF Step",    default: 0.02, min: 0.01, max: 0.05, step: 0.01 },
    ],
    description: "Parabolic SAR trails behind price, accelerating as the trend extends (the AF increases up to its maximum). When price crosses the SAR level, the trend is considered reversed and the SAR flips to the other side. It works well in trending markets but generates many whipsaws in ranging conditions.",
    commonUse: "Trailing stop placement, trend reversal detection, and trade management.",
    typicalParams: "AF 0.02, step 0.02, max 0.2 (Wilder's original). Lower AF for longer-term trends.",
    exampleRule: "Close > Parabolic SAR — SAR is below price, indicating uptrend; stay long while this holds.",
    fn: computeParabolicSAR,
  },
  {
    id: "OBV", displayName: "On-Balance Volume", category: "Volume",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [],
    description: "OBV is a cumulative volume indicator: when price closes up, the day's volume is added; when it closes down, volume is subtracted. The running total creates a line that reflects the buying and selling pressure behind price movements. Rising OBV with rising price confirms a trend; divergence between OBV and price often precedes reversals.",
    commonUse: "Volume-based trend confirmation, divergence signals, accumulation/distribution detection.",
    typicalParams: "No parameters — OBV is computed from all available price and volume data.",
    exampleRule: "OBV is making higher highs while price is not — bullish divergence, potential upside breakout.",
    fn: computeOBV,
  },
  {
    id: "VWAP", displayName: "VWAP", category: "Volume",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Lookback periods", default: 20, min: 5, max: 200, step: 5 }],
    description: "VWAP (Volume Weighted Average Price) is the average price weighted by volume over the lookback window. It represents the average price at which the market has transacted. Institutional traders use it as a benchmark; price above VWAP indicates bullish intraday sentiment, below indicates bearish.",
    commonUse: "Intraday trend bias, institutional benchmark comparison, dynamic support/resistance.",
    typicalParams: "Full-session VWAP resets daily. Rolling VWAP with 20–50 periods works on all timeframes.",
    exampleRule: "Close > VWAP(20) — price is above the volume-weighted average, suggesting bullish institutional bias.",
    fn: computeVWAP,
  },
  {
    id: "MFI", displayName: "Money Flow Index", category: "Volume",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 14, min: 5, max: 50, step: 2 }],
    description: "MFI combines price and volume to measure buying and selling pressure, ranging from 0 to 100. It is sometimes called the 'volume-weighted RSI'. Above 80 signals overbought with heavy buying; below 20 signals oversold with heavy selling. Divergence between MFI and price is a powerful early warning signal.",
    commonUse: "Volume-confirmed overbought/oversold signals, divergence with price, money flow analysis.",
    typicalParams: "Period 14. Overbought above 80; oversold below 20.",
    exampleRule: "MFI(14) < 20 — oversold with volume confirmation, stronger reversal signal than RSI alone.",
    fn: computeMFI,
  },
  {
    id: "KELTNER", displayName: "Keltner Channels", category: "Volatility",
    outputType: "band", outputKeys: ["values", "upper", "lower"],
    defaultParams: [
      { key: "period",     label: "EMA period",    default: 20, min: 5,   max: 50,  step: 5 },
      { key: "multiplier", label: "ATR multiplier", default: 2,  min: 0.5, max: 4,   step: 0.5 },
      { key: "atrPeriod",  label: "ATR period",    default: 10, min: 5,   max: 30,  step: 2 },
    ],
    description: "Keltner Channels surround price with bands at EMA ± (multiplier × ATR). Unlike Bollinger Bands, which use standard deviation, Keltner uses ATR, making the bands less sensitive to individual price spikes. When Bollinger Bands squeeze inside Keltner Channels, a 'Keltner Squeeze' indicates compressed volatility and an impending breakout.",
    commonUse: "Trend channel identification, breakout detection (especially the Keltner Squeeze), mean reversion.",
    typicalParams: "EMA 20, ATR 10, multiplier 2. Wider multiplier (2.5) for volatile markets.",
    exampleRule: "Close breaks above Keltner upper band — volatility expansion to the upside, momentum entry.",
    fn: computeKeltner,
  },
  {
    id: "DONCHIAN", displayName: "Donchian Channels", category: "Volatility",
    outputType: "band", outputKeys: ["values", "upper", "lower"],
    defaultParams: [{ key: "period", label: "Period", default: 20, min: 5, max: 100, step: 5 }],
    description: "Donchian Channels plot the highest high and lowest low over N periods, creating a price channel. A breakout above the upper channel signals potential long momentum; below the lower channel signals potential short momentum. The midline (average of upper and lower) acts as a mean reversion reference.",
    commonUse: "Trend breakout systems (Turtle Trading uses 20-day and 55-day Donchian), channel support/resistance.",
    typicalParams: "Period 20 for medium-term; 55 for the classic Turtle Trader system.",
    exampleRule: "Close equals Donchian upper(20) — price at 20-period high, classic momentum breakout long signal.",
    fn: computeDonchian,
  },
  {
    id: "VOLUMEMA", displayName: "Volume MA", category: "Volume",
    outputType: "single", outputKeys: ["values"],
    defaultParams: [{ key: "period", label: "Period", default: 20, min: 2, max: 100, step: 5 }],
    description: "Volume MA is simply the simple moving average of trading volume over N periods. It establishes the baseline typical volume for the instrument. A volume spike — current volume significantly above the MA — often accompanies meaningful price moves and can confirm the conviction behind a breakout or reversal.",
    commonUse: "Volume spike detection (volume > 1.5× or 2× its MA), confirming breakouts, filtering low-conviction moves.",
    typicalParams: "Period 20 (most common). Compare current volume to Volume MA as a ratio (e.g., > 1.5).",
    exampleRule: "Volume > VolumeMA(20) × 1.5 — above-average volume confirms the current price candle's significance.",
    fn: computeVolumeMA,
  },
  {
    id: "HEIKINASHI", displayName: "Heikin Ashi", category: "Trend",
    outputType: "multi", outputKeys: ["values", "open", "high", "low"],
    defaultParams: [],
    description: "Heikin Ashi ('average bar' in Japanese) transforms standard OHLC candles into smoothed bars that filter noise and make trends visually clearer. HA Close is the average of OHLC; HA Open is the average of the previous HA Open and Close. A series of hollow (bullish) bars with no lower wick indicates a strong uptrend; filled bars with no upper wick indicate a downtrend.",
    commonUse: "Trend identification and riding trends without being shaken out by minor pullbacks.",
    typicalParams: "No parameters. Works on any timeframe; best used on H1+ for trend clarity.",
    exampleRule: "HA Close > HA Open — current bar is bullish Heikin Ashi, trend is up.",
    fn: computeHeikinAshi,
  },
];

// ── Market Signal entries (auto-generated from manifest) ─────────────────────
//
// Each signalForScoring metric becomes an indicator whose fn reads
// candle.signals[key] — pre-attached by attachSignals() in backtest mode.
// In live mode signals are never populated, so NaN propagates naturally.

(function buildMarketSignalEntries() {
  try {
    const manifest = loadManifest();
    for (const m of manifest.metrics) {
      if (!m.signalForScoring) continue;
      const key = m.key;
      INDICATOR_REGISTRY.push({
        id:           `signal:${key}`,
        displayName:  m.label,
        category:     "Market Signal",
        outputType:   "single",
        outputKeys:   ["values"],
        defaultParams: [],
        description:  `Market signal: ${m.label}. Pre-computed from on-chain and exchange data — not derived from OHLCV. Only available in backtest mode (candles must have signals attached via attachSignals).`,
        commonUse:    m.dir ? `Directional tendency: ${m.dir}` : "No directional mapping measured yet.",
        typicalParams: "No parameters.",
        exampleRule:  `signal:${key} > 0.5 — signal value above threshold`,
        fn: (candles) => ({
          values: candles.map(c => {
            const v = c.signals?.[key];
            return (v !== undefined && v !== null) ? v : NaN;
          }),
        }),
      });
    }
  } catch {
    // Manifest not present (e.g. test environment without docs/ dir) — skip silently
  }
})();

export function getIndicator(id: string): (IndicatorMeta & { fn: IndicatorFn }) | undefined {
  return INDICATOR_REGISTRY.find(m => m.id === id);
}

/** Get the last non-NaN value from an indicator output array. */
export function lastValue(values: number[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (!isNaN(values[i])) return values[i];
  }
  return NaN;
}
