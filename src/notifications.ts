import { bus } from "./events.js";
import type { TradeResult, Signal } from "./events.js";

const RATE_LIMIT_MS = 10_000; // max one message per 10 seconds

export function initNotifications(): void {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  console.log("[notifications] Telegram notifications enabled");

  let lastSentAt = 0;
  const queue: string[] = [];
  let draining = false;

  async function send(text: string): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[notifications] Telegram API error ${res.status}: ${body}`);
      }
    } catch (err) {
      console.warn("[notifications] Failed to send Telegram message:", err);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const wait = RATE_LIMIT_MS - (Date.now() - lastSentAt);
      if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
      const msg = queue.shift();
      if (msg) {
        await send(msg);
        lastSentAt = Date.now();
      }
    }
    draining = false;
  }

  function enqueue(text: string): void {
    queue.push(text);
    drain().catch((err: Error) =>
      console.warn("[notifications] Drain error:", err.message),
    );
  }

  // ── Trade executed ───────────────────────────────────────────────────────
  bus.on("trade", (result: TradeResult) => {
    if (!result.success) return;

    const isClose = result.pnl != null;
    const emoji   = result.side === "long" ? "🟢" : "🔴";

    if (isClose) {
      const pnlSign = result.pnl! >= 0 ? "+" : "";
      const isStopLoss = result.reason?.startsWith("Stop-loss");
      const closeEmoji = isStopLoss ? "🛑" : "✅";
      enqueue(
        `${closeEmoji} <b>Position Closed</b>\n` +
        `Side: ${result.side.toUpperCase()}\n` +
        `Size: ${result.size} ${result.coin} @ $${result.price.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}\n` +
        `P&amp;L: <code>${pnlSign}$${result.pnl!.toFixed(2)}</code>` +
        (result.reason ? `\nReason: ${result.reason}` : ""),
      );
    } else {
      enqueue(
        `${emoji} <b>Position Opened</b>\n` +
        `Side: ${result.side.toUpperCase()}\n` +
        `Size: ${result.size} ${result.coin} @ $${result.price.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` +
        (result.reason ? `\nReason: ${result.reason}` : ""),
      );
    }
  });

  // ── Signal rejected ──────────────────────────────────────────────────────
  bus.on("signal:rejected", (signal: Signal, reason: string) => {
    enqueue(
      `⚠️ <b>Signal Rejected</b>\n` +
      `${signal.side.toUpperCase()} ${signal.coin}\n` +
      `Reason: ${reason}`,
    );
  });

  // ── Daily P&L summary at midnight UTC ───────────────────────────────────
  let sessionRealisedPnl = 0;
  bus.on("trade", (result: TradeResult) => {
    if (result.success && result.pnl != null) sessionRealisedPnl += result.pnl;
  });

  function scheduleDailySummary(): void {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      const sign = sessionRealisedPnl >= 0 ? "+" : "";
      enqueue(
        `📊 <b>Daily P&amp;L Summary</b>\n` +
        `Realised P&amp;L: <code>${sign}$${sessionRealisedPnl.toFixed(2)}</code>`,
      );
      sessionRealisedPnl = 0; // reset for new day
      scheduleDailySummary();
    }, msUntilMidnight);
  }

  scheduleDailySummary();
}
