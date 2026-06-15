// Pure aggregation helpers for cex-flow/balance + holder concentration
// (market-spec.md §7 stage 5). No I/O — independently unit-testable.

import type { HolderDistribution, HolderMetrics } from "./types.js";

export interface WalletRead {
  address: string;
  /** null = the read failed (network/parse error) — excluded from the aggregate and the polled count. */
  balance: number | null;
}

export interface BalanceAggregate {
  /** Sum of successful reads, or null if no wallet was successfully read. */
  total: number | null;
  /** Count of successful reads (0 if the wallet list is empty or every read failed). */
  walletsPolled: number;
  /** address -> balance, successful reads only. */
  perWallet: Map<string, number>;
}

/** cex_total_balance_hype / cex_wallets_polled — sum + count of successful reads only. Never zero-fakes an empty/all-failed list. */
export function aggregateBalances(reads: WalletRead[]): BalanceAggregate {
  const perWallet = new Map<string, number>();
  let total = 0;
  for (const r of reads) {
    if (r.balance === null) continue;
    total += r.balance;
    perWallet.set(r.address, r.balance);
  }
  return { total: perWallet.size > 0 ? total : null, walletsPolled: perWallet.size, perWallet };
}

export interface FlowResult {
  netFlow: number | null;
  inflow: number | null;
  outflow: number | null;
}

/**
 * cex_net_flow_hype / cex_inflow_hype / cex_outflow_hype — signed per-wallet
 * deltas vs the previous poll's balances. Null on cold start (no previous
 * balances yet) or if no wallet has both a current and a previous reading.
 */
export function computeFlows(current: Map<string, number>, previous: Map<string, number> | null): FlowResult {
  if (previous === null || previous.size === 0) return { netFlow: null, inflow: null, outflow: null };

  let inflow = 0;
  let outflow = 0;
  let net = 0;
  let any = false;
  for (const [address, curBal] of current) {
    const prevBal = previous.get(address);
    if (prevBal === undefined) continue;
    const delta = curBal - prevBal;
    net += delta;
    if (delta > 0) inflow += delta;
    else if (delta < 0) outflow += -delta;
    any = true;
  }
  if (!any) return { netFlow: null, inflow: null, outflow: null };
  return { netFlow: net, inflow, outflow };
}

/**
 * holders_count / holder_supply_ex_system / holder_topN_share. System
 * wallets (e.g. the HyperCore<>EVM bridge) are excluded from both the
 * topN-share numerator and the ex-system supply denominator.
 */
export function computeHolderMetrics(dist: HolderDistribution, systemAddresses: Set<string>): HolderMetrics {
  let totalSupply = 0;
  const nonSystem: number[] = [];
  for (const [address, balance] of dist.balances) {
    totalSupply += balance;
    if (!systemAddresses.has(address.toLowerCase())) nonSystem.push(balance);
  }
  nonSystem.sort((a, b) => b - a);

  const systemSupply = totalSupply - nonSystem.reduce((a, b) => a + b, 0);
  const supplyExSystem = totalSupply - systemSupply;

  const shareOfTop = (n: number): number | null =>
    supplyExSystem > 0 ? nonSystem.slice(0, n).reduce((a, b) => a + b, 0) / supplyExSystem : null;

  return {
    holdersCount: dist.holdersCount,
    supplyExSystem,
    top10Share: shareOfTop(10),
    top50Share: shareOfTop(50),
    top100Share: shareOfTop(100),
  };
}
