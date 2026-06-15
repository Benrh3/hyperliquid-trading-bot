// OKX perpetual-swap adapter for cex-agg (market-spec.md §7 stage 4).
//
// OKX's "rubik" stats endpoints (long/short ratios, taker volume) only cover
// a subset of instruments — each is probed independently and nulls out (with
// a one-time warning) if HYPE isn't covered, rather than failing the whole
// venue.

import type { CexDerivsSource, CexLiqEvent, LongShortRatios } from "./types.js";
import { normalizeOi } from "./types.js";
import { ReconnectingLiqStream, wsConnector, type LiqStreamConnector } from "./wsLiqStream.js";
import { parseOkxLiquidationOrders } from "./parsers.js";

const REST_BASE = "https://www.okx.com";

export class OkxSource implements CexDerivsSource {
  readonly name = "okx";

  private instId: string | null = null;
  private ctVal = 1;
  private available = false;
  private warnedUnreachable = false;
  private readonly warnedUnsupported = new Set<string>();
  private stream: ReconnectingLiqStream | null = null;

  private readonly fetchFn: typeof fetch;
  private readonly connectorFactory: (instId: string, instFamily: string) => LiqStreamConnector;

  constructor(opts: { fetchFn?: typeof fetch; connectorFactory?: (instId: string, instFamily: string) => LiqStreamConnector } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.connectorFactory = opts.connectorFactory
      ?? ((_instId, instFamily) => wsConnector("wss://ws.okx.com:8443/ws/v5/business", {
        op: "subscribe",
        args: [{ channel: "liquidation-orders", instType: "SWAP", instFamily }],
      }));
  }

  async resolveSymbol(coin: string): Promise<boolean> {
    const candidate = `${coin}-USDT-SWAP`;
    try {
      const res = await this.fetchFn(`${REST_BASE}/api/v5/public/instruments?instType=SWAP&instId=${candidate}`);
      if (!res.ok) {
        this.warnUnreachable(`HTTP ${res.status}`);
        return false;
      }
      const data = (await res.json()) as { code?: string; data?: { instId?: string; ctVal?: string; instFamily?: string }[] };
      const inst = data.data?.[0];
      if (data.code !== "0" || !inst || inst.instId !== candidate) {
        this.warnUnreachable(`${candidate} not listed`);
        return false;
      }
      this.instId = inst.instId;
      this.ctVal = Number(inst.ctVal) || 1;
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
    if (!this.instId) return null;
    try {
      const res = await this.fetchFn(`${REST_BASE}/api/v5/public/open-interest?instId=${this.instId}`);
      if (!res.ok) {
        this.warnUnreachable(`HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { code?: string; data?: { oiCcy?: string }[] };
      const raw = data.data?.[0]?.oiCcy;
      if (data.code !== "0" || raw === undefined) return null;
      return normalizeOi(Number(raw), "coins", null);
    } catch (e) {
      this.warnUnreachable((e as Error).message);
      return null;
    }
  }

  async fetchLongShortRatios(): Promise<LongShortRatios> {
    if (!this.instId) return { accountRatio: null, topPositionRatio: null, takerRatio: null };
    const [accountRatio, topPositionRatio, takerRatio] = await Promise.all([
      this.fetchLatestSeriesValue("long-short-account-ratio-contract", "accountRatio"),
      this.fetchLatestSeriesValue("long-short-account-ratio-contract-top-trader", "topPositionRatio"),
      this.fetchTakerRatio(),
    ]);
    return { accountRatio, topPositionRatio, takerRatio };
  }

  startLiquidationStream(onLiq: (event: CexLiqEvent) => void): void {
    if (!this.instId || this.stream) return;
    const instFamily = this.instId.replace("-SWAP", "");
    const connector = this.connectorFactory(this.instId, instFamily);
    this.stream = new ReconnectingLiqStream("cex-okx", connector, (raw) => {
      for (const event of parseOkxLiquidationOrders(raw, this.instId!, this.ctVal)) onLiq(event);
    });
    this.stream.start();
  }

  stopLiquidationStream(): void {
    this.stream?.stop();
    this.stream = null;
  }

  /** `/rubik/stat/contracts/<path>` — single [ts, value] series, value at index 1. Null + warn-once if unsupported. */
  private async fetchLatestSeriesValue(path: string, statName: string): Promise<number | null> {
    try {
      const res = await this.fetchFn(`${REST_BASE}/api/v5/rubik/stat/contracts/${path}?instId=${this.instId}&period=5m`);
      if (!res.ok) return null;
      const data = (await res.json()) as { code?: string; data?: [string, string][] };
      const row = data.data?.[0];
      if (data.code !== "0" || !row) {
        this.warnUnsupported(statName);
        return null;
      }
      const v = Number(row[1]);
      return Number.isFinite(v) ? v : null;
    } catch {
      this.warnUnsupported(statName);
      return null;
    }
  }

  /** `/rubik/stat/taker-volume-contract` — [ts, sellVol, buyVol]; ratio = buyVol/sellVol. */
  private async fetchTakerRatio(): Promise<number | null> {
    try {
      const res = await this.fetchFn(`${REST_BASE}/api/v5/rubik/stat/taker-volume-contract?instId=${this.instId}&period=5m`);
      if (!res.ok) return null;
      const data = (await res.json()) as { code?: string; data?: [string, string, string][] };
      const row = data.data?.[0];
      if (data.code !== "0" || !row) {
        this.warnUnsupported("takerRatio");
        return null;
      }
      const sellVol = Number(row[1]);
      const buyVol  = Number(row[2]);
      const ratio = buyVol / sellVol;
      return sellVol !== 0 && Number.isFinite(ratio) ? ratio : null;
    } catch {
      this.warnUnsupported("takerRatio");
      return null;
    }
  }

  private warnUnsupported(statName: string): void {
    if (this.warnedUnsupported.has(statName)) return;
    this.warnedUnsupported.add(statName);
    console.warn(`[cex-okx] ${statName} unsupported for ${this.instId} — will be null`);
  }

  private warnUnreachable(reason: string): void {
    this.available = false;
    if (this.warnedUnreachable) return;
    this.warnedUnreachable = true;
    console.warn(`[cex-okx] Unavailable (${reason}) — OKX metrics will be null`);
  }
}
