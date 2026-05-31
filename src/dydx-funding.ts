import { DydxVenue } from "./venues/dydx.js";

const POLL_INTERVAL = 60_000;
const COIN          = "BTC";

export interface DydxFundingState {
  /** Per-hour rate as a decimal (e.g. 0.000050 = 0.005%/hr). null until first successful poll. */
  rate:        number | null;
  lastUpdated: Date   | null;
  /** Non-null when the most recent poll failed. Stale rate is preserved so the UI can still show it. */
  error:       string | null;
}

/**
 * Polls dYdX BTC-USD funding every 60 s via DydxVenue.getFundingRate.
 * Exposes the latest state for the dashboard's cross-exchange comparison panel.
 */
export class DydxFundingPoller {
  private readonly venue = new DydxVenue();
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
      const rate = await this.venue.getFundingRate(COIN);
      if (rate == null) throw new Error("No funding rate in dYdX response");
      this.state = { rate, lastUpdated: new Date(), error: null };
      console.log(`[dydx-funding] BTC-USD ${(rate * 100).toFixed(4)}%/hr`);
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[dydx-funding] Poll failed:", msg);
      this.state = { ...this.state, error: msg };
    }
  }
}
