// Hypurrscan holder-distribution fetcher (market-spec.md §7 stage 5).
//
// See docs/market/stage5-onchain-source.md for the API survey: this is the
// only clean market-wide holder-balance endpoint found. The response is
// ~14MB (243k+ holders as of 2026-06) — callers should cache it (see
// SnapshotPoller's HOLDER_REFRESH_MS) rather than refetch every poll.

import type { HolderDistribution } from "./types.js";

const HOLDERS_URL = "https://api.hypurrscan.io/holders/HYPE";

/** Fetch the current HYPE holder-balance distribution. Null on any network/parse failure — never throws. */
export async function fetchHolderDistribution(fetchFn: typeof fetch = fetch): Promise<HolderDistribution | null> {
  try {
    const res = await fetchFn(HOLDERS_URL);
    if (!res.ok) return null;
    const data = (await res.json()) as { holdersCount?: number; holders?: Record<string, number> };
    if (typeof data.holdersCount !== "number" || !data.holders) return null;

    const balances = new Map<string, number>();
    for (const [address, balance] of Object.entries(data.holders)) {
      if (Number.isFinite(balance)) balances.set(address.toLowerCase(), balance);
    }
    return { holdersCount: data.holdersCount, balances };
  } catch (e) {
    console.warn(`[on-chain] Hypurrscan holder distribution fetch failed: ${(e as Error).message}`);
    return null;
  }
}
