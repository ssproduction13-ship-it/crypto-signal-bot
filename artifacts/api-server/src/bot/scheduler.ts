import cron from "node-cron";
import type { Telegraf } from "telegraf";
import { generateSignal, formatSignal } from "./signals.js";
import { logger } from "../lib/logger.js";
import type { Interval } from "./binance.js";

interface Subscription {
  chatId: number;
  symbol: string;
  interval: Interval;
}

const subscriptions = new Map<string, Subscription>();

function subKey(chatId: number, symbol: string): string {
  return `${chatId}:${symbol}`;
}

export function subscribe(
  chatId: number,
  symbol: string,
  interval: Interval = "1h"
): void {
  const key = subKey(chatId, symbol);
  subscriptions.set(key, { chatId, symbol, interval });
}

export function unsubscribe(chatId: number, symbol: string): boolean {
  const key = subKey(chatId, symbol);
  return subscriptions.delete(key);
}

export function unsubscribeAll(chatId: number): number {
  let count = 0;
  for (const [key, sub] of subscriptions.entries()) {
    if (sub.chatId === chatId) {
      subscriptions.delete(key);
      count++;
    }
  }
  return count;
}

export function listSubscriptions(chatId: number): Subscription[] {
  return Array.from(subscriptions.values()).filter(
    (s) => s.chatId === chatId
  );
}

export function startScheduler(bot: Telegraf): void {
  cron.schedule("*/15 * * * *", async () => {
    if (subscriptions.size === 0) return;
    logger.info("Running scheduled signals for subscriptions");

    for (const sub of subscriptions.values()) {
      try {
        const sig = await generateSignal(sub.symbol, sub.interval);
        const text = `🔔 *Авто-сигнал*\n\n${formatSignal(sig)}`;
        await bot.telegram.sendMessage(sub.chatId, text, {
          parse_mode: "Markdown",
        });
      } catch (err) {
        logger.error({ err, sub }, "Failed to send scheduled signal");
      }
    }
  });

  logger.info("Scheduler started — signals every 15 minutes");
}
