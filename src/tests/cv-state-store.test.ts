import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { CvStateStore, type CvPersistedState } from "../cv-state-store.js";

function makeStore(): { db: Database.Database; store: CvStateStore } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const store = new CvStateStore(db);
  return { db, store };
}

function makeSampleState(overrides: Partial<CvPersistedState> = {}): CvPersistedState {
  return {
    botId:           "cv-test-1",
    capturedFunding: 12.5,
    totalFees:       1.2,
    equity:          1011.3,
    periods:         48,
    flipCount:       3,
    startedAt:       Date.now() - 86400000 * 7,
    totalLegHoldMs:  120000,
    lastBucket:      Math.floor(Date.now() / 3600000),
    lastFlipAt:      Date.now() - 7200000,
    positioned:      true,
    shortVenue:      "hyperliquid",
    longVenue:       "dydx",
    executionMode:   "paper",
    notional:        1000,
    dailyStartEq:    1008,
    hourlyAccruals:  [{ bucket: 100, earned: 0.5 }, { bucket: 101, earned: -0.1 }],
    ...overrides,
  };
}

describe("CvStateStore", () => {
  let db: Database.Database;
  let store: CvStateStore;

  beforeEach(() => {
    ({ db, store } = makeStore());
  });
  afterEach(() => {
    db.close();
  });

  it("returns null for a non-existent bot", () => {
    expect(store.load("cv-nonexistent")).toBeNull();
  });

  it("saves and loads state round-trip", () => {
    const state = makeSampleState();
    store.save(state);
    const loaded = store.load("cv-test-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.capturedFunding).toBe(12.5);
    expect(loaded!.totalFees).toBe(1.2);
    expect(loaded!.equity).toBeCloseTo(1011.3);
    expect(loaded!.periods).toBe(48);
    expect(loaded!.flipCount).toBe(3);
    expect(loaded!.positioned).toBe(true);
    expect(loaded!.shortVenue).toBe("hyperliquid");
    expect(loaded!.longVenue).toBe("dydx");
    expect(loaded!.executionMode).toBe("paper");
    expect(loaded!.hourlyAccruals).toEqual([
      { bucket: 100, earned: 0.5 },
      { bucket: 101, earned: -0.1 },
    ]);
  });

  it("upserts (updates existing row)", () => {
    store.save(makeSampleState({ periods: 10 }));
    store.save(makeSampleState({ periods: 20 }));
    const loaded = store.load("cv-test-1");
    expect(loaded!.periods).toBe(20);
  });

  it("records flip events", () => {
    store.recordFlip({
      botId:       "cv-test-1",
      ts:          Date.now(),
      fromShort:   "hyperliquid",
      fromLong:    "dydx",
      toShort:     "dydx",
      toLong:      "hyperliquid",
      spread:      0.0001,
      fee:         2.0,
      equityAfter: 1009.3,
    });

    const rows = db.prepare("SELECT * FROM cv_flip_events WHERE bot_id = ?").all("cv-test-1") as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("simulates restart: save → new store instance → load recovers state", () => {
    store.save(makeSampleState({
      capturedFunding: 42.0,
      flipCount: 7,
      periods: 100,
    }));

    // Simulate restart: create a new store against the same DB
    const store2 = new CvStateStore(db);
    const loaded = store2.load("cv-test-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.capturedFunding).toBe(42.0);
    expect(loaded!.flipCount).toBe(7);
    expect(loaded!.periods).toBe(100);
  });

  it("fresh bot with no row starts clean (returns null)", () => {
    store.save(makeSampleState({ botId: "cv-other" }));
    expect(store.load("cv-test-1")).toBeNull();
  });
});
