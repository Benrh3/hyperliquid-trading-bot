// Bybit linear-perp adapter for cex-agg (market-spec.md §7 stage 4).
//
// Bybit doesn't publicly expose a top-trader-position or taker buy/sell
// ratio endpoint for HYPE, so `topPositionRatio`/`takerRatio` are always
// null here (not "unsupported by venue" — just not implemented, since no
// stable public endpoint exists).

import type { CexDerivsSource, CexLiqEvent, LongShortRatios } from "./types.js";
import { normalizeOi } from "./types.js";
import { ReconnectingLiqStream, wsConnector, type LiqStreamConnector } from "./wsLiqStream.js";
import { parseBybitAllLiquidation } from "./parsers.js";

const REST_BASE = "https://api.bybit.com";

export class BybitSource implements CexDerivsSource {
  readonly name = "bybit";

  private symbol: string | null = null;
  private available = false;
  private warnedUnreachable = false;
  private stream: ReconnectingLiqStream | null = null;

  private readonly fetchFn: typeof fetch;
  private readonly connectorFactory: (symbol: string) => LiqStreamConnector;

  constructor(opts: { fetchFn?: typeof fetch; connectorFactory?: (symbol: string) => LiqStreamConnector } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.connectorFactory = opts.connectorFactory
      ?? ((symbol) => wsConnector("wss://stream.bybit.com/v5/public/linear", {
        op: "subscribe",
        args: [`allLiquidation.${symbol}`],
      }));
  }

  async resolveSymbol(coin: string): Promise<boolean> {
    const candidate = `${coin}USDT`;
    try {
      const res = await this.fetchFn(`${REST_BASE}/v5/market/instruments-info?category=linear&symbol=${candidate}`);
      if (!res.ok) {
        this.warnUnreachable(`HTTP ${res.status}`);
        return false;
      }
      const data = (await res.json()) as { result?: { list?: { symbol?: string }[] } };
      if (!data.result?.list?.length || data.result.list[0].symbol !== candidate) {
        this.warnUnreachable(`${candidate} not listed`);
        return false;
      }
      this.symbol = candidate;
      this.available = true;
      return true;
    } catch (e) {
      this.warnUnreachable((e as Error).message);
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  async fetchOpenInterest(): Promise<number | null> {
    if (!this.symbol) return null;
    try {
      const res = await this.fetchFn(
        `${REST_BASE}/v5/market/open-interest?category=linear&symbol=${this.symbol}&intervalTime=5min&limit=1`,
      );
      if (!res.ok) {
        this.warnUnreachable(`HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { result?: { list?: { openInterest?: string }[] } };
      const raw = data.result?.list?.[0]?.openInterest;
      if (raw === undefined) return null;
      return normalizeOi(Number(raw), "coins", null);
    } catch (e) {
      this.warnUnreachable((e as Error).message);
      return null;
    }
  }

  async fetchLongShortRatios(): Promise<LongShortRatios> {
    if (!this.symbol) return { accountRatio: null, topPositionRatio: null, takerRatio: null };
    try {
      const res = await this.fetchFn(
        `${REST_BASE}/v5/market/account-ratio?category=linear&symbol=${this.symbol}&period=5min&limit=1`,
      );
      if (!res.ok) return { accountRatio: null, topPositionRatio: null, takerRatio: null };
      const data = (await res.json()) as { result?: { list?: { buyRatio?: string; sellRatio?: string }[] } };
      const row = data.result?.list?.[0];
      const buy  = row?.buyRatio  !== undefined ? Number(row.buyRatio)  : null;
      const sell = row?.sellRatio !== undefined ? Number(row.sellRatio) : null;
      const accountRatio = buy !== null && sell !== null && sell !== 0 && Number.isFinite(buy / sell)
        ? buy / sell
        : null;
      return { accountRatio, topPositionRatio: null, takerRatio: null };
    } catch {
      return { accountRatio: null, topPositionRatio: null, takerRatio: null };
    }
  }

  startLiquidationStream(onLiq: (event: CexLiqEvent) => void): void {
    if (!this.symbol || this.stream) return;
    const connector = this.connectorFactory(this.symbol);
    this.stream = new ReconnectingLiqStream("cex-bybit", connector, (raw) => {
      for (const event of parseBybitAllLiquidation(raw)) onLiq(event);
    });
    this.stream.start();
  }

  stopLiquidationStream(): void {
    this.stream?.stop();
    this.stream = null;
  }

  private warnUnreachable(reason: string): void {
    this.available = false;
    if (this.warnedUnreachable) return;
    this.warnedUnreachable = true;
    console.warn(`[cex-bybit] Unavailable (${reason}) — Bybit metrics will be null`);
  }
}
