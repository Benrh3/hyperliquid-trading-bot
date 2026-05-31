import {
  CompositeClient,
  Network,
  LocalWallet,
  SubaccountInfo,
  OrderType,
  OrderSide,
  OrderTimeInForce,
  OrderExecution,
  PositionStatus,
} from "@dydxprotocol/v4-client-js";
import type { Venue, VenuePosition, OrderReceipt } from "../venue.js";

const INDEXER_BASE  = "https://indexer.v4testnet.dydx.exchange/v4";
const FETCH_TIMEOUT = 10_000;
const SLIPPAGE      = 0.02;   // 2% slippage cushion on IOC limit price
const BECH32_PREFIX = "dydx"; // Cosmos address prefix for dYdX testnet

/**
 * Convert a Hyperliquid-style coin symbol (e.g. "BTC") into the dYdX
 * perpetual ticker format (e.g. "BTC-USD").  Symbols that already contain
 * a hyphen are returned unchanged.
 */
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

/** Extract a hex tx hash from any broadcast-response shape the SDK may return. */
function extractTxHash(resp: unknown): string {
  if (!resp || typeof resp !== "object") return `dydx-${Date.now()}`;
  const r = resp as Record<string, unknown>;
  // IndexedTx has `transactionHash` (string); BroadcastTxSyncResponse has `hash` (Uint8Array)
  if (typeof r["transactionHash"] === "string") return r["transactionHash"];
  if (r["hash"] instanceof Uint8Array) return Buffer.from(r["hash"]).toString("hex");
  return `dydx-${Date.now()}`;
}

/**
 * dYdX v4 venue.
 *
 * Read methods (getFundingRate, getMarkPrice) always work — they query the
 * public testnet Indexer and require no auth.
 *
 * Trading methods (openPosition, closePosition, getPosition) require a
 * mnemonic, loaded from the DYDX_TESTNET_MNEMONIC environment variable.
 * Pass the mnemonic at construction time; the CompositeClient is
 * initialised lazily on the first trading call.
 */
export class DydxVenue implements Venue {
  readonly name = "dydx";

  private readonly mnemonic:  string | undefined;
  private client:     CompositeClient | null = null;
  private subaccount: SubaccountInfo  | null = null;
  private address     = "";
  private initPromise: Promise<void>  | null = null;

  /**
   * @param mnemonic  BIP-39 mnemonic phrase from DYDX_TESTNET_MNEMONIC.
   *                  Omit (or pass undefined) for read-only use.
   */
  constructor(mnemonic?: string) {
    this.mnemonic = mnemonic;
  }

  // ── Market data (public, no auth) ─────────────────────────────────────────

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

    // nextFundingRate absent during low-activity — fall back to most recent settled rate
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

  async getPosition(coin: string): Promise<VenuePosition | null> {
    if (!this.mnemonic) return null;
    await this.ensureClient();
    const ticker = toDydxTicker(coin);
    type PerpPos = { market: string; side: string; size: string; entryPrice: string };
    type Resp    = { positions?: PerpPos[] };
    const resp   = await this.client!.indexerClient.account.getSubaccountPerpetualPositions(
      this.address, 0, PositionStatus.OPEN,
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

  // ── Trade execution (requires wallet) ────────────────────────────────────

  async openPosition(coin: string, side: "long" | "short", sizeUsd: number): Promise<OrderReceipt> {
    await this.ensureClient();

    const markPrice = await this.getMarkPrice(coin);
    if (!markPrice) throw new Error(`[dydx-venue] No mark price for ${coin}`);

    const ticker    = toDydxTicker(coin);
    const isBuy     = side === "long";
    const baseSize  = parseFloat((sizeUsd / markPrice).toFixed(4)); // 4 dp = 0.0001 BTC min step
    const limitPx   = isBuy
      ? markPrice * (1 + SLIPPAGE)   // willing to pay up to slippage above oracle
      : markPrice * (1 - SLIPPAGE);  // willing to sell down to slippage below oracle
    const clientId  = Math.floor(Math.random() * 1e9);

    console.log(
      `[dydx-venue] OPEN ${side.toUpperCase()} ${baseSize} ${ticker}` +
      ` limitPx=${limitPx.toFixed(2)} clientId=${clientId}`,
    );

    const resp = await this.client!.placeOrder(
      this.subaccount!,
      ticker,
      OrderType.LIMIT,
      isBuy ? OrderSide.BUY : OrderSide.SELL,
      limitPx,
      baseSize,
      clientId,
      OrderTimeInForce.IOC,   // fills immediately or cancels
      undefined,              // goodTilTimeInSeconds — not used for IOC
      OrderExecution.DEFAULT,
      false,   // postOnly
      false,   // reduceOnly
    );

    const orderId = extractTxHash(resp);
    console.log(`[dydx-venue] Open broadcast txHash=${orderId}`);
    return { orderId, fillPrice: markPrice, fillSize: baseSize };
  }

  async closePosition(coin: string): Promise<OrderReceipt> {
    await this.ensureClient();

    const pos = await this.getPosition(coin);
    if (!pos) throw new Error(`[dydx-venue] closePosition: no open position for ${coin}`);

    const ticker    = toDydxTicker(coin);
    const isClosingBuy = pos.side === "short";  // buy to close short, sell to close long
    const markPrice = pos.markPrice || ((await this.getMarkPrice(coin)) ?? 0);
    if (markPrice === 0) throw new Error(`[dydx-venue] No mark price for ${coin}`);

    const limitPx  = isClosingBuy
      ? markPrice * (1 + SLIPPAGE)
      : markPrice * (1 - SLIPPAGE);
    const clientId = Math.floor(Math.random() * 1e9);

    console.log(
      `[dydx-venue] CLOSE ${pos.side.toUpperCase()} ${pos.size} ${ticker}` +
      ` limitPx=${limitPx.toFixed(2)} clientId=${clientId}`,
    );

    const resp = await this.client!.placeOrder(
      this.subaccount!,
      ticker,
      OrderType.LIMIT,
      isClosingBuy ? OrderSide.BUY : OrderSide.SELL,
      limitPx,
      pos.size,
      clientId,
      OrderTimeInForce.IOC,
      undefined,
      OrderExecution.DEFAULT,
      false,  // postOnly
      true,   // reduceOnly — never accidentally opens a new position
    );

    const orderId = extractTxHash(resp);
    const pnl = pos.side === "long"
      ? (markPrice - pos.entryPrice) * pos.size
      : (pos.entryPrice - markPrice) * pos.size;
    console.log(`[dydx-venue] Close broadcast txHash=${orderId} est. PnL=${pnl.toFixed(4)}`);
    return { orderId, fillPrice: markPrice, fillSize: pos.size, pnl };
  }

  // ── Wallet address (for display) ──────────────────────────────────────────

  get walletAddress(): string { return this.address; }

  // ── Private: lazy client initialisation ──────────────────────────────────

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
    try {
      const wallet      = await LocalWallet.fromMnemonic(this.mnemonic!, BECH32_PREFIX);
      this.client       = await CompositeClient.connect(Network.testnet());
      this.subaccount   = SubaccountInfo.forLocalWallet(wallet);
      this.address      = wallet.address!;
      console.log(`[dydx-venue] Wallet ${this.address} connected (testnet)`);
    } catch (e) {
      this.initPromise = null; // allow retry
      throw new Error(`[dydx-venue] Failed to connect: ${(e as Error).message}`);
    }
  }
}
