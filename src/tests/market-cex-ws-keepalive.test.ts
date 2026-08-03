/**
 * Tests for wsConnector's app-level keepalive (OKX/Bybit require a periodic
 * ping message or the venue drops the connection as idle — see
 * src/market/cex/wsLiqStream.ts). No live network calls: the `ws` module is
 * mocked with a minimal EventEmitter-like fake socket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];

  // Mirrors the real `ws` library, which exposes OPEN/CONNECTING/etc. as
  // instance-accessible properties too (not just static class members).
  readonly OPEN = FakeSocket.OPEN;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit("close");
  }
}

vi.mock("ws", () => ({ WebSocket: FakeSocket }));

describe("wsConnector keepalive", () => {
  beforeEach(() => {
    FakeSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the keepalive message on the configured interval once open", async () => {
    const { wsConnector } = await import("../market/cex/wsLiqStream.js");
    const connector = wsConnector("wss://example.test", undefined, { intervalMs: 20_000, message: "ping" });

    const connectionPromise = connector(() => {}, () => {});
    const sock = FakeSocket.instances[0];
    sock.emit("open");
    await connectionPromise;

    expect(sock.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sock.sent).toEqual(["ping"]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sock.sent).toEqual(["ping", "ping", "ping"]);
  });

  it("stops sending keepalive pings after the connection closes", async () => {
    const { wsConnector } = await import("../market/cex/wsLiqStream.js");
    const connector = wsConnector("wss://example.test", undefined, { intervalMs: 20_000, message: "ping" });

    const connection = await (async () => {
      const p = connector(() => {}, () => {});
      FakeSocket.instances[0].emit("open");
      return p;
    })();

    const sock = FakeSocket.instances[0];
    connection.close();
    expect(sock.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(100_000);
    expect(sock.sent).toEqual([]);
  });

  it("never sends a keepalive when no config is given (Binance's case)", async () => {
    const { wsConnector } = await import("../market/cex/wsLiqStream.js");
    const connector = wsConnector("wss://example.test");

    const connectionPromise = connector(() => {}, () => {});
    FakeSocket.instances[0].emit("open");
    await connectionPromise;

    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances[0].sent).toEqual([]);
  });
});
