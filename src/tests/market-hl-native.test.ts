/**
 * Tests for hl-native staking + Assistance Fund compute helpers — no network
 * calls, exercised against hand-built validatorSummaries / spotClearinghouseState
 * / userFillsByTime shapes.
 */

import { describe, it, expect } from "vitest";
import { computeStakingMetrics, computeAfMetrics, type ValidatorSummaryLike, type SpotBalanceLike, type AfFillLike } from "../market/hlNative.js";

describe("computeStakingMetrics", () => {
  const validators: ValidatorSummaryLike[] = [
    { stake: 600_000_000e8, isJailed: false, isActive: true },
    { stake: 400_000_000e8, isJailed: false, isActive: true },
    { stake: 10_000_000e8,  isJailed: true,  isActive: false },
  ];

  it("sums total stake across all validators, scaled to HYPE units", () => {
    const m = computeStakingMetrics(validators);
    expect(m.totalStaked).toBeCloseTo(1_010_000_000, 5);
  });

  it("sums active stake only for non-jailed, active validators", () => {
    const m = computeStakingMetrics(validators);
    expect(m.activeStaked).toBeCloseTo(1_000_000_000, 5);
  });

  it("counts every validator regardless of jailed status", () => {
    const m = computeStakingMetrics(validators);
    expect(m.validatorCount).toBe(3);
  });

  it("excludes a non-jailed but inactive validator from active stake", () => {
    const m = computeStakingMetrics([
      ...validators,
      { stake: 5_000_000e8, isJailed: false, isActive: false },
    ]);
    expect(m.activeStaked).toBeCloseTo(1_000_000_000, 5);
    expect(m.totalStaked).toBeCloseTo(1_015_000_000, 5);
    expect(m.validatorCount).toBe(4);
  });

  it("handles an empty validator set", () => {
    const m = computeStakingMetrics([]);
    expect(m).toEqual({ totalStaked: 0, activeStaked: 0, validatorCount: 0 });
  });
});

const HYPE_TOKEN_INDEX = 150;
const SPOT_COIN = "@107";

function balances(hypeTotal: string): SpotBalanceLike[] {
  return [
    { coin: "USDC", token: 0, total: "9108.0" },
    { coin: "HYPE", token: HYPE_TOKEN_INDEX, total: hypeTotal },
  ];
}

function fill(overrides: Partial<AfFillLike> = {}): AfFillLike {
  return { coin: SPOT_COIN, side: "B", px: "25.0", sz: "100", time: 1_000_000, ...overrides };
}

describe("computeAfMetrics", () => {
  it("reads the AF HYPE balance by token index, not coin name", () => {
    const m = computeAfMetrics(balances("45219365.9"), [], HYPE_TOKEN_INDEX, SPOT_COIN, 0);
    expect(m.hypeBalance).toBeCloseTo(45219365.9, 5);
  });

  it("returns null balance when the canonical token index could not be resolved", () => {
    const m = computeAfMetrics(balances("45219365.9"), [], null, SPOT_COIN, 0);
    expect(m.hypeBalance).toBeNull();
  });

  it("sums buy fills for the resolved HYPE spot coin since sinceMs", () => {
    const fills: AfFillLike[] = [
      fill({ time: 1000, sz: "100", px: "25.0" }),  // before window
      fill({ time: 2000, sz: "50",  px: "26.0" }),  // in window
      fill({ time: 3000, sz: "10",  px: "27.0" }),  // in window
    ];
    const m = computeAfMetrics(balances("0"), fills, HYPE_TOKEN_INDEX, SPOT_COIN, 1500);
    expect(m.buyFills).toBe(2);
    expect(m.buyHypeWindow).toBeCloseTo(60, 10);
    expect(m.buyUsdcWindow).toBeCloseTo(50 * 26.0 + 10 * 27.0, 10);
  });

  it("ignores sell-side ('A') fills", () => {
    const fills: AfFillLike[] = [fill({ side: "A", time: 2000 })];
    const m = computeAfMetrics(balances("0"), fills, HYPE_TOKEN_INDEX, SPOT_COIN, 1000);
    expect(m.buyFills).toBe(0);
    expect(m.buyHypeWindow).toBe(0);
  });

  it("ignores fills for a different coin (e.g. the AF buying a non-HYPE token)", () => {
    const fills: AfFillLike[] = [fill({ coin: "@255", time: 2000 })];
    const m = computeAfMetrics(balances("0"), fills, HYPE_TOKEN_INDEX, SPOT_COIN, 1000);
    expect(m.buyFills).toBe(0);
    expect(m.buyHypeWindow).toBe(0);
    expect(m.buyUsdcWindow).toBe(0);
  });

  it("returns zero windowed buys (not null) when no spot coin was resolved", () => {
    const m = computeAfMetrics(balances("0"), [fill({ time: 2000 })], HYPE_TOKEN_INDEX, null, 1000);
    expect(m.buyFills).toBe(0);
    expect(m.buyHypeWindow).toBe(0);
    expect(m.buyUsdcWindow).toBe(0);
  });
});
