# Stage 3b source survey

Findings from probing the `@nktkas/hyperliquid` `InfoClient` against mainnet
while building stage 3 (hl-native staking + Assistance Fund). Covers the
metrics left stubbed in stage 3: `unstake_queue_hype`,
`unstake_maturing_24h`/`72h`, all `twap_*` (9), and `hl_liq_*` (6).

## Unstake queue (`unstake_queue_hype`, `unstake_maturing_24h`, `unstake_maturing_72h`)

- `delegatorSummary({user})` returns `{ delegated, undelegated, totalPendingWithdrawal, nPendingWithdrawals }` — **per-user only**. No market-wide aggregate.
- `delegations({user})` returns `[{ validator, amount, lockedUntilTimestamp }]` — also per-user, and only covers active delegations (not the unstake queue itself).
- No endpoint returns a global unstake/undelegation queue or its maturity schedule.
- **Verdict**: no usable HL-native source for a market-wide total. Would need either (a) an external indexer (Hypurrscan exposes a staking/unstaking page) or (b) sampling `delegatorSummary` across all known delegator addresses — impractical (unbounded address set, no enumeration endpoint).

## TWAP metrics (`twap_spot_buy_hype`, `twap_spot_sell_hype`, `twap_perp_buy_hype`, `twap_perp_sell_hype`, `twap_spot_buy_full_hype`, `twap_spot_sell_full_hype`, `twap_perp_buy_full_hype`, `twap_perp_sell_full_hype`, `twap_active_count`)

- `twapHistory({user})` returns a user's historical TWAP orders — **per-user only**. Live probe against the AF address returned `[]` (AF has never run a TWAP).
- `twapStates` (WS subscription) returns `{ dex, user, states: [[twapId, TwapStateSchema], ...] }` — also **per-user**, requires a subscription per address.
- No market-wide "active TWAPs" or "TWAP volume" endpoint exists on `InfoClient`.
- **Verdict**: no HL-native market-wide source. `twap_active_count` and the buy/sell volume splits would require either an external indexer or subscribing to `twapStates`/`orderUpdates` for every address (not feasible). Hypurrscan may expose aggregate TWAP activity — worth checking before stage 3b.

## HL-native liquidations (`hl_liq_long_1h`, `hl_liq_short_1h`, `hl_liq_long_24h`, `hl_liq_short_24h`, `hl_liq_net_24h`, `hl_liq_count_24h`)

- `liquidatable()` returns `LiquidatableResponse` (`unknown[]`) — live probe returned `[]`. This appears to represent *current* liquidation candidates (a live risk snapshot), not a historical/windowed feed of liquidation events — not usable for windowed `_1h`/`_24h` metrics even when non-empty.
- `userFills` entries can carry an optional `liquidation: { liquidatedUser, markPx, method }` field, but only show up in the fills of the specific user being queried — there's no global "all liquidations" fills stream via `InfoClient`.
- `orderUpdates` (WS, per-user) can report a `"liquidatedCanceled"` status, again per-user only.
- **Verdict**: no market-wide HL-native liquidation feed found. An external indexer (Hypurrscan has a liquidations feed) is the most practical source for stage 3b.

## Summary

| Metric group | HL-native market-wide source? | Recommended stage 3b approach |
|---|---|---|
| Unstake queue / maturing | No | External indexer (Hypurrscan) |
| TWAP metrics | No | External indexer (Hypurrscan), if available |
| HL-native liquidations | No | External indexer (Hypurrscan) |

All three groups share the same conclusion: the `InfoClient` only exposes
per-user views (`delegatorSummary`, `delegations`, `twapHistory`,
`twapStates`, `userFills`/`orderUpdates`), with no market-wide aggregate or
windowed-history endpoint. Stage 3b will likely need an external indexer
(Hypurrscan) for all of these, rather than the known-address-windowed-fills
pattern that worked for the Assistance Fund in stage 3.
