const INDEXER_BASE    = "https://indexer.v4testnet.dydx.exchange/v4";
const TICKER          = "BTC-USD";
const POLL_INTERVAL   = 60_000;
const FETCH_TIMEOUT   = 10_000;

export interface DydxFundingState {
  /** Per-hour rate as a decimal (e.g. 0.000050 = 0.005%/hr). null until first successful poll. */
  rate:        number | null;
  lastUpdated: Date   | null;
  /** Non-null when the most recent poll failed. Stale rate is preserved so the UI can still show it. */
  error:       string | null;
}

export class DydxFundingPoller {
  private state: DydxFundingState = { rate: null, lastUpdated: null, error: null };
  private timer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL);
    console.log("[dydx-funding] Polling started (60s interval)");
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getState(): DydxFundingState { return { ...this.state }; }

  private async poll(): Promise<void> {
    try {
      // Primary: nextFundingRate from perpetualMarkets
      const url  = `${INDEXER_BASE}/perpetualMarkets?ticker=${encodeURIComponent(TICKER)}`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal:  AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

      type Market  = { nextFundingRate?: string };
      type MktResp = { markets?: Record<string, Market> };
      const data   = await resp.json() as MktResp;
      const market = data.markets?.[TICKER];
      if (!market) throw new Error(`${TICKER} not in dYdX perpetualMarkets response`);

      let rate: number;

      if (market.nextFundingRate != null && market.nextFundingRate !== "") {
        rate = parseFloat(market.nextFundingRate);
      } else {
        // Fallback: most recently settled rate from historicalFunding
        const histUrl  = `${INDEXER_BASE}/historicalFunding/${encodeURIComponent(TICKER)}?limit=1`;
        const histResp = await fetch(histUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
        if (!histResp.ok) throw new Error(`historicalFunding HTTP ${histResp.status}`);
        type HistEntry = { rate?: string };
        type HistResp  = { historicalFunding?: HistEntry[] };
        const hist     = await histResp.json() as HistResp;
        const entry    = hist.historicalFunding?.[0];
        if (!entry?.rate) throw new Error("No rate in dYdX historicalFunding response");
        rate = parseFloat(entry.rate);
        console.log(`[dydx-funding] ${TICKER} ${(rate * 100).toFixed(4)}%/hr (historical fallback)`);
      }

      if (!Number.isFinite(rate)) throw new Error(`Parsed rate is not finite: ${rate}`);

      this.state = { rate, lastUpdated: new Date(), error: null };
      console.log(`[dydx-funding] ${TICKER} ${(rate * 100).toFixed(4)}%/hr`);
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[dydx-funding] Poll failed:", msg);
      // Keep stale rate so callers can still show last-known value
      this.state = { ...this.state, error: msg };
    }
  }
}
