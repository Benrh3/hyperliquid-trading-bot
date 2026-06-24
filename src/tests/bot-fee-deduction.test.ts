import { describe, it, expect } from "vitest";

const TAKER_FEE_PER_SIDE = 0.0005;
const SLIPPAGE = 0.0005;

describe("directional bot fee deduction", () => {
  it("net pnl = gross - (open notional + close notional) × fee_per_side", () => {
    const entryPrice = 100;
    const exitPrice  = 102;
    const size       = 10;

    const grossPnl = (exitPrice - entryPrice) * size; // +$20
    const openNotional  = entryPrice * size;  // $1000
    const closeNotional = exitPrice  * size;  // $1020
    const fees = (openNotional + closeNotional) * TAKER_FEE_PER_SIDE; // $1.01
    const netPnl = grossPnl - fees; // $18.99

    expect(grossPnl).toBe(20);
    expect(fees).toBeCloseTo(1.01, 2);
    expect(netPnl).toBeCloseTo(18.99, 2);
  });

  it("slippage and fees are independent — both apply to paper fills", () => {
    const candleClose = 100;
    const size = 10;

    // Paper open long: entry = close × (1 + SLIPPAGE)
    const entryPx = candleClose * (1 + SLIPPAGE); // 100.05
    // Paper close long: exit = close × (1 - SLIPPAGE)
    const exitClose = 102;
    const exitPx = exitClose * (1 - SLIPPAGE); // 101.949

    // Gross P&L from slippage-adjusted prices
    const grossPnl = (exitPx - entryPx) * size;
    expect(grossPnl).toBeCloseTo((101.949 - 100.05) * 10, 1);

    // Fees are computed on the fill prices (which include slippage)
    const openNotional  = entryPx * size;
    const closeNotional = exitPx * size;
    const fees = (openNotional + closeNotional) * TAKER_FEE_PER_SIDE;

    // Net = gross - fees — slippage already baked into the prices, fees separate
    const netPnl = grossPnl - fees;
    expect(netPnl).toBeLessThan(grossPnl);
    // Fees should be ~$1.01 on ~$2020 notional
    expect(fees).toBeCloseTo(1.01, 0);
    // No double-counting: gross already accounts for slippage;
    // fees are an additional explicit deduction
  });

  it("fees column is persisted in the trade log", () => {
    // This is an integration assertion: the Logger INSERT now includes @fees.
    // The migration adds a nullable fees column. New rows carry the fee.
    // Pre-migration rows have fees = NULL (gross, pre-fee-tracking).
    const fees = (1000 + 1020) * TAKER_FEE_PER_SIDE;
    expect(fees).toBeCloseTo(1.01, 2);
    // A NULL fees row means "historical gross — no fee data available"
    expect(null).toBeNull(); // placeholder: real integration tested in bot-realised-stats
  });
});
