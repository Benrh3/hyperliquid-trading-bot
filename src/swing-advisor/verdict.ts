import type { VoiceResult, RegimeResult, VerdictResult, HorizonConfig } from "./types.js";

/**
 * Regime-specific weight multipliers per voice.
 *
 * Base weights reflect validated data quality (carry = most data, others = unvalidated).
 * Multipliers scale up voices that are more predictive in each regime.
 *
 * Carry earns 1.8× in HIGH-VOL — it has 20 months of clean data and funding extremes
 * are most predictive when the market is stressed.
 * Capitulation is capped at 1.5× in HIGH-VOL (originally designed 1.8×, conservatively
 * reduced until IC is measured).
 */
const BASE_WEIGHTS: Record<string, number> = {
  carry:         1.0,
  positioning:   0.8,
  trend:         0.8,
  flow:          0.8,
  capitulation:  0.8,
};

const REGIME_MULTIPLIERS: Record<string, Record<string, number>> = {
  "CALM-TRENDING": {
    carry:         1.2,
    positioning:   1.0,
    trend:         1.5,
    flow:          1.2,
    capitulation:  0.6,
  },
  "HIGH-VOL": {
    carry:         1.8,
    positioning:   1.2,
    trend:         0.5,
    flow:          1.0,
    capitulation:  1.5,
  },
  "CHOP": {
    carry:         1.0,
    positioning:   1.3,
    trend:         0.4,
    flow:          0.8,
    capitulation:  0.6,
  },
};

/**
 * Derives a regime-weighted verdict from all voice results.
 *
 * Each voice contributes a signed score:
 *   LONG  → +strength × weight × regime_multiplier
 *   SHORT → −strength × weight × regime_multiplier
 *   NEUTRAL → 0
 *
 * compositeScore = sum / total_weight  (range −1..1)
 * agreementScore = agreeing_non_neutral / total_non_neutral  (0..1)
 *
 * CONFLICT: two or more voices above conflictThreshold pointing opposite directions.
 * If conflict → call = "STAND ASIDE" regardless of composite score.
 * Otherwise: |compositeScore| >= verdictThreshold → directional call; else STAND ASIDE.
 */
export function deriveVerdict(
  voices: VoiceResult[],
  regime: RegimeResult,
  cfg: HorizonConfig,
): VerdictResult {
  const multipliers = REGIME_MULTIPLIERS[regime.regime] ?? REGIME_MULTIPLIERS["CHOP"];
  const filled      = voices.map((v) => {
    const baseW  = BASE_WEIGHTS[v.name] ?? 0.8;
    const mult   = multipliers[v.name] ?? 1.0;
    const effStr = Math.min(1, v.strength * mult);
    return { ...v, effectiveStrength: effStr, _weight: baseW * mult };
  });

  let weightedSum  = 0;
  let totalWeight  = 0;
  let nonNeutral   = 0;
  let agreeing     = 0;
  const strongLong:  string[] = [];
  const strongShort: string[] = [];

  for (const v of filled) {
    const w = (v as VoiceResult & { _weight: number })._weight;
    if (v.direction === "NEUTRAL") continue;

    nonNeutral++;
    const signed = v.direction === "LONG" ? v.effectiveStrength : -v.effectiveStrength;
    weightedSum += signed * w;
    totalWeight += w;

    if (v.effectiveStrength >= cfg.conflictThreshold) {
      if (v.direction === "LONG")  strongLong.push(v.name);
      if (v.direction === "SHORT") strongShort.push(v.name);
    }
  }

  const compositeScore  = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const dominantDir     = compositeScore >= 0 ? "LONG" : "SHORT";

  for (const v of filled) {
    if (v.direction !== "NEUTRAL" && v.direction === dominantDir) agreeing++;
  }

  const agreementScore = nonNeutral > 0 ? agreeing / nonNeutral : 0;

  // Strip internal _weight before returning
  const cleanVoices = filled.map(({ ...rest }) => {
    const r = rest as VoiceResult & { _weight?: number };
    delete r._weight;
    return r as VoiceResult;
  });

  const conflict = strongLong.length >= 1 && strongShort.length >= 1;

  let call: VerdictResult["call"] = "STAND ASIDE";
  if (!conflict) {
    if (compositeScore >= cfg.verdictThreshold)  call = "LONG";
    if (compositeScore <= -cfg.verdictThreshold) call = "SHORT";
  }

  return {
    call,
    conflict,
    compositeScore,
    agreementScore,
    agreeingCount:    agreeing,
    nonNeutralCount:  nonNeutral,
    strongLongVoices:  strongLong,
    strongShortVoices: strongShort,
    voices: cleanVoices,
  };
}
