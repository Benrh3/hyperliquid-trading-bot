// Persistence layer for CrossVenueFundingBasis bot state.
// Write-through on every accrual/flip so a crash never loses data.

import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface CvPersistedState {
  botId:            string;
  capturedFunding:  number;
  totalFees:        number;
  equity:           number;
  periods:          number;
  flipCount:        number;
  startedAt:        number;
  totalLegHoldMs:   number;
  lastBucket:       number;
  lastFlipAt:       number;
  positioned:       boolean;
  shortVenue:       string;
  longVenue:        string;
  executionMode:    "paper" | "live";
  notional:         number;
  dailyStartEq:     number;
  hourlyAccruals:   Array<{ bucket: number; earned: number }>;
}

export interface CvFlipEvent {
  botId:      string;
  ts:         number;
  fromShort:  string;
  fromLong:   string;
  toShort:    string;
  toLong:     string;
  spread:     number;
  fee:        number;
  equityAfter: number;
}

export class CvStateStore {
  private db: Database.Database;
  private stmtUpsert: Database.Statement;
  private stmtLoad:   Database.Statement;
  private stmtFlip:   Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    const migration = join(process.cwd(), "migrations", "005_cv_state.sql");
    if (existsSync(migration)) {
      this.db.exec(readFileSync(migration, "utf-8"));
    }

    this.stmtUpsert = this.db.prepare(`
      INSERT OR REPLACE INTO cv_bot_state
        (bot_id, captured_funding, total_fees, equity, periods, flip_count,
         started_at, total_leg_hold_ms, last_bucket, last_flip_at,
         positioned, short_venue, long_venue, execution_mode, notional,
         daily_start_eq, hourly_accruals, updated_at)
      VALUES
        (@botId, @capturedFunding, @totalFees, @equity, @periods, @flipCount,
         @startedAt, @totalLegHoldMs, @lastBucket, @lastFlipAt,
         @positioned, @shortVenue, @longVenue, @executionMode, @notional,
         @dailyStartEq, @hourlyAccruals, @updatedAt)
    `);

    this.stmtLoad = this.db.prepare(
      "SELECT * FROM cv_bot_state WHERE bot_id = ?",
    );

    this.stmtFlip = this.db.prepare(`
      INSERT INTO cv_flip_events
        (bot_id, ts, from_short, from_long, to_short, to_long, spread, fee, equity_after)
      VALUES
        (@botId, @ts, @fromShort, @fromLong, @toShort, @toLong, @spread, @fee, @equityAfter)
    `);
  }

  save(state: CvPersistedState): void {
    this.stmtUpsert.run({
      botId:           state.botId,
      capturedFunding: state.capturedFunding,
      totalFees:       state.totalFees,
      equity:          state.equity,
      periods:         state.periods,
      flipCount:       state.flipCount,
      startedAt:       state.startedAt,
      totalLegHoldMs:  state.totalLegHoldMs,
      lastBucket:      state.lastBucket,
      lastFlipAt:      state.lastFlipAt,
      positioned:      state.positioned ? 1 : 0,
      shortVenue:      state.shortVenue,
      longVenue:       state.longVenue,
      executionMode:   state.executionMode,
      notional:        state.notional,
      dailyStartEq:    state.dailyStartEq,
      hourlyAccruals:  JSON.stringify(state.hourlyAccruals),
      updatedAt:       Date.now(),
    });
  }

  load(botId: string): CvPersistedState | null {
    const row = this.stmtLoad.get(botId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      botId:           row.bot_id as string,
      capturedFunding: row.captured_funding as number,
      totalFees:       row.total_fees as number,
      equity:          row.equity as number,
      periods:         row.periods as number,
      flipCount:       row.flip_count as number,
      startedAt:       row.started_at as number,
      totalLegHoldMs:  row.total_leg_hold_ms as number,
      lastBucket:      row.last_bucket as number,
      lastFlipAt:      row.last_flip_at as number,
      positioned:      (row.positioned as number) === 1,
      shortVenue:      row.short_venue as string,
      longVenue:       row.long_venue as string,
      executionMode:   row.execution_mode as "paper" | "live",
      notional:        row.notional as number,
      dailyStartEq:    row.daily_start_eq as number,
      hourlyAccruals:  JSON.parse(row.hourly_accruals as string),
    };
  }

  recordFlip(event: CvFlipEvent): void {
    this.stmtFlip.run({
      botId:      event.botId,
      ts:         event.ts,
      fromShort:  event.fromShort,
      fromLong:   event.fromLong,
      toShort:    event.toShort,
      toLong:     event.toLong,
      spread:     event.spread,
      fee:        event.fee,
      equityAfter: event.equityAfter,
    });
  }
}
