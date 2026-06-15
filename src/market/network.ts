// Network resolver for the Market data subsystem — generalized from
// FUNDING_DATA_NETWORK (see funding-matrix.ts). Kept as a separate env var
// so the Market poller's read network can change independently of funding
// data and of config.exchange.network (trading execution).
//
// Default is "mainnet": testnet market data is thin/unreliable (see
// market-spec.md §6), so the Market section always reads mainnet unless
// MARKET_DATA_NETWORK=testnet is explicitly set.

export function getMarketDataNetwork(): "mainnet" | "testnet" {
  const raw = process.env.MARKET_DATA_NETWORK?.trim().toLowerCase();
  if (raw === "testnet") return "testnet";
  return "mainnet";
}

/** Whether the HL InfoClient transport should target testnet for this network. */
export function getMarketDataHlIsTestnet(network: "mainnet" | "testnet"): boolean {
  return network === "testnet";
}
