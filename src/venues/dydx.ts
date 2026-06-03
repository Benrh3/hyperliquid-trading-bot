// NOTE: no static imports from @dydxprotocol/v4-client-js here.
// The SDK is loaded lazily inside initClient() so a broken ESM resolution in
// the package never crashes the process in paper-only mode.

// Type-only imports are erased at compile time — they generate no runtime
// import statement and therefore cannot trigger ERR_MODULE_NOT_FOUND.
import type { CompositeClient, SubaccountInfo } from "@dydxprotocol/v4-client-js";
import type { Venue, VenuePosition, OrderReceipt } from "../venue.js";

const INDEXER_BASE  = "https://indexer.v4testnet.dydx.exchange/v4";
const FETCH_TIMEOUT = 10_000;
const SLIPPAGE      = 0.02;
const BECH32_PREFIX = "dydx";

function toDydxTicker(coin: string): string {
  const upper = coin.toUpperCase();
  return upper.includes("-") ? upper : `${upper}-USD`;
}

async function indexerGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${INDEXER_BASE}${path}`, {
    headers: { Accept: "application/json" },
    signal:  AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`dYdX indexer HTTP ${resp.status} — ${path}`);
  return resp.json() as Promise<T>;
}

function extractTxHash(resp: unknown): string {
  if (!resp || typeof resp !== "object") return `dydx-${Date.now()}`;
  const r = resp as Record<string, unknown>;
  if (typeof r["transactionHash"] === "string") return r["transactionHash"];
  if (r["hash"] instanceof Uint8Array) return Buffer.from(r["hash"]).toString("hex");
  return `dydx-${Date.now()}`;
}

/**
 * dYdX v4 venue.
 *
 * Read methods (getFundingRate, getMarkPrice) use plain fetch — no SDK, always available.
 *
 * Trading methods require DYDX_TESTNET_MNEMONIC.  The SDK is loaded via a
 * dynamic import the first time a trading call is made; in paper mode the SDK
 * is never loaded, so a broken package installation has no effect.
 */
export class DydxVenue implements Venue {
  readonly name = "dydx";

  private readonly mnemonic: string | undefined;

  // These fields use type-only references (CompositeClient, SubaccountInfo).
  // The 'import type' at the top is erased at runtime — only the initialiser
  // null matters at runtime.
  private client:     CompositeClient | null = null;
  private subaccount: SubaccountInfo  | null = null;
  private address     = "";
  private initPromise: Promise<void>  | null = null;

  // Cached SDK module (populated by initClient, used by trading methods for enums)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sdk: Record<string, any> | null = null;

  constructor(mnemonic?: string) {
    this.mnemonic = mnemonic;
  }

  // ── Market data — plain fetch, no SDK ─────────────────────────────────────

  async getFundingRate(coin: string): Promise<number | null> {
    const ticker = toDydxTicker(coin);
    type Market  = { nextFundingRate?: string };
    type Resp    = { markets?: Record<string, Market> };
    const data   = await indexerGet<Resp>(`/perpetualMarkets?ticker=${encodeURIComponent(ticker)}`);
    const market = data.markets?.[ticker];
    if (!market) return null;

    if (market.nextFundingRate != null && market.nextFundingRate !== "") {
      const rate = parseFloat(market.nextFundingRate);
      if (Number.isFinite(rate)) return rate;
    }

    type HistEntry = { rate?: string };
    type HistResp  = { historicalFunding?: HistEntry[] };
    const hist     = await indexerGet<HistResp>(
      `/historicalFunding/${encodeURIComponent(ticker)}?limit=1`,
    );
    const entry = hist.historicalFunding?.[0];
    if (!entry?.rate) return null;
    const rate = parseFloat(entry.rate);
    return Number.isFinite(rate) ? rate : null;
  }

  async getMarkPrice(coin: string): Promise<number | null> {
    const ticker = toDydxTicker(coin);
    type Market  = { oraclePrice?: string; indexPrice?: string };
    type Resp    = { markets?: Record<string, Market> };
    const data   = await indexerGet<Resp>(`/perpetualMarkets?ticker=${encodeURIComponent(ticker)}`);
    const market = data.markets?.[ticker];
    if (!market) return null;
    const priceStr = market.oraclePrice ?? market.indexPrice;
    if (!priceStr) return null;
    const price = parseFloat(priceStr);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  // ── Position query (requires wallet) ─────────────────────────────────────

  /**
   * Verifies dYdX trading credentials by initialising the signer.
   * Throws "DydxVenue trading requires DYDX_TESTNET_MNEMONIC" if the env var
   * is absent, or a connection error if the chain is unreachable.
   * Calling this in the pre-flight guarantees the mnemonic check happens
   * BEFORE any Hyperliquid order is placed.
   */
  async checkTradingReady(): Promise<void> {
    await this.ensureClient();
  }

  async getAccountEquity(): Promise<number | null> {
    return null; // requires configured subaccount
  }

  async getAllPositions(): Promise<import("../venue.js").VenuePosition[]> {
    return []; // requires configured subaccount
  }

  async getPosition(coin: string): Promise<VenuePosition | null> {
    if (!this.mnemonic) return null;
    await this.ensureClient();
    const ticker = toDydxTicker(coin);
    type PerpPos = { market: string; side: string; size: string; entryPrice: string };
    type Resp    = { positions?: PerpPos[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (this.client as any).indexerClient.account.getSubaccountPerpetualPositions(
      this.address, 0, this.sdk!["PositionStatus"].OPEN,
    ) as Resp;
    const pos = (resp.positions ?? []).find((p) => p.market === ticker);
    if (!pos) return null;
    const side: "long" | "short" = pos.side === "LONG" ? "long" : "short";
    const size       = parseFloat(pos.size);
    const entryPrice = parseFloat(pos.entryPrice);
    const markPrice  = (await this.getMarkPrice(coin)) ?? 0;
    const unrealisedPnl = side === "long"
      ? (markPrice - entryPrice) * size
      : (entryPrice - markPrice) * size;
    return { coin, side, size, entryPrice, markPrice, unrealisedPnl };
  }

  // ── Trade execution (requires wallet + SDK) ───────────────────────────────

  async openPosition(coin: string, side: "long" | "short", sizeUsd: number): Promise<OrderReceipt> {
    await this.ensureClient();

    const markPrice = await this.getMarkPrice(coin);
    if (!markPrice) throw new Error(`[dydx-venue] No mark price for ${coin}`);

    const sdk       = this.sdk!;
    const ticker    = toDydxTicker(coin);
    const isBuy     = side === "long";
    const baseSize  = parseFloat((sizeUsd / markPrice).toFixed(4));
    const limitPx   = isBuy ? markPrice * (1 + SLIPPAGE) : markPrice * (1 - SLIPPAGE);
    const clientId  = Math.floor(Math.random() * 1e9);

    console.log(
      `[dydx-venue] OPEN ${side.toUpperCase()} ${baseSize} ${ticker}` +
      ` limitPx=${limitPx.toFixed(2)} clientId=${clientId}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (this.client as any).placeOrder(
      this.subaccount,
      ticker,
      sdk["OrderType"].LIMIT,
      isBuy ? sdk["OrderSide"].BUY : sdk["OrderSide"].SELL,
      limitPx,
      baseSize,
      clientId,
      sdk["OrderTimeInForce"].IOC,
      undefined,
      sdk["OrderExecution"].DEFAULT,
      false,
      false,
    );

    const orderId = extractTxHash(resp);
    console.log(`[dydx-venue] Open broadcast txHash=${orderId}`);
    return { orderId, fillPrice: markPrice, fillSize: baseSize };
  }

  async closePosition(coin: string): Promise<OrderReceipt> {
    await this.ensureClient();

    const pos = await this.getPosition(coin);
    if (!pos) throw new Error(`[dydx-venue] closePosition: no open position for ${coin}`);

    const sdk        = this.sdk!;
    const ticker     = toDydxTicker(coin);
    const isClosingBuy = pos.side === "short";
    const markPrice  = pos.markPrice || ((await this.getMarkPrice(coin)) ?? 0);
    if (markPrice === 0) throw new Error(`[dydx-venue] No mark price for ${coin}`);

    const limitPx  = isClosingBuy ? markPrice * (1 + SLIPPAGE) : markPrice * (1 - SLIPPAGE);
    const clientId = Math.floor(Math.random() * 1e9);

    console.log(
      `[dydx-venue] CLOSE ${pos.side.toUpperCase()} ${pos.size} ${ticker}` +
      ` limitPx=${limitPx.toFixed(2)} clientId=${clientId}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (this.client as any).placeOrder(
      this.subaccount,
      ticker,
      sdk["OrderType"].LIMIT,
      isClosingBuy ? sdk["OrderSide"].BUY : sdk["OrderSide"].SELL,
      limitPx,
      pos.size,
      clientId,
      sdk["OrderTimeInForce"].IOC,
      undefined,
      sdk["OrderExecution"].DEFAULT,
      false,
      true,  // reduceOnly
    );

    const orderId = extractTxHash(resp);
    const pnl = pos.side === "long"
      ? (markPrice - pos.entryPrice) * pos.size
      : (pos.entryPrice - markPrice) * pos.size;
    console.log(`[dydx-venue] Close broadcast txHash=${orderId} est. PnL=${pnl.toFixed(4)}`);
    return { orderId, fillPrice: markPrice, fillSize: pos.size, pnl };
  }

  get walletAddress(): string { return this.address; }

  // ── Lazy client initialisation ────────────────────────────────────────────

  /** Public so checkTradingReady() (and tests) can call it directly. */
  async ensureClient(): Promise<void> {
    if (this.client) return;
    if (!this.mnemonic) {
      throw new Error(
        "DydxVenue trading requires DYDX_TESTNET_MNEMONIC.\n" +
        "Add it to your .env file:\n  DYDX_TESTNET_MNEMONIC=word1 word2 ... word24",
      );
    }
    if (!this.initPromise) this.initPromise = this.initClient();
    await this.initPromise;
  }

  private async initClient(): Promise<void> {
    // ── Lazy dynamic import ───────────────────────────────────────────────
    // Loaded here (not at module top-level) so a broken ESM path inside the
    // package never crashes the process when no mnemonic is configured.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sdk: Record<string, any>;
    try {
      sdk = await import("@dydxprotocol/v4-client-js") as Record<string, any>;
    } catch (e) {
      this.initPromise = null; // allow a future retry after a package fix
      const msg = (e as Error).message;
      console.error(
        `[dydx-venue] Failed to load @dydxprotocol/v4-client-js: ${msg}\n` +
        `             dYdX trading is unavailable; the bot continues in paper mode.`,
      );
      throw new Error(`[dydx-venue] SDK load failed (${msg}) — trading disabled`);
    }

    // ── Connect wallet and client ─────────────────────────────────────────
    try {
      const wallet      = await sdk["LocalWallet"].fromMnemonic(this.mnemonic!, BECH32_PREFIX);
      this.client       = await sdk["CompositeClient"].connect(sdk["Network"].testnet()) as CompositeClient;
      this.subaccount   = sdk["SubaccountInfo"].forLocalWallet(wallet) as SubaccountInfo;
      this.address      = (wallet as { address: string }).address;
      this.sdk          = sdk; // cache for enum access in trading methods

      // ── Startup confirmation: print address + USDC balance ───────────────
      // This runs on every restart so the operator can confirm the wallet is
      // funded before any live orders are placed.
      console.log(`[dydx-venue] Wallet ${this.address} connected (testnet)`);
      void this.logStartupBalance();
    } catch (e) {
      this.initPromise = null;
      throw new Error(`[dydx-venue] Failed to connect: ${(e as Error).message}`);
    }
  }

  private async logStartupBalance(): Promise<void> {
    try {
      const url  = `${INDEXER_BASE}/subaccounts/${encodeURIComponent(this.address)}/0`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal:  AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        console.warn(`[dydx-venue] Could not fetch balance (HTTP ${resp.status}) — run 'npm run dydx:setup' to fund the wallet`);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data   = await resp.json() as any;
      const equity = parseFloat(data?.subaccount?.equity ?? "0");
      if (!Number.isFinite(equity) || equity === 0) {
        console.warn(
          `[dydx-venue] USDC balance is $0 or account not on-chain. ` +
          `Run 'npm run dydx:setup' to credit test USDC before placing live orders.`,
        );
      } else {
        console.log(`[dydx-venue] Subaccount 0 balance: $${equity.toFixed(2)} USDC — wallet is funded and ready`);
      }
    } catch (e) {
      console.warn(`[dydx-venue] Balance check failed: ${(e as Error).message}`);
    }
  }
}
