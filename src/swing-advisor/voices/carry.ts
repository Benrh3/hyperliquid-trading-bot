import type { SwingDataSlice, HorizonConfig, VoiceResult } from "../types.js";

function neutral(reason: string, inputs: Record<string, number | null>): VoiceResult {
  return { name: "carry", direction: "NEUTRAL", strength: 0, effectiveStrength: 0, reason, inputs, validated: false };
}

/**
 * Carry voice: sustained funding-rate deviation from its recent mean.
 *
 * High positive z-score → longs overpaying carry → SHORT.
 * High negative z-score → longs receiving from shorts → LONG.
 *
 * Carry is the only voice with ~20 months of clean data; it earns the
 * highest weight in HIGH-VOL (1.8×) where funding extremes are most predictive.
 */
export function carryVoice(slice: SwingDataSlice, cfg: HorizonConfig): VoiceResult {
  const cutoff  = slice.asOfMs - cfg.fundingWindowMs;
  const history = slice.fundingHistory
    .filter((p) => p.capturedAt >= cutoff && p.value !== null)
    .map((p) => p.value as number);

  if (history.length < 10) {
    return neutral("Insufficient funding history", { sample_count: history.length });
  }

  const mean     = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
  const std      = Math.sqrt(variance);
  const current  = history[history.length - 1];

  if (std < 1e-10) {
    return neutral("Funding rate has no variance over window", { mean, std });
  }

  const zScore = (current - mean) / std;
  const Z_THRESHOLD = 1.5; // z at which strength = 1.0
  const strength    = Math.min(1, Math.abs(zScore) / Z_THRESHOLD);

  if (Math.abs(zScore) < 0.3) {
    return {
      name: "carry", direction: "NEUTRAL", strength: 0, effectiveStrength: 0,
      reason: `Funding near mean (z = ${zScore.toFixed(2)})`,
      inputs: { current_rate: current, window_mean: mean, window_std: std, z_score: zScore },
      validated: false,
    };
  }

  const direction = zScore > 0 ? "SHORT" : "LONG";
  const reason    = direction === "SHORT"
    ? `Funding ${zScore.toFixed(1)}σ above mean — longs overpaying carry`
    : `Funding ${Math.abs(zScore).toFixed(1)}σ below mean — longs receiving from shorts`;

  return {
    name: "carry", direction, strength, effectiveStrength: 0, reason,
    inputs: {
      current_rate:   current,
      window_mean:    mean,
      window_std:     std,
      z_score:        zScore,
      sample_count:   history.length,
    },
    validated: false,
  };
}
