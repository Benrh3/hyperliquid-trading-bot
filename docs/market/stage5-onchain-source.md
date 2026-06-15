# Stage 5 on-chain source survey

Findings from probing holder-distribution APIs while building stage 5
(on-chain CEX flows/balance + holder concentration). Covers
`holders_count`, `holder_supply_ex_system`, `holder_top10_share`,
`holder_top50_share`, `holder_top100_share`.

## Holder distribution

- **`https://api.hypurrscan.io/holders/HYPE`** — clean, no-auth JSON:
  `{ token, lastUpdate, holdersCount, holders: { <address>: <balance>, ... } }`.
  Live probe (2026-06-15): `holdersCount: 243766`, full `holders` map present,
  response ~14MB.
- This is the only market-wide holder-balance source found — verdict:
  **implementable**, used for all 5 holder metrics.

### Caveats

- **Response size**: ~14MB and growing with the holder count. The
  `SnapshotPoller` caches the parsed distribution and only refetches every
  `HOLDER_REFRESH_MS` (1h), independent of the main poll interval — matches
  the manifest's `staleAfterMs: 3900000` (65min) for these metrics.
- **Coverage**: the sum of all balances in this endpoint (~142.8M HYPE as of
  the probe) is well below the ~330M `circulating_supply` reported by HL's
  `tokenDetails` (stage 1). This endpoint appears to track HyperEVM-side
  (wrapped HYPE / WHYPE) balances rather than the full HyperCore spot
  ledger — `holder_supply_ex_system` and the topN shares are therefore
  **EVM-side concentration metrics**, not a full-supply breakdown. This is
  consistent with the manifest's framing (`holder_top10_share`: "whale
  ownership") but should be kept in mind if cross-checking against
  `circulating_supply`.
- **System wallets**: the distribution includes the HyperCore<>EVM bridge
  address (`systemWallets` in `config/cex-wallets.json`) and similar
  infrastructure addresses holding large balances. These are excluded from
  both `holder_supply_ex_system` and the topN-share numerator/denominator —
  otherwise the bridge alone would dominate "whale ownership".
