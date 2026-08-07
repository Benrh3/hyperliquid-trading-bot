import type { MarketStore } from "../market/store.js";
import { HORIZONS, HORIZON_ORDER } from "./horizons.js";
import { buildSwingDataSlice } from "./fetcher.js";
import { carryVoice } from "./voices/carry.js";
import { positioningVoice } from "./voices/positioning.js";
import { trendVoice } from "./voices/trend.js";
import { flowVoice } from "./voices/flow.js";
import { capitulationVoice } from "./voices/capitulation.js";
import { classifyRegime } from "./regime.js";
import { deriveVerdict } from "./verdict.js";
import type {
  HorizonConfig, HorizonName, Call,
  SwingCurrentStateRow, VoiceResult,
} from "./types.js";

async function sendTelegram(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) console.warn(`[swing-advisor] Telegram error ${res.status}`);
  } catch (err) {
    console.warn("[swing-advisor] Telegram send failed:", (err as Error).message);
  }
}

function formatFlipMessage(
  horizon: string,
  oldCall: Call,
  newCall: Call,
  price:   number | null,
  regime:  string,
  agreement: number | null,
  voices:  VoiceResult[],
): string {
  const arrow   = newCall === "LONG" ? "📈" : newCall === "SHORT" ? "📉" : "⏸";
  const voiceLines = voices
    .filter((v) => v.direction !== "NEUTRAL")
    .map((v) => `  • ${v.name}: ${v.direction} (${(v.effectiveStrength * 100).toFixed(0)}%)`)
    .join("\n");
  return (
    `${arrow} <b>Swing Advisor — ${horizon.toUpperCase()} flip</b>\n` +
    `${oldCall} → <b>${newCall}</b>\n` +
    (price ? `HYPE price: $${price.toFixed(2)}\n` : "") +
    `Regime: ${regime}\n` +
    (agreement != null ? `Agreement: ${(agreement * 100).toFixed(0)}%\n` : "") +
    (voiceLines ? `\nVoices:\n${voiceLines}` : "") +
    `\n[unvalidated — IC pending]`
  );
}

export class SwingAdvisorPoller {
  private store:    MarketStore;
  private timers:   Map<string, ReturnType<typeof setTimeout>> = new Map();
  private stopped = false;

  constructor(store: MarketStore) {
    this.store = store;
  }

  start(): void {
    for (const name of HORIZON_ORDER) {
      const cfg = HORIZONS[name];
      if (cfg) this.scheduleHorizon(name, cfg);
    }
    // Forward-return fill check runs every 30 minutes
    this.scheduleFillJob();
    console.log("[swing-advisor] Poller started");
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private scheduleHorizon(name: string, cfg: HorizonConfig): void {
    if (this.stopped) return;

    const existing = this.store.getSwingCurrentState(name as HorizonName);
    const lastAt   = existing?.last_computed_at ?? 0;
    const nextAt   = lastAt + cfg.pollIntervalMs;
    const delay    = Math.max(0, nextAt - Date.now());

    const t = setTimeout(async () => {
      await this.runHorizon(name, cfg).catch((err: Error) =>
        console.error(`[swing-advisor] ${name} error:`, err.message),
      );
      this.scheduleHorizon(name, cfg);
    }, delay);

    this.timers.set(name, t);
    if (delay > 5_000) {
      console.log(`[swing-advisor] ${name} next run in ${Math.round(delay / 60_000)} min`);
    }
  }

  private async runHorizon(name: string, cfg: HorizonConfig): Promise<void> {
    console.log(`[swing-advisor] Computing ${name}…`);
    const now   = Date.now();
    const slice = await buildSwingDataSlice(this.store, cfg);

    const voices = [
      carryVoice(slice, cfg),
      positioningVoice(slice, cfg),
      trendVoice(slice, cfg),
      flowVoice(slice, cfg),
      capitulationVoice(slice, cfg),
    ];

    const regime  = classifyRegime(slice.candles, cfg);
    const verdict = deriveVerdict(voices, regime, cfg);

    const prevState = this.store.getSwingCurrentState(name as HorizonName);
    const prevCall  = prevState?.call ?? null;
    const newCall   = verdict.call;

    // Persist current state
    this.store.upsertSwingCurrentState({
      horizon:          name as HorizonName,
      call:             newCall,
      updated_at:       now,
      last_computed_at: now,
      regime:           regime.regime,
      composite_score:  verdict.compositeScore,
      agreement_score:  verdict.agreementScore,
      voices_json:      JSON.stringify(verdict.voices),
      last_notified_at: prevState?.last_notified_at ?? null,
    });

    // Detect flip
    if (prevCall !== null && prevCall !== newCall) {
      const flipAt = now;
      this.store.insertSwingFlip({
        created_at:      flipAt,
        horizon:         name as HorizonName,
        old_call:        prevCall,
        new_call:        newCall,
        hype_price:      slice.currentPrice,
        regime:          regime.regime,
        agreement_score: verdict.agreementScore,
        composite_score: verdict.compositeScore,
        voices_json:     JSON.stringify(verdict.voices),
        forward_return:  null,
        fill_after_at:   flipAt + cfg.forwardWindowMs,
      });

      console.log(`[swing-advisor] ${name.toUpperCase()} flip: ${prevCall} → ${newCall}`);

      // Telegram notification (rate-limited per horizon)
      const lastNotified = prevState?.last_notified_at ?? 0;
      if (now - lastNotified >= cfg.telegramRateLimitMs) {
        await sendTelegram(formatFlipMessage(
          name, prevCall, newCall,
          slice.currentPrice,
          regime.regime,
          verdict.agreementScore,
          verdict.voices,
        ));
        this.store.updateSwingLastNotified(name as HorizonName, now);
      }
    }

    console.log(`[swing-advisor] ${name} → ${newCall} (${regime.regime}, composite=${verdict.compositeScore.toFixed(3)})`);
  }

  private scheduleFillJob(): void {
    if (this.stopped) return;
    const t = setTimeout(async () => {
      await this.fillForwardReturns().catch((err: Error) =>
        console.error("[swing-advisor] fill job error:", err.message),
      );
      this.scheduleFillJob();
    }, 30 * 60_000);
    this.timers.set("__fill__", t);
  }

  private async fillForwardReturns(): Promise<void> {
    const now     = Date.now();
    const pending = this.store.getUnfilledFlips(now);
    if (pending.length === 0) return;

    const priceHistory = this.store.getMetricTimeSeries("HYPE", "perp_mark_px");

    for (const flip of pending) {
      const entryPx = flip.hype_price;
      if (!entryPx) continue;

      // Find the first price snapshot at or after fill_after_at
      const exitPoint = priceHistory.find((p) => p.capturedAt >= flip.fill_after_at && p.value !== null);
      if (!exitPoint) continue;

      const forwardReturn = (exitPoint.value! - entryPx) / entryPx;
      const signedReturn  = flip.new_call === "SHORT" ? -forwardReturn : forwardReturn;
      this.store.fillFlipForwardReturn(flip.id, signedReturn);
      console.log(`[swing-advisor] Filled forward_return for flip ${flip.id}: ${(signedReturn * 100).toFixed(2)}%`);
    }
  }
}
