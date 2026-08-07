import type { HorizonConfig } from "./types.js";

const H = 3_600_000;
const D = 24 * H;

// Each entry is a self-contained parameter set for one swing horizon.
// To add quarterly/6-monthly: add a new entry here with its own windows
// and poll interval; no other code paths change.
export const HORIZONS: Record<string, HorizonConfig> = {
  daily: {
    name:                   "daily",
    candleInterval:         "1h",
    lookbackMs:             7 * D,
    lookbackCandles:        168,
    fundingWindowMs:        7 * D,
    emaFast:                8,
    emaSlow:                21,
    emaSlopeWindow:         8,
    lsrPercentileWindowMs:  30 * D,
    cvdSlopeWindowMs:       48 * H,
    liqSpikeWindowMs:       30 * D,
    conflictThreshold:      0.5,
    verdictThreshold:       0.22,
    pollIntervalMs:         4 * H,
    telegramRateLimitMs:    30 * 60_000,
    forwardWindowMs:        D,
  },
  weekly: {
    name:                   "weekly",
    candleInterval:         "4h",
    lookbackMs:             30 * D,
    lookbackCandles:        180,
    fundingWindowMs:        30 * D,
    emaFast:                13,
    emaSlow:                34,
    emaSlopeWindow:         6,
    lsrPercentileWindowMs:  60 * D,
    cvdSlopeWindowMs:       7 * D,
    liqSpikeWindowMs:       60 * D,
    conflictThreshold:      0.5,
    verdictThreshold:       0.22,
    pollIntervalMs:         12 * H,
    telegramRateLimitMs:    2 * H,
    forwardWindowMs:        7 * D,
  },
  monthly: {
    name:                   "monthly",
    candleInterval:         "1d",
    lookbackMs:             90 * D,
    lookbackCandles:        90,
    fundingWindowMs:        90 * D,
    emaFast:                21,
    emaSlow:                55,
    emaSlopeWindow:         15,
    lsrPercentileWindowMs:  90 * D,
    cvdSlopeWindowMs:       30 * D,
    liqSpikeWindowMs:       90 * D,
    conflictThreshold:      0.5,
    verdictThreshold:       0.22,
    pollIntervalMs:         24 * H,
    telegramRateLimitMs:    8 * H,
    forwardWindowMs:        30 * D,
  },
};

export const HORIZON_ORDER: string[] = ["daily", "weekly", "monthly"];
