import { InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import type { MarketStore } from "../market/store.js";
import type { SwingDataSlice, HorizonConfig, Candle, MetricPoint } from "./types.js";

const CANDLE_TF_MS: Record<string, number> = {
  "1h":  3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

function toMetricPoints(raw: { capturedAt: number; value: number | null }[]): MetricPoint[] {
  return raw.map((r) => ({ capturedAt: r.capturedAt, value: r.value }));
}

/**
 * Assembles a SwingDataSlice for a single horizon from the local DB + HL REST API.
 *
 * Market data always reads mainnet (isTestnet: false) — same rule as the rest of
 * the Market subsystem.
 */
export async function buildSwingDataSlice(
  store:  MarketStore,
  cfg:    HorizonConfig,
  symbol: string = "HYPE",
): Promise<SwingDataSlice> {
  const now   = Date.now();
  const since = now - Math.max(cfg.lookbackMs, cfg.fundingWindowMs, cfg.lsrPercentileWindowMs, cfg.liqSpikeWindowMs);

  // Pull all required metric series from DB in parallel
  const [funding, lsr, cvd, liqLong, liqShort, price] = await Promise.all([
    Promise.resolve(toMetricPoints(store.getMetricTimeSeries(symbol, "funding_rate")).filter((p) => p.capturedAt >= since)),
    Promise.resolve(toMetricPoints(store.getMetricTimeSeries(symbol, "lsr_agg_long_frac")).filter((p) => p.capturedAt >= since)),
    Promise.resolve(toMetricPoints(store.getMetricTimeSeries(symbol, "cvd_perp_24h")).filter((p) => p.capturedAt >= since)),
    Promise.resolve(toMetricPoints(store.getMetricTimeSeries(symbol, "cex_liq_long_1h")).filter((p) => p.capturedAt >= since)),
    Promise.resolve(toMetricPoints(store.getMetricTimeSeries(symbol, "cex_liq_short_1h")).filter((p) => p.capturedAt >= since)),
    Promise.resolve(toMetricPoints(store.getMetricTimeSeries(symbol, "perp_mark_px")).filter((p) => p.capturedAt >= since)),
  ]);

  // Fetch candles from HL REST (always mainnet for market data)
  const client       = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
  const barMs        = CANDLE_TF_MS[cfg.candleInterval] ?? 3_600_000;
  const candleStart  = now - cfg.lookbackCandles * barMs - barMs; // +1 bar buffer for EMA warmup

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawCandles = await client.candleSnapshot({ coin: symbol, interval: cfg.candleInterval as any, startTime: candleStart, endTime: now });
  const candles: Candle[] = rawCandles.map((c) => ({
    t: Number(c.t),
    o: parseFloat(String(c.o)),
    h: parseFloat(String(c.h)),
    l: parseFloat(String(c.l)),
    c: parseFloat(String(c.c)),
    v: parseFloat(String(c.v)),
  })).sort((a, b) => a.t - b.t);

  const currentPrice = price.length > 0 ? (price[price.length - 1].value) : null;

  return {
    candles,
    fundingHistory:  funding,
    lsrHistory:      lsr,
    cvdHistory:      cvd,
    liqLongHistory:  liqLong,
    liqShortHistory: liqShort,
    priceHistory:    price,
    currentPrice,
    asOfMs: now,
  };
}
