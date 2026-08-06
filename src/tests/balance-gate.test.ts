/**
 * Unit tests for the balance-gate safety layer.
 *
 * Tests cover:
 *   checkBalanceGate — pure gate function in position-sizing.ts
 *   assertBalanceGateInvariant — config validator from config.ts
 *
 * No network calls, no DB, no config file dependency.
 */

import { describe, it, expect } from "vitest";
import { checkBalanceGate } from "../position-sizing.js";
import { assertBalanceGateInvariant } from "../config.js";

// ── checkBalanceGate ──────────────────────────────────────────────────────────

describe("checkBalanceGate", () => {
  it("passes when available balance covers required margin", () => {
    // notional=$1000, gate=5× → need $200; $500 available
    const r = checkBalanceGate(500, 1000, 5);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("passes at exactly the margin threshold", () => {
    // notional=$1000, gate=5× → need $200; exactly $200 available
    const r = checkBalanceGate(200, 1000, 5);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("blocks when available is below the required margin", () => {
    // notional=$1000, gate=5× → need $200; only $100 available
    const r = checkBalanceGate(100, 1000, 5);
    expect(r.ok).toBe(false);
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("$200");   // required margin
    expect(r.reason).toContain("$100");   // what's available
    expect(r.reason).toContain("5×");     // gate leverage
  });

  it("fails open (allows) when available is null — no balance data from venue", () => {
    const r = checkBalanceGate(null, 1000, 5);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("respects a higher gate leverage cap", () => {
    // gate=10× → need $100 for $1000 notional
    expect(checkBalanceGate(150, 1000, 10).ok).toBe(true);
    expect(checkBalanceGate(50,  1000, 10).ok).toBe(false);
  });

  it("always passes when notional is zero", () => {
    expect(checkBalanceGate(0, 0, 5).ok).toBe(true);
    expect(checkBalanceGate(100, 0, 5).ok).toBe(true);
  });
});

// ── gate semantics with matching sizer leverage ───────────────────────────────

describe("balanceGateMaxLeverage = maxLeverage semantics", () => {
  // With gateMaxLeverage = maxLeverage = 5 and no existing positions
  // (available ≈ accountEquity), the sizer's full range is reachable.

  it("allows the sizer's maximum output when no positions are open", () => {
    // accountEquity = $1000, sizer produces max $5000 notional at 5×
    // available = $1000 (no open positions) → $5000/5 = $1000 ≤ $1000 → pass
    const r = checkBalanceGate(1000, 5000, 5);
    expect(r.ok).toBe(true);
  });

  it("fires when existing positions consume margin", () => {
    // accountEquity = $1000, but $300 locked in open positions → available = $700
    // sizer still produces $5000 notional; $5000/5 = $1000 > $700 → block
    const r = checkBalanceGate(700, 5000, 5);
    expect(r.ok).toBe(false);
  });

  it("allows smaller orders even when margin is partially committed", () => {
    // available = $700, small order $500 → $500/5 = $100 ≤ $700 → pass
    const r = checkBalanceGate(700, 500, 5);
    expect(r.ok).toBe(true);
  });
});

// ── assertBalanceGateInvariant ────────────────────────────────────────────────

describe("assertBalanceGateInvariant", () => {
  it("does not throw when gate leverage equals max leverage", () => {
    expect(() => assertBalanceGateInvariant(5, 5)).not.toThrow();
  });

  it("does not throw when gate leverage exceeds max leverage", () => {
    expect(() => assertBalanceGateInvariant(10, 5)).not.toThrow();
    expect(() => assertBalanceGateInvariant(5, 1)).not.toThrow();
  });

  it("throws a hard error when gate leverage is below max leverage", () => {
    expect(() => assertBalanceGateInvariant(2, 5)).toThrow(
      /balanceGateMaxLeverage.*2.*<.*maxLeverage.*5/,
    );
  });

  it("throws with a message that names the dead range", () => {
    const err = (() => {
      try { assertBalanceGateInvariant(2, 5); }
      catch (e) { return (e as Error).message; }
      return "";
    })();
    expect(err).toContain("2×–5×");
  });
});
