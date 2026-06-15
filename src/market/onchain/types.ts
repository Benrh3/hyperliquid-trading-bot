// Shared types for the on-chain CEX-flow + holder-concentration source
// (market-spec.md §7 stage 5).

export interface CexWalletEntry {
  address: string;
  label: string;
  /** "hypercore" — HL spot balance via the info API. "hyperevm" — wrapped-HYPE ERC20 via RPC balanceOf. */
  layer: "hypercore" | "hyperevm";
}

export interface CexSystemWallet {
  address: string;
  label: string;
}

export interface CexWalletsConfig {
  asset: string;
  wallets: CexWalletEntry[];
  /** Excluded from holder_supply_ex_system and the topN-share numerator/denominator (e.g. the HyperCore<>EVM bridge). */
  systemWallets: CexSystemWallet[];
}

/** The Hyperliquid "zero address" sentinel — never a real wallet, always skipped. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Whether `address` is a placeholder/zero address that should never be polled. */
export function isPlaceholderAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS.toLowerCase() || /^0x0+$/i.test(address);
}

/** Per-layer HYPE balance reader for labeled CEX wallets. Implementations must never throw. */
export interface OnChainBalanceReader {
  /** HYPE balance on HyperCore (spot) for `address`, in coin units. Null if the read failed. */
  readHypercoreBalance(address: string): Promise<number | null>;
  /** Wrapped-HYPE balance on HyperEVM for `address`, in coin units (via ERC20 balanceOf). Null if the read failed. */
  readHyperevmBalance(address: string): Promise<number | null>;
}

/** One venue's holder-balance distribution (e.g. from Hypurrscan's HYPE holders endpoint). */
export interface HolderDistribution {
  holdersCount: number;
  /** address (lowercase) -> balance in coin units. */
  balances: Map<string, number>;
}

export interface HolderMetrics {
  holdersCount: number;
  supplyExSystem: number;
  top10Share: number | null;
  top50Share: number | null;
  top100Share: number | null;
}
