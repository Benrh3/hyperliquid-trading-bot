import type { SwingDataSlice, HorizonConfig, VoiceResult } from "../types.js";

function neutral(reason: string, inputs: Record<string, number | null>): VoiceResult {
  return { name: "positioning", direction: "NEUTRAL", strength: 0, effectiveStrength: 0, reason, inputs, validated: false };
}

/**
 * Positioning voice: contrarian read on aggregate long/short ratio (LSR).
 *
 * Crowd at extreme long positioning → SHORT (washout likely).
 * Crowd at extreme short positioning → LONG (squeeze likely).
 * Percentile rank within lookback window; thresholds at 20th / 80th pct.
 */
export function positioningVoice(slice: SwingDataSlice, cfg: HorizonConfig): VoiceResult {
  const cutoff  = slice.asOfMs - cfg.lsrPercentileWindowMs;
  const history = slice.lsrHistory
    .filter((p) => p.capturedAt >= cutoff && p.value !== null)
    .map((p) => p.value as number);

  if (history.length < 10) {
    return neutral("Insufficient LSR history", { sample_count: history.length });
  }

  const current = history[history.length - 1];
  const sorted  = [...history].sort((a, b) => a - b);
  const rank    = sorted.filter((v) => v <= current).length / sorted.length;

  const LONG_PCT  = 0.20;  // <20th pct → crowd short, contrarian LONG
  const SHORT_PCT = 0.80;  // >80th pct → crowd long, contrarian SHORT

  if (rank < LONG_PCT) {
    const strength = Math.min(1, (LONG_PCT - rank) / LONG_PCT);
    return {
      name: "positioning", direction: "LONG", strength, effectiveStrength: 0,
      reason: `LSR at ${(rank * 100).toFixed(0)}th pct — crowd short, contrarian LONG`,
      inputs: { current_lsr: current, percentile_rank: rank, window_min: sorted[0], window_max: sorted[sorted.length - 1], sample_count: history.length },
      validated: false,
    };
  }

  if (rank > SHORT_PCT) {
    const strength = Math.min(1, (rank - SHORT_PCT) / (1 - SHORT_PCT));
    return {
      name: "positioning", direction: "SHORT", strength, effectiveStrength: 0,
      reason: `LSR at ${(rank * 100).toFixed(0)}th pct — crowd long, contrarian SHORT`,
      inputs: { current_lsr: current, percentile_rank: rank, window_min: sorted[0], window_max: sorted[sorted.length - 1], sample_count: history.length },
      validated: false,
    };
  }

  return neutral(
    `LSR at ${(rank * 100).toFixed(0)}th pct — no positioning extreme`,
    { current_lsr: current, percentile_rank: rank, window_min: sorted[0], window_max: sorted[sorted.length - 1], sample_count: history.length },
  );
}
