# Market section — design & build spec

Single source of truth for the new **Market** section (a HYPE pressure/signals tracker,
modeled on a reference site, recolored and folded into the existing bot dashboard).
Companion file: `market-metrics.manifest.json` (the metric/signal contract).
Reference data: `reference/snapshots.sample.csv`, `reference/scorecard.sample.csv`.

---

## 0. Non-negotiables (carry into every stage)

- **Observe-only through the data + scoring + UI stages.** Nothing here may be imported by
  or wired into the existing trading path (arb / trend / confluence bots, executor, risk).
  Consumption by bots is a later, separate phase, gated by measured IC.
- **Isolated failure domain.** Collection runs as its own PM2 process. An upstream outage
  or crash here must never affect live bots.
- **Mainnet reads, testnet execution.** All market data reads mainnet via the shared
  market-data-network resolver (generalized from `FUNDING_DATA_NETWORK`).
- **Multi-symbol schema, HYPE-only population for now.** Key everything by symbol; only
  enable HYPE. ETH/BTC later reuse the transferable metrics; `hype-only` metrics
  (`appliesTo` in the manifest) do not apply to them.
- **Config isolation.** New config files gitignored with `.example` templates + first-run
  bootstrap, matching the existing `bots.json` / `lanes.json` pattern.

## 1. Data model

Tall/EAV layout so metrics can be added without migrations and `hype-only` metrics don't
force null columns on other symbols.

- `snapshots(id, symbol, network, captured_at)`  — index `(symbol, captured_at)`
- `snapshot_metrics(snapshot_id, metric_key, value, source, kind, meta_json, captured_at)`
  — index `(metric_key, captured_at)`, `(snapshot_id)`

`source` and `kind` values come from the manifest. `meta_json` holds sublines
(e.g. `{"wallets":21}`, `{"validators":32}`). Enable **WAL mode** so the poller,
dashboard, and bot processes share the DB file without locking.

Every metric carries `captured_at` and a `staleAfterMs` (from the manifest) so a future
bot can refuse to act on a stale value.

## 2. Sources (drive the build order — one stage per source)

| source | how | covers |
|---|---|---|
| `hl-market` | HL info API (single ctx poll) + trades WS | price/mark/oracle, funding, OI, premium, volumes, CVD windows |
| `hl-native` | HL L2 book, staking, validators, unstake queue, assistance fund, TWAP, native liqs | microstructure, supply, AF, scheduled flow, HL liquidations |
| `cex-agg` | aggregator (Coinglass-first) or direct CEX APIs | CEX OI, long/short ratios, CEX liquidations |
| `on-chain` | HyperEVM/HyperCore balances of labeled public CEX wallets + holder distribution | CEX flows/balance, holder concentration |

## 3. Scoring engine (the part that informs bots)

From the reference Signals tab + glossary:

- **IC = Spearman rank correlation** between a signal's value and forward return over each
  horizon in `scoringHorizonsHours` = `[4, 24, 72, 168]` (hours).
- A signal×horizon cell is **scored only when n ≥ 8 samples past the horizon**; otherwise it
  is **"warming"** (display em-dash + `n=0`). Emptiness is honest, not an error.
- Interpretation: `|IC| > 0.1` sustained over large n = real edge; near 0 = noise.
  **Hit rate** (signed direction matched forward move) `> 55%` over large n = tradeable.
- **Contrarian signals** (crowd L/S, CEX inflow, funding, premium) should show a *negative*
  IC if they work.
- **Bias read** = weighted vote of readable signals, weighted by IC where available,
  computed **per holding horizon**. Output: Bullish/Bearish/Neutral + score + bull/bear
  counts + a confidence flag (LOW until signals are IC-proven).
- `scorecard.csv` schema: `signal,horizon_h,n,ic,hit_rate`. `snapshots.csv` is the full row.

**Current reality (from the sample scorecard — keep this honest in the UI):** only
`funding_rate` and `perp_premium` have measured IC (n≈13.3K via price/funding backfill),
both weak and negative; the other 37 signals only started streaming ~2026-06-14 and are
warming. The whole point of running this is to let the scorecard fill in over months
before any signal is trusted for trading.

## 4. Information architecture

