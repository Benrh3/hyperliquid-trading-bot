import { EventEmitter } from "events";

// --- Core types used across all modules ---

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  coin: string;
  mid: number;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface Signal {
  side: "long" | "short";
  coin: string;
  reason: string;
  timestamp: number;
}

export interface TradeResult {
  orderId: string;
  coin: string;
  side: "long" | "short";
  size: number;
  price: number;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface BotEvents {
  candle: [candle: Candle];
  tick: [tick: Tick];
  signal: [signal: Signal];
  "signal:approved": [signal: Signal];
  "signal:rejected": [signal: Signal, reason: string];
  trade: [result: TradeResult];
  error: [module: string, error: Error];
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
