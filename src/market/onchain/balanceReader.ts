// Default OnChainBalanceReader: HyperCore spot balances via the HL info API,
// HyperEVM wrapped-HYPE balances via an ERC20 balanceOf RPC call
// (market-spec.md §7 stage 5). Defensive — every read is caught and nulled,
// never thrown.

import type { OnChainBalanceReader } from "./types.js";

const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";

/**
 * Wrapped HYPE (WHYPE) ERC20 on HyperEVM. HYPE itself is the chain's native
 * gas token (like ETH), not an ERC20 — CEX hot wallets on the EVM side hold
 * the wrapped form, which is what balanceOf reads here.
 */
const WHYPE_CONTRACT = "0x5555555555555555555555555555555555555555";
const WHYPE_DECIMALS = 18;

/** `balanceOf(address)` selector. */
const BALANCE_OF_SELECTOR = "0x70a08231";

/** Minimal subset of InfoClient used for HyperCore spot balance reads. */
export interface SpotBalanceInfoClient {
  spotClearinghouseState(params: { user: string }): Promise<{ balances: { coin: string; total: string }[] }>;
}

export class DefaultOnChainBalanceReader implements OnChainBalanceReader {
  constructor(
    private readonly info: SpotBalanceInfoClient,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly rpcUrl: string = HYPEREVM_RPC_URL,
  ) {}

  /** HyperCore spot HYPE balance. A wallet with no HYPE balance entry reads as 0 (a successful read), not null. */
  async readHypercoreBalance(address: string): Promise<number | null> {
    try {
      const { balances } = await this.info.spotClearinghouseState({ user: address });
      const hype = balances.find((b) => b.coin === "HYPE");
      if (!hype) return 0;
      const n = Number(hype.total);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      console.warn(`[on-chain] HyperCore balance read failed for ${address}: ${(e as Error).message}`);
      return null;
    }
  }

  async readHyperevmBalance(address: string): Promise<number | null> {
    try {
      const data = BALANCE_OF_SELECTOR + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: WHYPE_CONTRACT, data }, "latest"] }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: string; error?: unknown };
      if (json.error || typeof json.result !== "string") return null;
      return Number(BigInt(json.result)) / 10 ** WHYPE_DECIMALS;
    } catch (e) {
      console.warn(`[on-chain] HyperEVM balance read failed for ${address}: ${(e as Error).message}`);
      return null;
    }
  }
}
