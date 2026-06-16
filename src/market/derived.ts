// Pure computation of the 10 derived signals (manifest derived=true).
// No I/O — takes current snapshot context + previous snapshot metric values.
// Signals whose upstream inputs are still stubbed (net_twap_*) naturally return
// null until those stages land; that is expected and documented in the manifest.
//
// market-spec.md §7 stage 6.

import { safeNum } from "./registry.js";
import type { MarketPollContext } from "./registry.js";

export interface DerivedInputs {
  /** Raw metric values from the previous snapshot keyed by metric_key. Null entry or missing = not yet available. */
  prev: Record<string, number | null | undefined>;
  /** ms elapsed since the previous snapshot. Null on cold start (no prev). */
  intervalMs: number | null;
}

export interface DerivedValues {
  /** net scheduled TWAP buying − selling (prorated). Null until stage-3b TWAP lands. */
  netTwapHype:      number | null;
  /** Same using full-position TWAP sizes. Null until stage-3b. */
  netTwapFullHype:  number | null;
  /** open_interest(now) − open_interest(prev). */
  oiDelta:          number | null;
  /** spot_mark_px − perp_mark_px. Null when spot is unavailable. */
  spotPerpBasis:    number | null;
  /** unstake_queue_hype(now) − prev. */
  unstakeQDelta:    number | null;
  /** total_staked_hype(now) − prev. */
  stakedDelta:      number | null;
  /** af_buy_hype_window ÷ intervalHours (HYPE per hour). */
  afBuyRate:        number | null;
  /** cex_total_balance_hype(now) − prev. */
  cexBalanceDelta:  number | null;
  /** holder_top10_share(now) − prev. */
  holderTop10Delta: number | null;
  /** cex_oi_total_hype(now) − prev. */
  cexOiDelta:       number | null;
}

/**
 * Compute all 10 derived signal values from the current poll context and
 * previous snapshot metric values. Returns a DerivedValues object where any
 * missing upstream input yields null for that signal (never throws).
 */
export function computeDerived(
  ctx: Omit<MarketPollContext, "derived">,
  inputs: DerivedInputs,
): DerivedValues {
  const prev = (key: string): number | null => inputs.prev[key] ?? null;

  // ── TWAP-based (null until stage-3b) ───────────────────────────────────────
  // The raw twap_* metrics are stage-3b stubs. They'll be in the prev snapshot
  // as null until that stage lands. When they do, this naturally starts computing.
  const twapSpotBuy  = prev("twap_spot_buy_hype");
  const twapSpotSell = prev("twap_spot_sell_hype");
  const twapPerpBuy  = prev("twap_perp_buy_hype");
  const twapPerpSell = prev("twap_perp_sell_hype");
  const twapSpotBuyFull  = prev("twap_spot_buy_full_hype");
  const twapSpotSellFull = prev("twap_spot_sell_full_hype");
  const twapPerpBuyFull  = prev("twap_perp_buy_full_hype");
  const twapPerpSellFull = prev("twap_perp_sell_full_hype");

  const netTwapHype =
    twapSpotBuy !== null && twapSpotSell !== null && twapPerpBuy !== null && twapPerpSell !== null
      ? twapSpotBuy + twapPerpBuy - twapSpotSell - twapPerpSell
      : null;

  const netTwapFullHype =
    twapSpotBuyFull !== null && twapSpotSellFull !== null && twapPerpBuyFull !== null && twapPerpSellFull !== null
      ? twapSpotBuyFull + twapPerpBuyFull - twapSpotSellFull - twapPerpSellFull
      : null;

  // ── Market-level deltas ────────────────────────────────────────────────────
  const oi        = safeNum(ctx.perpCtx.openInterest);
  const prevOi    = prev("open_interest");
  const oiDelta   = oi !== null && prevOi !== null ? oi - prevOi : null;

  const spotPx    = ctx.spotCtx ? safeNum(ctx.spotCtx.markPx) : null;
  const perpPx    = safeNum(ctx.perpCtx.markPx);
  const spotPerpBasis = spotPx !== null && perpPx !== null ? spotPx - perpPx : null;

  // ── Staking / supply deltas ────────────────────────────────────────────────
  const totalStaked    = ctx.hlNative?.staking?.totalStaked ?? null;
  const prevStaked     = prev("total_staked_hype");
  const stakedDelta    = totalStaked !== null && prevStaked !== null ? totalStaked - prevStaked : null;

  const unstakeQ       = prev("unstake_queue_hype");   // raw metric from prev snapshot
  const prevUnstakeQ   = prev("unstake_queue_hype");   // same field in prev
  // Note: unstake_q_delta = change in the current unstake_queue value vs its own prev.
  // The CURRENT unstake_queue value isn't in ctx (it lives in hlNative stubs for now).
  // We read it from the PREVIOUS snapshot (vs the snapshot before that).
  // Since we have no "prev-of-prev" here, we compute it differently:
  // unstake_q_delta = unstake_queue_hype(now, from ctx if available) − prev(unstake_queue_hype)
  // Until the unstake_queue metric is populated by the poller, this is null.
  // We expose the current value via hlNative when stage-3b adds it to ctx.
  // For now: unstake_queue_hype is a stub, so this is null.
  const currentUnstakeQ = null as number | null; // stage-3b: replace with ctx.hlNative?.unstakeQueue
  const unstakeQDelta = currentUnstakeQ !== null && unstakeQ !== null ? currentUnstakeQ - unstakeQ : null;

  // ── AF buy rate ────────────────────────────────────────────────────────────
  const afBuyWindow   = ctx.hlNative?.af?.buyHypeWindow ?? null;
  const intervalMs    = inputs.intervalMs;
  const intervalHours = intervalMs !== null && intervalMs > 0 ? intervalMs / 3_600_000 : null;
  const afBuyRate     = afBuyWindow !== null && intervalHours !== null ? afBuyWindow / intervalHours : null;

  // ── On-chain deltas ────────────────────────────────────────────────────────
  const cexBal       = ctx.onChain?.totalBalance ?? null;
  const prevCexBal   = prev("cex_total_balance_hype");
  const cexBalanceDelta = cexBal !== null && prevCexBal !== null ? cexBal - prevCexBal : null;

  const holderTop10   = ctx.onChain?.holders?.top10Share ?? null;
  const prevHolderTop = prev("holder_top10_share");
  const holderTop10Delta = holderTop10 !== null && prevHolderTop !== null ? holderTop10 - prevHolderTop : null;

  // ── CEX OI delta ──────────────────────────────────────────────────────────
  const cexOi      = ctx.cex?.oi.total ?? null;
  const prevCexOi  = prev("cex_oi_total_hype");
  const cexOiDelta = cexOi !== null && prevCexOi !== null ? cexOi - prevCexOi : null;

  return {
    netTwapHype,
    netTwapFullHype,
    oiDelta,
    spotPerpBasis,
    unstakeQDelta,
    stakedDelta,
    afBuyRate,
    cexBalanceDelta,
    holderTop10Delta,
    cexOiDelta,
  };
}
