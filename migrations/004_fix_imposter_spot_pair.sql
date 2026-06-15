-- ── Fix Stage 1 "imposter HYPE" spot-pair bug ───────────────────────────────
-- Early snapshot-poller builds resolved the HYPE spot pair via array position
-- in spotMeta.universe instead of matching assetCtxs by `coin`, landing on an
-- unrelated spot pair (markPx ~ 0.091, an order of magnitude off the real
-- ~$25-65 HYPE price). spot_mark_px, spot_day_ntl_vlm and circulating_supply
-- for those snapshots are wrong and must be removed so they don't contaminate
-- scoring. Self-limiting: once the bad rows are gone, both DELETEs are no-ops.

DELETE FROM snapshot_metrics
WHERE metric_key IN ('spot_mark_px', 'spot_day_ntl_vlm', 'circulating_supply')
  AND snapshot_id IN (
    SELECT snapshot_id FROM snapshot_metrics
    WHERE metric_key = 'spot_mark_px' AND value IS NOT NULL AND value < 1
  );

DELETE FROM snapshot_metrics_hourly
WHERE metric_key IN ('spot_mark_px', 'spot_day_ntl_vlm', 'circulating_supply')
  AND (symbol, ts_hour) IN (
    SELECT symbol, ts_hour FROM snapshot_metrics_hourly
    WHERE metric_key = 'spot_mark_px' AND avg_value IS NOT NULL AND avg_value < 1
  );
