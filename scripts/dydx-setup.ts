/**
 * scripts/dydx-setup.ts
 *
 * One-off helper: derive the dYdX testnet wallet address from DYDX_TESTNET_MNEMONIC,
 * call the testnet faucet to credit 100 USDC, then confirm the balance via the indexer.
 *
 * Usage:
 *   npm run dydx:setup
 */

import { config as loadDotenv } from "dotenv";
loadDotenv({ override: true });

// ── Constants (mirrors DydxVenue's constants) ─────────────────────────────────
const BECH32_PREFIX   = "dydx";
const FAUCET_URL      = "https://faucet.v4testnet.dydx.exchange";
const INDEXER_BASE    = "https://indexer.v4testnet.dydx.exchange/v4";
const FAUCET_AMOUNT   = 100;   // USDC to request
const POLL_INTERVAL   = 3_000; // ms between balance polls
const POLL_ATTEMPTS   = 10;    // how many times to retry before giving up

// ── 1. Load mnemonic ──────────────────────────────────────────────────────────
const mnemonic = process.env.DYDX_TESTNET_MNEMONIC?.trim();
if (!mnemonic) {
  console.error(
    "\n[dydx-setup] ERROR: DYDX_TESTNET_MNEMONIC is not set.\n" +
    "  Add it to your .env file:\n" +
    "    DYDX_TESTNET_MNEMONIC=word1 word2 ... word24\n" +
    "\n  To generate a fresh testnet wallet, run:\n" +
    "    node -e \"const {Wallet}=require('@ethersproject/wallet'); console.log(Wallet.createRandom().mnemonic.phrase)\"\n",
  );
  process.exit(1);
}

// ── 2. Derive address ─────────────────────────────────────────────────────────
console.log("\n[dydx-setup] Loading dYdX SDK…");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk = await import("@dydxprotocol/v4-client-js") as Record<string, any>;

const wallet     = await sdk["LocalWallet"].fromMnemonic(mnemonic, BECH32_PREFIX);
const address: string = wallet.address;
const subaccount = sdk["SubaccountInfo"].forLocalWallet(wallet);

console.log(`\n[dydx-setup] Wallet derived`);
console.log(`             Address:      ${address}`);
console.log(`             Subaccount:   ${subaccount.subaccountNumber ?? 0}`);
console.log(`             Network:      dYdX testnet (chain dydx-testnet-4)`);

// ── 3. Check existing USDC balance before the faucet call ────────────────────
async function fetchUsdcBalance(addr: string): Promise<number | null> {
  try {
    const url  = `${INDEXER_BASE}/subaccounts/${encodeURIComponent(addr)}/0`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await resp.json() as any;
    // The indexer returns equity in USDC under subaccount.equity (string)
    const equity = parseFloat(data?.subaccount?.equity ?? "0");
    return Number.isFinite(equity) ? equity : null;
  } catch {
    return null;
  }
}

const balanceBefore = await fetchUsdcBalance(address);
console.log(
  `\n[dydx-setup] Current balance: ${balanceBefore !== null ? `$${balanceBefore.toFixed(2)} USDC` : "(account not yet on-chain)"}`,
);

// ── 4. Call the faucet ────────────────────────────────────────────────────────
console.log(`\n[dydx-setup] Requesting $${FAUCET_AMOUNT} USDC from testnet faucet…`);
console.log(`             Faucet: ${FAUCET_URL}`);

try {
  const faucetResp = await fetch(`${FAUCET_URL}/faucet/tokens`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body:    JSON.stringify({ address, subaccountNumber: 0, amount: FAUCET_AMOUNT }),
    signal:  AbortSignal.timeout(20_000),
  });

  if (faucetResp.ok) {
    const body = await faucetResp.json().catch(() => ({}));
    console.log(`[dydx-setup] Faucet response ${faucetResp.status}: ${JSON.stringify(body)}`);
  } else {
    const text = await faucetResp.text().catch(() => faucetResp.statusText);
    console.warn(`[dydx-setup] Faucet returned ${faucetResp.status}: ${text}`);
    // Non-200 from the faucet often just means "rate limited" — continue polling anyway
  }
} catch (e) {
  console.warn(`[dydx-setup] Faucet request failed: ${(e as Error).message}`);
  console.warn(`[dydx-setup] Continuing — will poll balance anyway in case a previous request is pending.`);
}

// ── 5. Poll balance until it increases ───────────────────────────────────────
console.log(`\n[dydx-setup] Polling indexer for balance update…`);

let confirmed = false;
for (let i = 1; i <= POLL_ATTEMPTS; i++) {
  await new Promise<void>((res) => setTimeout(res, POLL_INTERVAL));
  const balance = await fetchUsdcBalance(address);
  const prevStr = balanceBefore !== null ? `$${balanceBefore.toFixed(2)}` : "0";
  const nowStr  = balance !== null ? `$${balance.toFixed(2)}` : "null";
  process.stdout.write(`\r[dydx-setup] Attempt ${i}/${POLL_ATTEMPTS}: balance = ${nowStr} USDC    `);

  if (balance !== null && balance > (balanceBefore ?? 0)) {
    console.log(
      `\n\n[dydx-setup] ✓ Balance confirmed: ${prevStr} → ${nowStr} USDC\n` +
      `\n  Wallet is funded and ready for cross-venue live trading.\n` +
      `  You can now switch bots to LIVE mode via the Bots page.\n`,
    );
    confirmed = true;
    break;
  }
}

if (!confirmed) {
  const final = await fetchUsdcBalance(address);
  console.log(
    `\n\n[dydx-setup] Balance after polling: ${final !== null ? `$${final.toFixed(2)} USDC` : "(still not on-chain)"}\n` +
    `\n  The faucet may be slow or rate-limited. Options:\n` +
    `    • Wait a minute and re-run:  npm run dydx:setup\n` +
    `    • Use the web faucet:        https://v4.testnet.dydx.exchange (Deposit → Faucet)\n` +
    `    • Check the indexer directly: ${INDEXER_BASE}/subaccounts/${address}/0\n`,
  );
}
