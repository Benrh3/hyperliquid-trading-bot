// Binance USDⓜ-Futures adapter for cex-agg (market-spec.md §7 stage 4).
//
// Binance is geo-restricted in some regions — if the VPS's IP is blocked,
// every REST call here fails (HTTP 451 or a network error). resolveSymbol()
// then returns false, isAvailable() stays false, and every Binance metric
// nulls out gracefully (warned once, never thrown).

import type { CexDerivsSource, CexLiqEvent, LongShortRatios } from "./types.js";
import { normalizeOi } from "./types.js";
import { ReconnectingLiqStream, wsConnector, type LiqStreamConnector } from "./wsLiqStream.js";
import { parseBinanceForceOrder } from "./parsers.js";

const REST_BASE = "https://fapi.binance.com";

export class BinanceSource implements CexDerivsSource {
  readonly name = "binance";

  private symbol: string | null = null;
  private available = false;
  private warnedUnreachable = false;
  private stream: ReconnectingLiqStream | null = null;

  private readonly fetchFn: typeof fetch;
  private readonly connectorFactory: (symbol: string) => LiqStreamConnector;

  constructor(opts: { fetchFn?: typeof fetch; connectorFactory?: (symbol: string) => LiqStreamConnector } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.connectorFactory = opts.connectorFactory
      ?? ((symbol) => wsConnector(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@forceOrder`));
  }

  async resolveSymbol(coin: string): Promise<boolean> {
    const candidate = `${coin}USDT`;
    try {
      const res = await this.fetchFn(`${REST_BASE}/fapi/v1/openInterest?symbol=${candidate}`);
      if (!res.ok) {
        this.warnUnreachable(`HTTP ${res.status}`);
        return false;
      }
      const data = (await res.json()) as { symbol?: string };
      if (data.symbol !== candidate) {
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
      const res = await this.fetchFn(`${REST_BASE}/fapi/v1/openInterest?symbol=${this.symbol}`);
      if (!res.ok) {
        this.warnUnreachable(`HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { openInterest: string };
      return normalizeOi(Number(data.openInterest), "coins", null);
    } catch (e) {
      this.warnUnreachable((e as Error).message);
      return null;
    }
  }

  async fetchLongShortRatios(): Promise<LongShortRatios> {
    if (!this.symbol) return { accountRatio: null, topPositionRatio: null, takerRatio: null };
    const [accountRatio, topPositionRatio, takerRatio] = await Promise.all([
      this.fetchRatioField("globalLongShortAccountRatio", "longShortRatio"),
      this.fetchRatioField("topLongShortPositionRatio", "longShortRatio"),
      this.fetchRatioField("takerlongshortRatio", "buySellRatio"),
    ]);
    return { accountRatio, topPositionRatio, takerRatio };
  }

  startLiquidationStream(onLiq: (event: CexLiqEvent) => void): void {
    if (!this.symbol || this.stream) return;
    const connector = this.connectorFactory(this.symbol);
    this.stream = new ReconnectingLiqStream("cex-binance", connector, (raw) => {
      const event = parseBinanceForceOrder(raw);
      if (event) onLiq(event);
    });
    this.stream.start();
  }

  stopLiquidationStream(): void {
    this.stream?.stop();
    this.stream = null;
  }

  private async fetchRatioField(path: string, field: string): Promise<number | null> {
    try {
      const res = await this.fetchFn(`${REST_BASE}/futures/data/${path}?symbol=${this.symbol}&period=5m&limit=1`);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, string>[];
      const v = data[0]?.[field];
      const n = v !== undefined ? Number(v) : null;
      return n !== null && Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  private warnUnreachable(reason: string): void {
    this.available = false;
    if (this.warnedUnreachable) return;
    this.warnedUnreachable = true;
    console.warn(`[cex-binance] Unavailable (${reason}) — Binance metrics will be null`);
  }
}
