// hl-native staking + Assistance Fund metrics (market-spec.md §7 stage 3).
//
// Point-in-time computations from validatorSummaries, spotClearinghouseState,
// and userFillsByTime — no streaming state, everything is derived fresh from
// each poll's raw API responses.

/** HYPE's weiDecimals (spotMeta.tokens[].weiDecimals) — validator stake is reported in this unit. */
const HYPE_WEI_SCALE = 1e8;

export interface ValidatorSummaryLike {
  stake:    number;
  isJailed: boolean;
  isActive: boolean;
}

export interface StakingMetrics {
  totalStaked:    number;
  activeStaked:   number;
  validatorCount: number;
}

/** Σ stake (total) and Σ stake of non-jailed, active validators, both scaled to HYPE units. */
export function computeStakingMetrics(validators: ValidatorSummaryLike[]): StakingMetrics {
  let total = 0;
  let active = 0;
  for (const v of validators) {
    total += v.stake;
    if (!v.isJailed && v.isActive) active += v.stake;
  }
  return {
    totalStaked:    total / HYPE_WEI_SCALE,
    activeStaked:   active / HYPE_WEI_SCALE,
    validatorCount: validators.length,
  };
}

export interface SpotBalanceLike {
  coin:  string;
  token: number;
  total: string;
}

export interface AfFillLike {
  coin: string;
  side: "B" | "A";
  px:   string;
  sz:   string;
  time: number;
}

export interface AfMetrics {
  hypeBalance:   number | null;
  buyHypeWindow: number;
  buyUsdcWindow: number;
  buyFills:      number;
}

/**
 * AF HYPE balance (matched by token index, not name — multiple spot listings can
 * share the "HYPE" display name) plus buy-side fills for the resolved HYPE spot
 * coin with `time >= sinceMs`.
 */
export function computeAfMetrics(
  balances: SpotBalanceLike[],
  fills: AfFillLike[],
  hypeTokenIndex: number | null,
  spotCoinId: string | null,
  sinceMs: number,
): AfMetrics {
  const hypeBalance = hypeTokenIndex !== null
    ? Number(balances.find((b) => b.token === hypeTokenIndex)?.total ?? "0")
    : null;

  let buyHypeWindow = 0;
  let buyUsdcWindow = 0;
  let buyFills = 0;
  if (spotCoinId) {
    for (const f of fills) {
      if (f.coin !== spotCoinId || f.side !== "B" || f.time < sinceMs) continue;
      const sz = Number(f.sz);
      const px = Number(f.px);
      if (!Number.isFinite(sz) || !Number.isFinite(px)) continue;
      buyHypeWindow += sz;
      buyUsdcWindow += sz * px;
      buyFills += 1;
    }
  }
  return { hypeBalance, buyHypeWindow, buyUsdcWindow, buyFills };
}
