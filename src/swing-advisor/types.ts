export type Direction  = "LONG" | "SHORT" | "NEUTRAL";
export type Call       = "LONG" | "SHORT" | "STAND ASIDE";
export type Regime     = "CALM-TRENDING" | "HIGH-VOL" | "CHOP";
export type HorizonName = "daily" | "weekly" | "monthly";

export interface VoiceResult {
  name: string;
  direction: Direction;
  strength: number;          // raw 0..1 before regime weighting
  effectiveStrength: number; // min(1, strength × regime_weight) — filled by deriveVerdict
  reason: string;
  inputs: Record<string, number | string | null>;
  validated: boolean;        // false until IC is measured via replay backtest
}

export interface RegimeResult {
  regime: Regime;
  realizedVol: number;       // annualized
  trendStrength: number;     // |EMA_fast − EMA_slow| / ATR_14
  inputs: Record<string, number | null>;
}

export interface VerdictResult {
  call: Call;
  conflict: boolean;
  compositeScore: number;    // weighted sum / total_weight, -1..1
  agreementScore: number;    // agreeing_non_neutral / total_non_neutral, 0..1
  agreeingCount: number;
  nonNeutralCount: number;
  strongLongVoices: string[];
  strongShortVoices: string[];
  voices: VoiceResult[];     // effectiveStrength filled in
}

export interface Candle {
  t: number;  // open-time ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MetricPoint {
  capturedAt: number;        // unix ms
  value: number | null;
}

export interface SwingDataSlice {
  candles: Candle[];
  fundingHistory: MetricPoint[];   // funding_rate
  lsrHistory: MetricPoint[];       // lsr_agg_long_frac
  cvdHistory: MetricPoint[];       // cvd_perp_24h
  liqLongHistory: MetricPoint[];   // cex_liq_long_1h
  liqShortHistory: MetricPoint[];  // cex_liq_short_1h
  priceHistory: MetricPoint[];     // perp_mark_px
  currentPrice: number | null;
  asOfMs: number;
}

export interface HorizonConfig {
  name: HorizonName;
  candleInterval: "1h" | "4h" | "1d";
  lookbackMs: number;
  lookbackCandles: number;
  // Voice-specific windows
  fundingWindowMs: number;
  emaFast: number;
  emaSlow: number;
  emaSlopeWindow: number;        // candles for EMA slope
  lsrPercentileWindowMs: number;
  cvdSlopeWindowMs: number;
  liqSpikeWindowMs: number;
  // Verdict thresholds
  conflictThreshold: number;     // effective_strength to qualify as "strong" for conflict check
  verdictThreshold: number;      // |composite| needed for a directional call
  // Scheduling
  pollIntervalMs: number;
  telegramRateLimitMs: number;
  forwardWindowMs: number;       // horizon length — when to fill forward_return
}

// ── DB row shapes ────────────────────────────────────────────────────────────

export interface SwingCurrentStateRow {
  horizon: HorizonName;
  call: Call;
  updated_at: number;
  last_computed_at: number;
  regime: Regime;
  composite_score: number | null;
  agreement_score: number | null;
  voices_json: string;
  last_notified_at: number | null;
}

export interface SwingFlipRow {
  id: number;
  created_at: number;
  horizon: HorizonName;
  old_call: Call;
  new_call: Call;
  hype_price: number | null;
  regime: Regime;
  agreement_score: number | null;
  composite_score: number | null;
  voices_json: string;
  forward_return: number | null;
  fill_after_at: number;
}
