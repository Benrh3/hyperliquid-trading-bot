import type { Candle, Signal } from "../events.js";

/**
 * Base interface for all trading strategies.
 *
 * To create a new strategy:
 * 1. Create a file in src/strategy/
 * 2. Implement this interface
 * 3. Register in src/index.ts
 *
 * The strategy receives candle data and returns a Signal when it
 * wants to open/close a position, or null to do nothing.
 */
export interface Strategy {
  /** Unique name for logging and config */
  name: string;

  /**
   * Called on every new candle. Analyse the data and return a signal
   * if conditions are met, or null to skip.
   */
  onCandle(candle: Candle, history: Candle[]): Signal | null;

  /**
   * Optional: called once when the bot starts.
   * Use for pre-loading indicator buffers, etc.
   */
  init?(history: Candle[]): void;
}
