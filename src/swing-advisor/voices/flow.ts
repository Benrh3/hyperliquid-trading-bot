import type { SwingDataSlice, HorizonConfig, VoiceResult } from "../types.js";

function neutral(reason: string, inputs: Record<string, number | null>): VoiceResult {
  return { name: "flow", direction: "NEUTRAL", strength: 0, effectiveStrength: 0, reason, inputs, validated: false };
}

function linearSlope(xs: number[], ys: number[]): number {
  const n    = xs.length;
  const xBar = xs.reduce((a, b) => a + b, 0) / n;
  const yBar = ys.reduce((a, b) => a + b, 0) / n;
  const num  = xs.reduce((a, xi, i) => a + (xi - xBar) * (ys[i] - yBar), 0);
  const den  = xs.reduce((a, xi) => a + (xi - xBar) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

/**
 * Flow voice: linear regression slope of cumulative-volume-delta (CVD) over the horizon window.
 *
 * Rising CVD slope → sustained buying pressure → LONG.
 * Falling CVD slope → sustained selling pressure → SHORT.
 *
 * Strength is normalised against the 90th-percentile absolute slope in the lookback window
 * so it adapts to the volatility of CVD in the current regime rather than using an
 * arbitrary fixed threshold.
 */
export function flowVoice(slice: SwingDataSlice, cfg: HorizonConfig): VoiceResult {
  const cutoff  = slice.asOfMs - cfg.cvdSlopeWindowMs;
  const history = slice.cvdHistory
    .filter((p) => p.capturedAt >= cutoff && p.value !== null)
    .sort((a, b) => a.capturedAt - b.capturedAt);

  if (history.length < 6) {
    return neutral("Insufficient CVD history for slope", { sample_count: history.length });
  }

  const xs = history.map((p) => p.capturedAt);
  const ys = history.map((p) => p.value as number);

  // Normalise xs to [0, 1] to keep slope numerically stable
  const xMin  = xs[0];
  const xMax  = xs[xs.length - 1];
  const xSpan = xMax - xMin || 1;
  const xNorm = xs.map((x) => (x - xMin) / xSpan);

  const slope = linearSlope(xNorm, ys);

  // Reference scale: stddev of point-to-point changes in the full lookback window
  const deltas: number[] = [];
  for (let i = 1; i < ys.length; i++) deltas.push(Math.abs(ys[i] - ys[i - 1]));
  const deltaStd = deltas.length > 1
    ? Math.sqrt(deltas.reduce((a, d) => a + d ** 2, 0) / deltas.length)
    : 1;

  if (deltaStd < 1e-10) {
    return neutral("CVD has no variance in window", { slope, delta_std: deltaStd });
  }

  // Normalise slope magnitude against delta_std * number_of_normalised_time_units
  const normalised = Math.abs(slope) / (deltaStd * ys.length);
  const strength   = Math.min(1, normalised);

  const THRESHOLD = 0.05;
  if (strength < THRESHOLD) {
    return neutral(
      `CVD slope near zero (norm=${normalised.toFixed(3)})`,
      { slope, delta_std: deltaStd, normalised_strength: normalised, sample_count: history.length },
    );
  }

  const direction = slope > 0 ? "LONG" : "SHORT";
  return {
    name: "flow", direction, strength, effectiveStrength: 0,
    reason: `CVD ${slope > 0 ? "rising" : "falling"} — sustained ${slope > 0 ? "buy" : "sell"} flow (strength=${strength.toFixed(2)})`,
    inputs: {
      slope,
      delta_std: deltaStd,
      normalised_strength: normalised,
      current_cvd: ys[ys.length - 1],
      start_cvd: ys[0],
      sample_count: history.length,
    },
    validated: false,
  };
}
