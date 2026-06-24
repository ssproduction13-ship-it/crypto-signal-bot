import cron from "node-cron";
  import type { Telegraf } from "telegraf";
  import { generateSignal, formatSignal } from "./signals.js";
  import { checkOpenSignals } from "./journal.js";
  import { checkPaperPositions } from "./paper-trading.js";
  import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";
  import type { Interval } from "./binance.js";

  interface Subscription {
    chatId: number;
    symbol: string;
    interval: Interval;
  }

  const subscriptions = new Map<string, Subscription>();
  const activeChatIds = new Set<number>();

  function subKey(chatId: number, symbol: string): string {
    return `${chatId}:${symbol}`;
  }

  export async function initSubscriptions(): Promise<void> {
    const { rows } = await pool.query(
      "SELECT chat_id, symbol, interval FROM subscriptions"
    );
    for (const row of rows as Record<string, unknown>[]) {
      const chatId = Number(row["chat_id"]);
      subscriptions.set(subKey(chatId, row["symbol"] as string), {
        chatId,
        symbol: row["symbol"] as string,
        interval: row["interval"] as Interval,
      });
      activeChatIds.add(chatId);
    }
    logger.info({ count: subscriptions.size }, "Loaded subscriptions from DB");
  }

  export function subscribe(chatId: number, symbol: string, interval: Interval = "1h"): void {
    subscriptions.set(subKey(chatId, symbol), { chatId, symbol, interval });
    activeChatIds.add(chatId);
    pool.query(
      `INSERT INTO subscriptions (chat_id, symbol, interval) VALUES ($1,$2,$3)
       ON CONFLICT (chat_id, symbol) DO UPDATE SET interval=EXCLUDED.interval`,
      [chatId, symbol, interval]
    ).catch((err: unknown) => logger.error({ err }, "Failed to persist subscription"));
  }

  export function unsubscribe(chatId: number, symbol: string): boolean {
    const removed = subscriptions.delete(subKey(chatId, symbol));
    const stillHas = [...subscriptions.values()].some((s) => s.chatId === chatId);
    if (!stillHas) activeChatIds.delete(chatId);
    pool.query(
      "DELETE FROM subscriptions WHERE chat_id=$1 AND symbol=$2",
      [chatId, symbol]
    ).catch((err: unknown) => logger.error({ err }, "Failed to remove subscription"));
    return removed;
  }

  export function unsubscribeAll(chatId: number): number {
    let count = 0;
    for (const [key, sub] of subscriptions.entries()) {
      if (sub.chatId === chatId) { subscriptions.delete(key); count++; }
    }
    activeChatIds.delete(chatId);
    pool.query("DELETE FROM subscriptions WHERE chat_id=$1", [chatId])
      .catch((err: unknown) => logger.error({ err }, "Failed to remove all subscriptions"));
    return count;
  }

  export function listSubscriptions(chatId: number): Subscription[] {
    return [...subscriptions.values()].filter((s) => s.chatId === chatId);
  }

  export function startScheduler(bot: Telegraf): void {
    cron.schedule("*/15 * * * *", async () => {
      if (subscriptions.size === 0) return;
      logger.info("Running scheduled signals");
      for (const sub of subscriptions.values()) {
        try {
          const sig = await generateSignal(sub.symbol, sub.interval, sub.chatId);
          const text = `🔔 *Авто-сигнал*\n\n${formatSignal(sig)}`;
          await bot.telegram.sendMessage(sub.chatId, text, { parse_mode: "Markdown" });
        } catch (err) {
          logger.error({ err, sub }, "Failed to send scheduled signal");
        }
      }
    });

    cron.schedule("*/5 * * * *", async () => {
      const results = await checkOpenSignals();
      for (const { message } of results) {
        for (const chatId of activeChatIds) {
          try {
            await bot.telegram.sendMessage(chatId, message, { parse_mode: "Markdown" });
          } catch {}
        }
      }
      for (const chatId of activeChatIds) {
        const msgs = await checkPaperPositions(chatId);
        for (const msg of msgs) {
          try {
            await bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" });
          } catch {}
        }
      }
    });

    logger.info("Scheduler started — signals every 15 min, journal checks every 5 min");
  }
  