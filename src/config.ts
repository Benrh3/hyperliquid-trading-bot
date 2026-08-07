import { config as loadEnv } from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";

// No `override` — PM2 env vars (HL_NETWORK, DASHBOARD_PORT) must not be
// overwritten by .env values. Secrets absent from PM2 env (HL_PRIVATE_KEY,
// ADMIN_PASSWORD_HASH, SESSION_SECRET) are still set by dotenv correctly.
loadEnv();

export interface BotConfig {
  exchange: {
    network: "testnet" | "mainnet";
    coin: string | string[];
    leverage: number;
  };
  strategy: {
    type: string;
    interval: string;
    minConfluence?: number;
    [key: string]: unknown;
  };
  risk: {
    /** % of account equity at risk per trade (if stop-loss fires). Default 2.0. */
    riskPerTradePercent:           number;
    /** Maximum total open risk across all live bots as % of equity. Default 10.0. */
    maxConcurrentRiskPercent:      number;
    maxDailyLossPercent:           number;
    maxLeverage:                   number;
    /**
     * Hard balance gate: abstain from opening if available (withdrawable) balance
     * cannot support the order at this leverage cap.  Must be ≥ maxLeverage —
     * a lower value silently makes the sizer's upper range unreachable.
     * Default 5 (matches maxLeverage). Validated at startup.
     */
    balanceGateMaxLeverage:        number;
    stopLossPercent:               number;
    /**
     * If an orphaned position's unrealised loss exceeds this % of its notional,
     * the reconcile loop closes it immediately rather than waiting for the 24-hour
     * grace period. Protects against flash crashes when no bot is managing the position.
     * Default 5.0 (5%).
     */
    orphanEmergencyCloseLossPct:   number;
    // maxPositionSizeUsd: REMOVED — dangerous fixed-dollar shape, ignored on load
  };
  dashboard: {
    port: number;
  };
}

function loadJsonConfig(filename: string): Partial<BotConfig> {
  try {
    const filepath = join(process.cwd(), "config", filename);
    return JSON.parse(readFileSync(filepath, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const result = { ...base };
  for (const key in override) {
    const val = override[key];
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object"
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      ) as T[Extract<keyof T, string>];
    } else if (val !== undefined) {
      result[key] = val as T[Extract<keyof T, string>];
    }
  }
  return result;
}

// Load default config, then overlay network-specific config
const defaults = loadJsonConfig("default.json") as BotConfig;
const network = process.env.HL_NETWORK ?? defaults?.exchange?.network ?? "testnet";
const networkOverrides = loadJsonConfig(`${network}.json`);

export const config = deepMerge(
  defaults as unknown as Record<string, unknown>,
  networkOverrides as Record<string, unknown>,
) as unknown as BotConfig;

// HL_NETWORK is the authority for the runtime network. deepMerge(default.json, ...)
// leaves config.exchange.network as "testnet" when no network-specific overlay exists,
// regardless of what HL_NETWORK says. Pin it explicitly so every consumer of
// config.exchange.network (isTestnet, startup assertion, nav badge) sees the real value.
config.exchange.network = network as BotConfig["exchange"]["network"];

// Normalise to array; keep config.exchange.coin as the primary string
export const coins: string[] = Array.isArray(config.exchange.coin)
  ? (config.exchange.coin as string[])
  : [config.exchange.coin as string];

// Ensure config.exchange.coin is always the primary coin string for existing code
if (Array.isArray(config.exchange.coin)) {
  (config.exchange as unknown as { coin: string }).coin = coins[0];
}

// Migration: warn if old fixed-dollar sizing field is present; it is ignored
if ((config.risk as Record<string, unknown>)["maxPositionSizeUsd"] !== undefined) {
  console.log(
    "[config] Deprecated: risk.maxPositionSizeUsd is no longer used. " +
    "Position sizing now derives from riskPerTradePercent (default 2%) — see config/default.json.",
  );
}

/**
 * Assert that the balance gate cannot make the sizer's upper range unreachable.
 * Exported so tests can call it with arbitrary values without triggering a full
 * module-level config load.
 */
export function assertBalanceGateInvariant(
  balanceGateMaxLeverage: number,
  maxLeverage: number,
): void {
  if (balanceGateMaxLeverage < maxLeverage) {
    throw new Error(
      `[config] FATAL: risk.balanceGateMaxLeverage (${balanceGateMaxLeverage}) < risk.maxLeverage (${maxLeverage}). ` +
      `A gate set below the sizer cap silently blocks all positions in the ` +
      `${balanceGateMaxLeverage}×–${maxLeverage}× range. ` +
      `Set balanceGateMaxLeverage >= ${maxLeverage} in config/default.json and restart.`,
    );
  }
}

// Hard fail at startup — misconfiguration here silently re-introduces the dead-sizer-range bug
assertBalanceGateInvariant(config.risk.balanceGateMaxLeverage, config.risk.maxLeverage);

// Validate critical env vars
export function getPrivateKey(): `0x${string}` {
  const key = process.env.HL_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "HL_PRIVATE_KEY not set. Copy .env.example to .env and add your key.",
    );
  }
  if (!key.startsWith("0x")) {
    throw new Error("HL_PRIVATE_KEY must start with 0x");
  }
  return key as `0x${string}`;
}

/** Returns true only when HL_PRIVATE_KEY looks like a real 32-byte hex key. */
export function hasValidPrivateKey(): boolean {
  const key = process.env.HL_PRIVATE_KEY;
  return typeof key === "string" && /^0x[0-9a-fA-F]{64}$/.test(key);
}

export const API_URL =
  network === "mainnet"
    ? "https://api.hyperliquid.xyz"
    : "https://api.hyperliquid-testnet.xyz";