Top-level app nav (above everything): **`Bots` · `Market`** (Backtest later). `Market` is
the whole tracker; its landing sub-tab is **Summary** (the bias read) — do NOT name it
"Overview" (the existing cockpit + the reference's first tab already use that and it would
collide).

Market sub-tabs and the metrics each owns (`subtab` field in the manifest):

- **Summary** — bias hero (per holding-horizon selector wired to bot holding periods),
  "market read by category" cards, price chart, headline tiles.
- **Time Machine** — no-lookahead replay: pick a past moment + horizon → bias as-it-stood +
  what price actually did. Dates capped so the holding window has closed. (This + Signals =
  the walk-forward backtest surface; it runs off accumulated snapshot history.)
- **Order Flow** — `orderflow`: CVD windows, TWAP/scheduled flow, AF buys.
- **Leverage** — `leverage`: funding, premium, basis, OI (HL + CEX), L/S ratios, OI delta.
- **Supply** — `supply`: staking, unstake queue/maturing, AF balance, circulating supply.
- **On-chain** — `onchain`: CEX flows/balance, holder concentration, holders.
- **Microstructure** — `microstructure`: book imbalance/spread/depth (perp + spot).
- **Liquidations** — `liquidations`: CEX liqs and HL liqs, shown in **separate blocks**.
- **Signals** — IC table + hit-rate table + a "what each signal means" card grid.
- **Data** — recent-snapshots table + `snapshots.csv` / `scorecard.csv` export.
- **Glossary** — concepts + per-metric plain English (use manifest `label`/`beginnerLabel`/`read`).

Desktop: show the full sub-tab strip. Mobile: collapse to a scroller/dropdown.

## 5. Visual system

- **Accent = blue** (brand/chrome): LIVE dot, active tab underline, chart primary line,
  card highlight borders. Suggested `#38BDF8`; background blue-black `#0A0E14`.
- **Semantic up/down = green/red** (keep — universal in trading, colorblind-safe). Define
  these as separate tokens from accent so they're independently changeable.
- **Signal card** component: uppercase label + ⓘ, big value, optional subline, two pill
  badges — a `kind` badge and a `source` badge (values from manifest).
- **Beginner mode** toggle swaps `label` → `beginnerLabel` everywhere and surfaces `read`
  as inline help; ⓘ tooltips pull from the glossary text. Default off (solo expert user).

## 6. Data caveats (encode these; they affect correctness and any future bot use)

- **Never sum CEX liquidations with HL liquidations.** Different methodologies.
- **Liquidation magnitudes undercount** (CEX APIs throttle ~1/sec; native-HL is a
  reconstructed lower bound). Use direction and spikes, not absolute notional.
- **CEX OI is a separate pool (~1/3 of HL perp OI). Never add CEX OI + HL OI.**
- **L/S ratios count heads, not capital** — laggy and gameable; treat as folklore until
  IC-proven by the scorecard.
- Testnet market data is unreliable (thin volume) → always read mainnet.

## 7. Suggested build sequence (one Claude Code prompt per item)

1. **Foundation + hl-market poll metrics** — schema, store (WAL), metric registry built
   from the manifest, config + bootstrap, market-data-network resolver, dedicated PM2
   process, one read-only verification endpoint. Implement the `hl-market` `level` metrics
   (single ctx poll). (See the stage-1 prompt.)
2. **hl-market WS** — trades-websocket aggregator → CVD windows + trade counts; L2 book →
   microstructure metrics.
3. **hl-native** — staking, validators, unstake queue/maturing, AF balance + buys, TWAP +
   active count, native liquidations.
4. **cex-agg** — CEX OI (per venue + total), L/S ratios, CEX liquidations (aggregator-first
   behind a source-agnostic adapter).
5. **on-chain** — labeled CEX wallet flows + balance, holder count + top-N share.
6. **derived signals + scoring** — deltas/basis/net-TWAP; Spearman IC + hit-rate per
   horizon; bias aggregation + warming logic; CSV exports.
7. **Market UI** — nav, sub-tabs, signal-card component, charts, bias hero, holding-horizon
   selector, Time Machine, Data table, Glossary, blue palette.
8. **(later, separate) Phase 2** — wire only IC-proven signals into bot logic via the
   feature store; bots read normalized features, never raw sources.
