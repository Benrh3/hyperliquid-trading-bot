// Unit tests for funding-rate annualization.
// Convention: simple annualization (rate × periods_per_year), not compounding.

import { describe, it, expect } from "vitest";

const HOURS_PER_YEAR = 8760;

function simpleAnnualize(hourlyRate: number): number {
  return hourlyRate * HOURS_PER_YEAR;
}

describe("funding annualization", () => {
  it("uses simple multiplication, not compounding", () => {
    const rate = 0.000185; // 0.0185%/hr (typical ETH funding)
    const simple    = simpleAnnualize(rate);
    const compounded = Math.pow(1 + rate, HOURS_PER_YEAR) - 1;

    // Simple: 0.000185 × 8760 ≈ 1.6206 (162%)
    expect(simple).toBeCloseTo(1.6206, 2);
    // Compounded would be ~4.07 (407%) — wildly inflated
    expect(compounded).toBeGreaterThan(4);
    // The two are NOT close — compounding inflates by ~2.5×
    expect(Math.abs(compounded - simple)).toBeGreaterThan(2);
  });

  it("periods-per-year is 8760 for hourly funding", () => {
    expect(HOURS_PER_YEAR).toBe(24 * 365);
  });

  it("negative rates annualize correctly", () => {
    const rate = -0.0001; // -0.01%/hr
    expect(simpleAnnualize(rate)).toBeCloseTo(-0.876, 3);
  });

  it("zero rate annualizes to zero", () => {
    expect(simpleAnnualize(0)).toBe(0);
  });
});
