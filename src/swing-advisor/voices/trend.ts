import type { SwingDataSlice, HorizonConfig, VoiceResult, Direction } from "../types.js";

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    out.push(i === 0 ? values[0] : values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function neutral(reason: string, inputs: Record<string, number | null>): VoiceResult {
  return { name: "trend", direction: "NEUTRAL", strength: 0, effectiveStrength: 0, reason, inputs, validated: false };
}

/**
 * Trend voice: EMA structure + slope across three binary conditions.
 *
 * (a) Price vs EMA_fast — is price above or below short-term momentum?
 * (b) EMA_fast vs EMA_slow — are EMAs aligned (golden/death cross)?
 * (c) EMA_slow slope — is the slow trend accelerating or decelerating?
 *
 * 3/3 conditions matching = strength 1.0; 2/3 = 0.67; 1/3 or mixed = NEUTRAL.
 * Weighted up in CALM-TRENDING (1.5×), suppressed in HIGH-VOL (0.5×).
 */
export function trendVoice(slice: SwingDataSlice, cfg: HorizonConfig): VoiceResult {
  const candles = slice.candles;
  const needed  = cfg.emaSlow + cfg.emaSlopeWindow;

  if (candles.length < needed) {
    return neutral("Insufficient candle history for EMA", { candle_count: candles.length, needed });
  }

  const closes     = candles.map((c) => c.c);
  const emaFastArr = ema(closes, cfg.emaFast);
  const emaSlowArr = ema(closes, cfg.emaSlow);

  const last      = closes.length - 1;
  const price     = closes[last];
  const emaFastV  = emaFastArr[last];
  const emaSlowV  = emaSlowArr[last];
  const slopePct  = (emaSlowArr[last] - emaSlowArr[last - cfg.emaSlopeWindow]) / emaSlowArr[last - cfg.emaSlopeWindow];

  const cA_up = price    > emaFastV;
  const cB_up = emaFastV > emaSlowV;
  const cC_up = slopePct > 0;
  const longCount  = [cA_up, cB_up, cC_up].filter(Boolean).length;
  const shortCount = [!cA_up, !cB_up, !cC_up].filter(Boolean).length;

  if (longCount >= 2 && longCount > shortCount) {
    return {
      name: "trend", direction: "LONG", strength: longCount / 3, effectiveStrength: 0,
      reason: `${longCount}/3 uptrend conditions — price>${cfg.emaFast}EMA:${cA_up} aligned:${cB_up} slope+:${cC_up}`,
      inputs: { price, ema_fast: emaFastV, ema_slow: emaSlowV, slope_pct: slopePct, long_conditions: longCount },
      validated: false,
    };
  }

  if (shortCount >= 2 && shortCount > longCount) {
    return {
      name: "trend", direction: "SHORT", strength: shortCount / 3, effectiveStrength: 0,
      reason: `${shortCount}/3 downtrend conditions — price<${cfg.emaFast}EMA:${!cA_up} aligned:${!cB_up} slope-:${!cC_up}`,
      inputs: { price, ema_fast: emaFastV, ema_slow: emaSlowV, slope_pct: slopePct, short_conditions: shortCount },
      validated: false,
    };
  }

  return neutral(
    `Mixed EMA signals — ${longCount} long, ${shortCount} short conditions`,
    { price, ema_fast: emaFastV, ema_slow: emaSlowV, slope_pct: slopePct },
  );
}
