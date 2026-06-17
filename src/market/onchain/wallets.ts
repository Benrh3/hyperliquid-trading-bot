// Config loader for config/cex-wallets.json (market-spec.md §7 stage 5).
//
// Gitignored + .example + first-run-bootstrap, matching the bots.json /
// snapshot.json pattern. The bootstrapped real file ships with `wallets: []`
// — a safe no-op until real addresses are added.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { CexWalletsConfig } from "./types.js";

export const DEFAULT_CEX_WALLETS_CONFIG: CexWalletsConfig = {
  asset: "HYPE",
  wallets: [],
  systemWallets: [
    { address: "0x2222222222222222222222222222222222222222", label: "HyperCore<>EVM bridge" },
    { address: "0xfefefefefefefefefefefefefefefefefefefefe", label: "Assistance Fund" },
  ],
};

/** First-run bootstrap: write the empty-wallets default if config/cex-wallets.json is absent. Never throws. */
export function bootstrapCexWalletsConfig(path = resolve(process.cwd(), "config", "cex-wallets.json")): void {
  if (existsSync(path)) return;
  try {
    writeFileSync(path, JSON.stringify(DEFAULT_CEX_WALLETS_CONFIG, null, 2) + "\n");
    console.log(`[on-chain] Created ${path} with an empty wallet list (no-op until populated)`);
  } catch (e) {
    console.warn(`[on-chain] Failed to bootstrap ${path}: ${(e as Error).message}`);
  }
}

/** Load config/cex-wallets.json — the empty-wallets default if absent or malformed. Never throws. */
export function loadCexWalletsConfig(path = resolve(process.cwd(), "config", "cex-wallets.json")): CexWalletsConfig {
  if (!existsSync(path)) return DEFAULT_CEX_WALLETS_CONFIG;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CexWalletsConfig>;
    return {
      asset: parsed.asset ?? DEFAULT_CEX_WALLETS_CONFIG.asset,
      wallets: Array.isArray(parsed.wallets) ? parsed.wallets : [],
      systemWallets: Array.isArray(parsed.systemWallets) ? parsed.systemWallets : DEFAULT_CEX_WALLETS_CONFIG.systemWallets,
    };
  } catch (e) {
    console.warn(`[on-chain] Failed to parse ${path}: ${(e as Error).message} — using empty wallet list`);
    return DEFAULT_CEX_WALLETS_CONFIG;
  }
}
