import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getIndicator, lastValue } from "./indicators.js";
import type { Strategy } from "./base.js";
import type { Candle, Signal } from "../events.js";
import type { StrategyRegistryEntry } from "./registry.js";

const CUSTOM_PATH = resolve(process.cwd(), "config", "custom-strategies.json");

// ── Rule definition ───────────────────────────────────────────────────────────

export type Comparator = ">" | "<" | ">=" | "<=" | "crossAbove" | "crossBelow";

export interface IndicatorRule {
  id:          string;
  indicatorId: string;
  params:      Record<string, number>;
  outputKey:   string;                    // "values" | "signal" | "upper" | etc.
  comparator:  Comparator;
  rhsType:     "value" | "price";
  rhsValue:    number;                    // threshold value
  rhsPriceKey: "close" | "open" | "high" | "low";  // used when rhsType="price"
}

export type LogicMode = "AND" | "OR" | { type: "votes"; required: number };

export interface CustomStrategyDef {
  id:               string;
  name:             string;
  description:      string;
  entryLongRules:   IndicatorRule[];
  entryShortRules:  IndicatorRule[];
  entryLogic:       LogicMode;
  exitRules:        IndicatorRule[];
  exitLogic:        LogicMode;
  stopLoss:         number;
  takeProfit:       number;
  isCustom:         true;
}

// ── Custom strategy executor ──────────────────────────────────────────────────

export class CustomStrategy implements Strategy {
  name: string;
  private def:       CustomStrategyDef;
  private inTrade:   "long" | "short" | null = null;
  private prevValues: Map<string, number>    = new Map(); // ruleId → prev indicator value

  constructor(def: CustomStrategyDef) {
    this.def  = def;
    this.name = def.id;
  }

  getState(): Record<string, unknown> {
    return { name: this.def.name, inTrade: this.inTrade };
  }

  onCandle(candle: Candle, history: Candle[]): Signal | null {
    if (history.length < 35) return null; // need enough data for indicators
    const coin = candle.coin ?? "UNKNOWN";

    // ── Exit check (takes priority) ─────────────────────────────────────
    if (this.inTrade && this.def.exitRules.length > 0) {
      const exitTriggered = this.evalRuleSet(this.def.exitRules, this.def.exitLogic, history);
      if (exitTriggered) {
        const side = this.inTrade;
        this.inTrade = null;
        return { side: "close", coin, reason: `Exit rules triggered (closing ${side})`, timestamp: Date.now() };
      }
    }

    // ── Long entry ──────────────────────────────────────────────────────
    if (!this.inTrade && this.def.entryLongRules.length > 0) {
      if (this.evalRuleSet(this.def.entryLongRules, this.def.entryLogic, history)) {
        this.inTrade = "long";
        return { side: "long", coin, reason: `${this.def.name} long entry`, timestamp: Date.now() };
      }
    }

    // ── Short entry ─────────────────────────────────────────────────────
    if (!this.inTrade && this.def.entryShortRules.length > 0) {
      if (this.evalRuleSet(this.def.entryShortRules, this.def.entryLogic, history)) {
        this.inTrade = "short";
        return { side: "short", coin, reason: `${this.def.name} short entry`, timestamp: Date.now() };
      }
    }

    return null;
  }

  private evalRuleSet(rules: IndicatorRule[], logic: LogicMode, history: Candle[]): boolean {
    const results = rules.map(r => this.evalRule(r, history));
    if (logic === "AND") return results.every(Boolean);
    if (logic === "OR")  return results.some(Boolean);
    if (typeof logic === "object" && logic.type === "votes") {
      return results.filter(Boolean).length >= logic.required;
    }
    return false;
  }

  private evalRule(rule: IndicatorRule, history: Candle[]): boolean {
    const ind = getIndicator(rule.indicatorId);
    if (!ind) return false;

    const result = ind.fn(history, rule.params);
    const series = rule.outputKey === "values"
      ? result.values
      : (result.extra?.[rule.outputKey] ?? result.values);

    const current  = series[series.length - 1];
    const previous = series.length >= 2 ? series[series.length - 2] : NaN;

    if (isNaN(current)) return false;

    const rhs = rule.rhsType === "price"
      ? (history[history.length - 1] as unknown as Record<string, number>)[rule.rhsPriceKey] ?? NaN
      : rule.rhsValue;

    switch (rule.comparator) {
      case ">":           return current > rhs;
      case "<":           return current < rhs;
      case ">=":          return current >= rhs;
      case "<=":          return current <= rhs;
      case "crossAbove":  return !isNaN(previous) && previous <= rhs && current > rhs;
      case "crossBelow":  return !isNaN(previous) && previous >= rhs && current < rhs;
    }
    return false;
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function loadCustomDefs(): CustomStrategyDef[] {
  try {
    if (!existsSync(CUSTOM_PATH)) return [];
    const raw = JSON.parse(readFileSync(CUSTOM_PATH, "utf-8")) as { strategies?: CustomStrategyDef[] };
    return raw.strategies ?? [];
  } catch { return []; }
}

export function saveCustomDef(def: CustomStrategyDef): void {
  const existing = loadCustomDefs().filter(d => d.id !== def.id);
  writeFileSync(CUSTOM_PATH, JSON.stringify({ strategies: [...existing, def] }, null, 2));
}

export function deleteCustomDef(id: string): void {
  const existing = loadCustomDefs().filter(d => d.id !== id);
  writeFileSync(CUSTOM_PATH, JSON.stringify({ strategies: existing }, null, 2));
}

// ── Registry integration ──────────────────────────────────────────────────────

export function customDefToRegistryEntry(def: CustomStrategyDef): StrategyRegistryEntry {
  return {
    id:              def.id,
    displayName:     def.name,
    category:        "mean-reversion",        // generic; UI shows "Custom"
    categoryLabel:   "Custom Strategy",
    summary:         def.description || "User-defined strategy built in the Strategy Builder.",
    howItWorks:      def.description || "Evaluates indicator conditions defined in the Strategy Builder.",
    signals:         [
      ...def.entryLongRules.map(r => `${r.indicatorId} ${r.comparator} ${r.rhsValue}`),
    ],
    whenItWorks:     "Depends on the configured indicator rules.",
    whenItStruggles: "Depends on the configured indicator rules.",
    params:          [],       // custom strategies have no registry-level grid params
    isCandleStrategy: true,
    isCustom:        true,
    factory: () => new CustomStrategy(def),
  };
}
