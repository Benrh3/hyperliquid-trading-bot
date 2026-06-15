// Loader for docs/market/market-metrics.manifest.json — the contract for the
// Market data subsystem (see market-spec.md). The manifest is the source of
// truth for which metrics exist and their source/kind/appliesTo/staleAfterMs;
// the metric registry (registry.ts) is generated from it.

import { readFileSync } from "fs";
import { join } from "path";

export interface ManifestMetric {
  key: string;
  label: string;
  beginnerLabel?: string;
  source: string;
  kind: string;
  appliesTo: "all" | "hype-only" | string;
  subtab: string;
  derived: boolean;
  signalForScoring: boolean;
  staleAfterMs: number;
  read?: string;
}

export interface MarketMetricsManifest {
  asset: string;
  note?: string;
  snapshotKey: string;
  scoringHorizonsHours: number[];
  sources: Record<string, string>;
  kinds: Record<string, string>;
  counts: { rawColumns: number; derivedSignals: number; scoringSignals: number; total: number };
  metrics: ManifestMetric[];
}

let cached: MarketMetricsManifest | null = null;

/** Load and cache the manifest from docs/market/market-metrics.manifest.json. */
export function loadManifest(): MarketMetricsManifest {
  if (cached) return cached;
  const filepath = join(process.cwd(), "docs", "market", "market-metrics.manifest.json");
  cached = JSON.parse(readFileSync(filepath, "utf-8")) as MarketMetricsManifest;
  return cached;
}
