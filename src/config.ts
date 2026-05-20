import { config as loadEnv } from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";

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
    maxPositionSizeUsd: number;
    maxDailyLossPercent: number;
    maxLeverage: number;
    stopLossPercent: number;
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

// Normalise to array; keep config.exchange.coin as the primary string
export const coins: string[] = Array.isArray(config.exchange.coin)
  ? (config.exchange.coin as string[])
  : [config.exchange.coin as string];

// Ensure config.exchange.coin is always the primary coin string for existing code
if (Array.isArray(config.exchange.coin)) {
  (config.exchange as unknown as { coin: string }).coin = coins[0];
}

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
