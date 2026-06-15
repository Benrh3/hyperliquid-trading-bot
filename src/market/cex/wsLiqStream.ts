// Generic reconnecting WS stream for CEX liquidation feeds (market-spec.md §7
// stage 4). Mirrors TradesAggregator's connect/reconnect-with-backoff pattern
// (src/market/tradesAggregator.ts) but is transport-agnostic: venue sources
// supply a `LiqStreamConnector` (real WS for production, injectable mock for
// tests) and a message parser.

import { WebSocket } from "ws";

const MAX_RECONNECT_DELAY_MS = 60_000;

export interface LiqStreamConnection {
  close(): void;
}

/**
 * Opens a connection. `onMessage` is called with each parsed JSON message;
 * `onClose` must be called when the underlying transport drops so the stream
 * can reconnect. Reject the returned promise if the connection could not be
 * established at all.
 */
export type LiqStreamConnector = (
  onMessage: (raw: unknown) => void,
  onClose: () => void,
) => Promise<LiqStreamConnection>;

/** Build a LiqStreamConnector for a plain WS URL, optionally sending a subscribe message on open. */
export function wsConnector(url: string, subscribeMsg?: unknown): LiqStreamConnector {
  return (onMessage, onClose) =>
    new Promise((resolve, reject) => {
      const sock = new WebSocket(url);
      let opened = false;

      sock.on("open", () => {
        opened = true;
        if (subscribeMsg !== undefined) sock.send(JSON.stringify(subscribeMsg));
        resolve({ close: () => sock.close() });
      });
      sock.on("message", (data) => {
        try {
          onMessage(JSON.parse(data.toString()));
        } catch {
          // Ignore malformed frames — never let a bad message kill the stream.
        }
      });
      sock.on("close", () => onClose());
      sock.on("error", (err) => {
        if (!opened) reject(err);
        else onClose();
      });
    });
}

/**
 * Holds a single live connection, reconnecting with exponential backoff on
 * drop or connect failure. Never throws into the caller.
 */
export class ReconnectingLiqStream {
  private connection: LiqStreamConnection | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private stopped = true;

  constructor(
    private readonly label: string,
    private readonly connector: LiqStreamConnector,
    private readonly onMessage: (raw: unknown) => void,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connection?.close();
    this.connection = null;
  }

  async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      this.connection = await this.connector(
        (raw) => {
          try {
            this.onMessage(raw);
          } catch (e) {
            console.warn(`[${this.label}] Failed to process message: ${(e as Error).message}`);
          }
        },
        () => {
          this.connection = null;
          this.scheduleReconnect();
        },
      );
      this.reconnectDelayMs = 1000;
      console.log(`[${this.label}] Liquidation stream connected`);
    } catch (e) {
      console.warn(`[${this.label}] Connect failed (${(e as Error).message}) — retrying in ${this.reconnectDelayMs}ms`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }
}
