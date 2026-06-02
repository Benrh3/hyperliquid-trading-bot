import { config } from "./config.js";

export interface SizingResult {
  /** USD notional of the position (size × entryPrice) */
  notionalUsd: number;
  /** Base-asset units (e.g. 0.01 BTC) */
  sizeBase:    number;
  /** Effective leverage = notional / accountEquity */
  leverage:    number;
  /**
   * Dollar amount at risk if the stop-loss fires.
   * = notionalUsd × stopLossPercent/100
   * May exceed the originally-intended dollarRisk if the position was
   * scaled up to the leverage cap.
   */
  dollarRisk:  number;
}

/**
 * Compute position size using fixed-fractional risk management.
 *
 * Formula:
 *   dollarRisk   = accountEquity × riskPerTradePercent / 100
 *   stopDistance = entryPrice    × stopLossPercent / 100
 *   sizeBase     = dollarRisk / stopDistance
 *   notionalUsd  = sizeBase × entryPrice
 *              = accountEquity × riskPerTradePercent / stopLossPercent
 *   leverage     = notionalUsd / accountEquity
 *              = riskPerTradePercent / stopLossPercent
 *
 * The position is then capped at maxLeverage × accountEquity. When the cap
 * fires the trade is still placed at the maximum allowed size (no rejection —
 * the portfolio-level risk cap in RiskManager is the final gate).
 *
 * Both live and paper bots use this function with their respective account
 * equity so the maths is identical regardless of execution mode.
 */
export function computePositionSize(
  accountEquity: number,
  entryPrice:    number,
): SizingResult {
  const { riskPerTradePercent, stopLossPercent, maxLeverage } = config.risk;

  const intendedRisk = accountEquity * (riskPerTradePercent / 100);
  const stopDistance = entryPrice    * (stopLossPercent    / 100);

  let sizeBase    = intendedRisk / stopDistance;
  let notionalUsd = sizeBase * entryPrice;
  let leverage    = notionalUsd / accountEquity;

  // Cap at maxLeverage — scale the position down proportionally
  if (leverage > maxLeverage) {
    notionalUsd = accountEquity * maxLeverage;
    sizeBase    = notionalUsd / entryPrice;
    leverage    = maxLeverage;
  }

  const dollarRisk = notionalUsd * (stopLossPercent / 100);

  return { notionalUsd, sizeBase, leverage, dollarRisk };
}
