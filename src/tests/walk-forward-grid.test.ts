import { describe, it, expect } from "vitest";
import { generateParamGrid } from "../strategy/param-grid.js";
import { STRATEGY_REGISTRY } from "../strategy/registry.js";

const fundingEntry  = STRATEGY_REGISTRY.find(e => e.id === "funding-extreme")!;
const confluenceEntry = STRATEGY_REGISTRY.find(e => e.id === "confluence")!;

describe("generateParamGrid — FundingExtreme", () => {
  it("produces exactly 9 combos (3×3 tunable grid)", () => {
    const grid = generateParamGrid(fundingEntry.params);
    expect(grid).toHaveLength(9);
  });

  it("entryShortMultiple spans [3, 5, 8]", () => {
    const grid = generateParamGrid(fundingEntry.params);
    const vals = [...new Set(grid.map(c => c.entryShortMultiple))].sort((a, b) => a - b);
    expect(vals).toEqual([3, 5, 8]);
  });

  it("entryLongMultiple spans [1, 2, 3]", () => {
    const grid = generateParamGrid(fundingEntry.params);
    const vals = [...new Set(grid.map(c => c.entryLongMultiple))].sort((a, b) => a - b);
    expect(vals).toEqual([1, 2, 3]);
  });

  it("defaultRate is the registry default in every combo when no sidebar value provided", () => {
    const defaultRate = fundingEntry.params.find(p => p.key === "defaultRate")!.default;
    const grid = generateParamGrid(fundingEntry.params);
    expect(grid.every(c => c.defaultRate === defaultRate)).toBe(true);
  });

  it("defaultRate uses sidebar override when provided, not the registry default", () => {
    const grid = generateParamGrid(fundingEntry.params, 200, { defaultRate: 0.0000250 });
    expect(grid.every(c => c.defaultRate === 0.0000250)).toBe(true);
  });

  it("all fixed params are present in every combo at default values", () => {
    const grid = generateParamGrid(fundingEntry.params);
    for (const combo of grid) {
      expect(combo).toHaveProperty("defaultRate");
      expect(combo).toHaveProperty("exitBand");
      expect(combo).toHaveProperty("maxHoldBars");
      expect(combo).toHaveProperty("stopLossPct");
    }
    const exitBandDefault = fundingEntry.params.find(p => p.key === "exitBand")!.default;
    expect(grid.every(c => c.exitBand === exitBandDefault)).toBe(true);
  });

  it("all 9 combos are distinct", () => {
    const grid = generateParamGrid(fundingEntry.params);
    const keys = grid.map(c => `${c.entryShortMultiple}_${c.entryLongMultiple}`);
    expect(new Set(keys).size).toBe(9);
  });
});

describe("generateParamGrid — Confluence (all tunable)", () => {
  it("all params are swept (no optimizable:false)", () => {
    const grid = generateParamGrid(confluenceEntry.params);
    // minConfluence: 1,2,3,4 (4) × rsiPeriod: 5..30 step2 (14) × overbought: 60..90 step5 (7) × oversold: 10..40 step5 (7)
    // = 4×14×7×7 = 2744, but capped to 200
    expect(grid.length).toBeLessThanOrEqual(200);
    expect(grid.length).toBeGreaterThan(0);
    // Every combo has all 4 param keys
    for (const combo of grid) {
      expect(combo).toHaveProperty("minConfluence");
      expect(combo).toHaveProperty("rsiPeriod");
      expect(combo).toHaveProperty("overbought");
      expect(combo).toHaveProperty("oversold");
    }
  });

  it("no combo has undefined values", () => {
    const grid = generateParamGrid(confluenceEntry.params);
    for (const combo of grid) {
      for (const v of Object.values(combo)) {
        expect(v).not.toBeNaN();
        expect(v).toBeDefined();
      }
    }
  });
});

describe("generateParamGrid — edge cases", () => {
  it("returns [{}] for empty params array", () => {
    const grid = generateParamGrid([]);
    expect(grid).toEqual([{}]);
  });

  it("returns single combo with only fixed param at default", () => {
    const grid = generateParamGrid([
      { key: "rate", label: "Rate", default: 0.0000125, min: 0, max: 1, step: 1, optimizable: false },
    ]);
    expect(grid).toHaveLength(1);
    expect(grid[0].rate).toBe(0.0000125);
  });

  it("returns single combo with only fixed param at sidebar override", () => {
    const grid = generateParamGrid(
      [{ key: "rate", label: "Rate", default: 0.0000125, min: 0, max: 1, step: 1, optimizable: false }],
      200,
      { rate: 0.0000999 },
    );
    expect(grid).toHaveLength(1);
    expect(grid[0].rate).toBe(0.0000999);
  });
});
