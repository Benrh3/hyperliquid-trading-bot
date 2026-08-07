import type { SwingDataSlice, HorizonConfig, VoiceResult } from "../types.js";

function neutral(reason: string, inputs: Record<string, number | null>): VoiceResult {
  return { name: "capitulation", direction: "NEUTRAL", strength: 0, effectiveStrength: 0, reason, inputs, validated: false };
}

function percentileRank(sorted: number[], value: number): number {
  return sorted.filter((v) => v <= value).length / sorted.length;
}

/**
 * Capitulation voice: liquidation spike + simultaneous volatility spike.
 *
 * Both conditions must be elevated for a directional call:
 *   - Net liq imbalance (long_liq − short_liq) at an extreme percentile
 *   - Recent vol (measured from candle range) above its window 80th percentile
 *
 * Interpretation:
 *   Heavy LONG liquidations + high vol → forced sellers exhausted → LONG (buy the dip).
 *   Heavy SHORT liquidations + high vol → squeeze exhausted → SHORT (fade the move).
 *   No spike or vol below threshold → NEUTRAL.
 *
 * Weighted 1.5× in HIGH-VOL, 0.6× in CHOP, 1.0× in CALM-TRENDING.
 */
export function capitulationVoice(slice: SwingDataSlice, cfg: HorizonConfig): VoiceResult {
  const cutoff = slice.asOfMs - cfg.liqSpikeWindowMs;

  const liqLong  = slice.liqLongHistory.filter((p) => p.capturedAt >= cutoff && p.value !== null);
  const liqShort = slice.liqShortHistory.filter((p) => p.capturedAt >= cutoff && p.value !== null);

  if (liqLong.length < 10 || liqShort.length < 10) {
    return neutral("Insufficient liquidation history", {
      liq_long_count: liqLong.length,
      liq_short_count: liqShort.length,
    });
  }

  // Align by index (both should have identical cadence from snapshot poller)
  const len = Math.min(liqLong.length, liqShort.length);
  const netLiq  = Array.from({ length: len }, (_, i) =>
    (liqLong[i].value as number) - (liqShort[i].value as number));

  const currentNet = netLiq[netLiq.length - 1];
  const sortedNet  = [...netLiq].sort((a, b) => a - b);
  const netRank    = percentileRank(sortedNet, currentNet);

  // Vol proxy: mean high-low range of recent candles vs the full candle window
  const candles = slice.candles;
  if (candles.length < 10) {
    return neutral("Insufficient candles for vol proxy", { candle_count: candles.length });
  }

  const allRanges     = candles.map((c) => c.h - c.l);
  const recentRanges  = allRanges.slice(-8);
  const recentAvgRange = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
  const sortedRanges   = [...allRanges].sort((a, b) => a - b);
  const volPct80       = sortedRanges[Math.floor(sortedRanges.length * 0.8)];
  const volElevated    = recentAvgRange >= volPct80;

  const LIQ_LONG_THRESHOLD  = 0.85;  // top 15% long-heavy net liq → long liq spike
  const LIQ_SHORT_THRESHOLD = 0.15;  // bottom 15% short-heavy net liq → short liq spike

  const inputs = {
    current_net_liq:  currentNet,
    net_liq_rank:     netRank,
    recent_avg_range: recentAvgRange,
    vol_pct80:        volPct80,
    vol_elevated:     volElevated ? 1 : 0,
    liq_long_total:   liqLong.reduce((a, p) => a + (p.value as number), 0),
    liq_short_total:  liqShort.reduce((a, p) => a + (p.value as number), 0),
    sample_count:     len,
  };

  // Spike but no vol confirmation → weak signal, treat as NEUTRAL
  if (!volElevated) {
    return neutral("Liq data present but vol not elevated — no capitulation spike", inputs);
  }

  if (netRank >= LIQ_LONG_THRESHOLD) {
    const strength = Math.min(1, (netRank - LIQ_LONG_THRESHOLD) / (1 - LIQ_LONG_THRESHOLD));
    return {
      name: "capitulation", direction: "LONG", strength, effectiveStrength: 0,
      reason: `Long liquidation spike (net_rank=${(netRank * 100).toFixed(0)}th pct) + elevated vol — forced sellers exhausted`,
      inputs,
      validated: false,
    };
  }

  if (netRank <= LIQ_SHORT_THRESHOLD) {
    const strength = Math.min(1, (LIQ_SHORT_THRESHOLD - netRank) / LIQ_SHORT_THRESHOLD);
    return {
      name: "capitulation", direction: "SHORT", strength, effectiveStrength: 0,
      reason: `Short liquidation spike (net_rank=${(netRank * 100).toFixed(0)}th pct) + elevated vol — squeeze exhausted`,
      inputs,
      validated: false,
    };
  }

  return neutral(`Net liq rank ${(netRank * 100).toFixed(0)}th pct — no spike at either extreme`, inputs);
}
