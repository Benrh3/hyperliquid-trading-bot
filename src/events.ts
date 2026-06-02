import { EventEmitter } from "events";

// --- Core types used across all modules ---

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  coin?: string; // populated by Feed for multi-coin routing
}

export interface Tick {
  coin: string;
  mid: number;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface Signal {
  side:   "long" | "short" | "close";
  coin:   string;
  reason: string;
  timestamp: number;
  /** true for paper/simulation bots — risk manager and executor must ignore these */
  paper?: boolean;
}

export interface TradeResult {
  orderId:   string;
  coin:      string;
  side:      "long" | "short";
  size:      number;
  price:     number;
  timestamp: number;
  success:   boolean;
  error?:    string;
  pnl?:      number;    // realised PnL — only set on close trades
  reason?:   string;    // e.g. "Stop-loss 2.10%" or signal reason
  strategy?: string;    // strategy id — callers that know it should set this
}

export interface OrderbookLevel {
  price: number;
  size: number;
  total: number; // cumulative size from best level outward
}

export interface OrderbookSnapshot {
  coin: string;
  timestamp: number;
  bids: OrderbookLevel[]; // sorted descending by price (best bid first)
  asks: OrderbookLevel[]; // sorted ascending by price (best ask first)
}

export interface BotEvents {
  candle: [candle: Candle];
  tick: [tick: Tick];
  signal: [signal: Signal];
  "signal:approved": [signal: Signal];
  "signal:rejected": [signal: Signal, reason: string];
  trade: [result: TradeResult];
  orderbook: [snapshot: OrderbookSnapshot];
  error: [module: string, error: Error];
  /**
   * Emitted by the reconciliation loop after each full detectOrphans() cycle.
   * Carries the complete list of positions currently open on the exchange so the
   * RiskManager can rebuild its openRisks map from ground truth and correct any
   * drift caused by missed trade events (process crash, bus event loss, etc.).
   */
  "reconcile:positions": [positions: ReadonlyArray<{ coin: string; size: number; price: number }>];
}

// Typed event bus — all modules import this single instance
class TypedEventBus extends EventEmitter {
  override emit<K extends keyof BotEvents>(
    event: K,
    ...args: BotEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof BotEvents>(
    event: K,
    listener: (...args: BotEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

export const bus = new TypedEventBus();
