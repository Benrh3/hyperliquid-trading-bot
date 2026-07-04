/**
 * requiresSignals gate tests.
 *
 * Strategies marked requiresSignals are backtest-only: candles arriving from
 * the live WebSocket feed do not have signal data attached. Deploying such a
 * strategy as a bot (paper or live) would produce a bot that silently never
 * trades — the gate converts that silent failure into an explicit error.
 *
 * Two categories are tested:
 *   - Class-based registry entries (crowd-positioning)
 *   - Builder-generated CustomStrategyDef entries with signal: rules
 */

import { describe, it, expect } from "vitest";
import { STRATEGY_REGISTRY } from "../strategy/registry.js";
import { customDefToRegistryEntry } from "../strategy/custom-strategy.js";
import type { CustomStrategyDef } from "../strategy/custom-strategy.js";

// ── 1. Registry shape ─────────────────────────────────────────────────────────

describe("requiresSignals — registry entries", () => {
  it("crowd-positioning is registered and marked requiresSignals", () => {
    const entry = STRATEGY_REGISTRY.find(e => e.id === "crowd-positioning");
    expect(entry).toBeDefined();
    expect(entry!.requiresSignals).toBe(true);
    expect(entry!.isCandleStrategy).toBe(true);
    expect(entry!.factory).not.toBeNull();
  });

  it("standard candle strategies do NOT have requiresSignals set", () => {
    const standard = ["confluence", "trend-follow"];
    for (const id of standard) {
      const entry = STRATEGY_REGISTRY.find(e => e.id === id);
      expect(entry).toBeDefined();
      // requiresSignals should be absent or explicitly false
      expect(!!entry!.requiresSignals).toBe(false);
    }
  });
});

// ── 2. addBot gate — simulated via the same logic BotManager uses ─────────────
//
// BotManager.addBot() calls getStrategyEntry() then throws if requiresSignals.
// We test that logic directly rather than spinning up a full BotManager
// (which would need HL network access for meta()).

function simulateAddBot(strategyId: string, live: boolean): void {
  const entry = STRATEGY_REGISTRY.find(
    e => e.id === strategyId && e.isCandleStrategy && e.factory !== null,
  );
  if (!entry) throw new Error(`Unknown candle strategy: ${strategyId}`);

  // This is the exact gate from BotManager.addBot (bot-manager.ts)
  if (entry.requiresSignals) {
    throw new Error(
      `Strategy "${entry.displayName}" is backtest-only (requires pre-attached Market Signal data). ` +
      `It cannot be deployed as a live or paper bot — candles received from the WebSocket feed ` +
      `do not have signal values attached. Use the Backtest page instead.`,
    );
  }
  // Would continue to create the bot...
  void live;
}

describe("requiresSignals — addBot gate on class-based strategies", () => {
  it("blocks crowd-positioning in live mode", () => {
    expect(() => simulateAddBot("crowd-positioning", true))
      .toThrow(/backtest-only/);
  });

  it("blocks crowd-positioning in paper mode too (silent no-trade bot)", () => {
    expect(() => simulateAddBot("crowd-positioning", false))
      .toThrow(/backtest-only/);
  });

  it("allows confluence in live mode", () => {
    expect(() => simulateAddBot("confluence", true)).not.toThrow();
  });

  it("allows confluence in paper mode", () => {
    expect(() => simulateAddBot("confluence", false)).not.toThrow();
  });

  it("allows trend-follow in live mode", () => {
    expect(() => simulateAddBot("trend-follow", true)).not.toThrow();
  });
});

// ── 3. Builder strategy gate ───────────────────────────────────────────────────

describe("requiresSignals — addBot gate on Builder strategies", () => {
  function makeBuilderDef(useSignal: boolean): CustomStrategyDef {
    return {
      id: "custom-test", name: "Test", description: "",
      entryLongRules: [{
        id: "r0",
        indicatorId: useSignal ? "signal:lsr_agg_long_frac" : "RSI",
        params: useSignal ? {} : { period: 14 },
        outputKey: "values",
        comparator: "<", rhsType: "value", rhsValue: 30, rhsPriceKey: "close",
      }],
      entryShortRules: [], exitRules: [],
      entryLogic: "AND", exitLogic: "AND",
      stopLoss: 2, takeProfit: 0, isCustom: true,
    };
  }

  it("Builder strategy with signal: rule gets requiresSignals = true", () => {
    const entry = customDefToRegistryEntry(makeBuilderDef(true));
    expect(entry.requiresSignals).toBe(true);
  });

  it("Builder strategy with only OHLCV rules gets requiresSignals = false", () => {
    const entry = customDefToRegistryEntry(makeBuilderDef(false));
    expect(entry.requiresSignals).toBe(false);
  });

  it("addBot gate blocks Builder strategy with signal rule (live)", () => {
    const entry = customDefToRegistryEntry(makeBuilderDef(true));
    // Temporarily register it so simulateAddBot can find it
    STRATEGY_REGISTRY.push(entry);
    try {
      expect(() => simulateAddBot(entry.id, true)).toThrow(/backtest-only/);
    } finally {
      const idx = STRATEGY_REGISTRY.indexOf(entry);
      if (idx >= 0) STRATEGY_REGISTRY.splice(idx, 1);
    }
  });

  it("addBot gate blocks Builder strategy with signal rule (paper)", () => {
    const entry = customDefToRegistryEntry(makeBuilderDef(true));
    STRATEGY_REGISTRY.push(entry);
    try {
      expect(() => simulateAddBot(entry.id, false)).toThrow(/backtest-only/);
    } finally {
      const idx = STRATEGY_REGISTRY.indexOf(entry);
      if (idx >= 0) STRATEGY_REGISTRY.splice(idx, 1);
    }
  });

  it("addBot gate allows Builder strategy with only OHLCV rules (live)", () => {
    const entry = customDefToRegistryEntry(makeBuilderDef(false));
    STRATEGY_REGISTRY.push(entry);
    try {
      expect(() => simulateAddBot(entry.id, true)).not.toThrow();
    } finally {
      const idx = STRATEGY_REGISTRY.indexOf(entry);
      if (idx >= 0) STRATEGY_REGISTRY.splice(idx, 1);
    }
  });
});

// ── 4. Bots page registry filter ──────────────────────────────────────────────
//
// routes.ts filters requiresSignals strategies before sending to bots.ejs.
// Verify the filter logic itself is correct (the route is not easily unit-tested,
// but the predicate is: !e.requiresSignals).

describe("bots page registry filter", () => {
  it("crowd-positioning is excluded from the filtered registry", () => {
    const filtered = STRATEGY_REGISTRY.filter(e => !e.requiresSignals);
    expect(filtered.find(e => e.id === "crowd-positioning")).toBeUndefined();
  });

  it("confluence and trend-follow survive the filter", () => {
    const filtered = STRATEGY_REGISTRY.filter(e => !e.requiresSignals);
    expect(filtered.find(e => e.id === "confluence")).toBeDefined();
    expect(filtered.find(e => e.id === "trend-follow")).toBeDefined();
  });

  it("cross-venue-funding-basis survives the filter (not signal-requiring)", () => {
    const filtered = STRATEGY_REGISTRY.filter(e => !e.requiresSignals);
    expect(filtered.find(e => e.id === "cross-venue-funding-basis")).toBeDefined();
  });
});
