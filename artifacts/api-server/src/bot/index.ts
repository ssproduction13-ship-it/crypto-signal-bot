import { Telegraf } from "telegraf";
import { generateSignal, formatSignal } from "./signals.js";
import { validateSymbol } from "./binance.js";
import {
  subscribe,
  unsubscribe,
  unsubscribeAll,
  listSubscriptions,
  startScheduler,
} from "./scheduler.js";
import { logger } from "../lib/logger.js";
import type { Interval } from "./binance.js";

const POPULAR_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
];

const VALID_INTERVALS: Interval[] = ["15m", "1h", "4h", "1d"];

const HELP_TEXT = `
🤖 *Торговый сигнал-бот*

Анализирует крипто-пары по 6 индикаторам и выдаёт сигнал ПОКУПАТЬ / ПРОДАВАТЬ / ДЕРЖАТЬ.

*Команды:*
/signal \\<ПАРА\\> \\[интервал\\] — получить сигнал
/subscribe \\<ПАРА\\> \\[интервал\\] — авто-сигналы каждые 15 мин
/unsubscribe \\<ПАРА\\> — отключить пару
/unsubscribeall — отключить все подписки
/mysubs — мои подписки
/pairs — популярные пары
/help — справка

*Примеры:*
\`/signal BTCUSDT\`
\`/signal ETHUSDT 4h\`
\`/subscribe SOLUSDT 1h\`

*Интервалы:* 15m · 1h · 4h · 1d

*Индикаторы:*
RSI · MACD · Bollinger Bands · EMA20/50 · StochRSI · ADX + Volume

⚠️ _Не является финансовой рекомендацией._
`;

export function createBot(): Telegraf {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const bot = new Telegraf(token);

  bot.start((ctx) => {
    const name = ctx.from?.first_name ?? "трейдер";
    ctx.replyWithMarkdown(
      `Привет, *${name}*! 👋\n\n${HELP_TEXT}`
    );
  });

  bot.help((ctx) => ctx.replyWithMarkdown(HELP_TEXT));

  bot.command("pairs", (ctx) => {
    const list = POPULAR_PAIRS.map((p) => `• \`${p}\``).join("\n");
    ctx.replyWithMarkdown(
      `📋 *Популярные пары:*\n\n${list}\n\nИспользуй: \`/signal BTCUSDT\``
    );
  });

  bot.command("signal", async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const rawSymbol = parts[1];
    const rawInterval = parts[2];

    if (!rawSymbol) {
      return ctx.replyWithMarkdown(
        "❌ Укажи пару. Например: `/signal BTCUSDT` или `/signal ETHUSDT 4h`"
      );
    }

    const symbol = rawSymbol.toUpperCase();
    const interval: Interval =
      VALID_INTERVALS.includes(rawInterval as Interval)
        ? (rawInterval as Interval)
        : "1h";

    const loading = await ctx.replyWithMarkdown(
      `⏳ Анализирую *${symbol}* (${interval})...`
    );

    try {
      const valid = await validateSymbol(symbol);
      if (!valid) {
        await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
        return ctx.replyWithMarkdown(
          `❌ Пара \`${symbol}\` не найдена на Binance. Проверь написание.`
        );
      }

      const sig = await generateSignal(symbol, interval);
      const text = formatSignal(sig);

      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
      await ctx.replyWithMarkdown(text);
    } catch (err) {
      logger.error({ err }, "Signal error");
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
      await ctx.reply("⚠️ Ошибка при получении данных. Попробуй позже.");
    }
  });

  bot.command("subscribe", async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const rawSymbol = parts[1];
    const rawInterval = parts[2];

    if (!rawSymbol) {
      return ctx.replyWithMarkdown(
        "❌ Укажи пару. Например: `/subscribe BTCUSDT 1h`"
      );
    }

    const symbol = rawSymbol.toUpperCase();
    const interval: Interval =
      VALID_INTERVALS.includes(rawInterval as Interval)
        ? (rawInterval as Interval)
        : "1h";

    const valid = await validateSymbol(symbol);
    if (!valid) {
      return ctx.replyWithMarkdown(
        `❌ Пара \`${symbol}\` не найдена на Binance.`
      );
    }

    subscribe(ctx.chat.id, symbol, interval);
    await ctx.replyWithMarkdown(
      `✅ Подписка на *${symbol}* (${interval}) активирована!\n\nСигналы будут приходить каждые 15 минут.\n\nОтключить: \`/unsubscribe ${symbol}\``
    );
  });

  bot.command("unsubscribe", async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const rawSymbol = parts[1];

    if (!rawSymbol) {
      return ctx.replyWithMarkdown(
        "❌ Укажи пару. Например: `/unsubscribe BTCUSDT`"
      );
    }

    const symbol = rawSymbol.toUpperCase();
    const removed = unsubscribe(ctx.chat.id, symbol);

    if (removed) {
      await ctx.replyWithMarkdown(`✅ Подписка на *${symbol}* отключена.`);
    } else {
      await ctx.replyWithMarkdown(
        `ℹ️ Подписки на *${symbol}* не было.`
      );
    }
  });

  bot.command("unsubscribeall", async (ctx) => {
    const count = unsubscribeAll(ctx.chat.id);
    if (count > 0) {
      await ctx.reply(`✅ Отключено ${count} подписок.`);
    } else {
      await ctx.reply("ℹ️ Активных подписок не было.");
    }
  });

  bot.command("mysubs", async (ctx) => {
    const subs = listSubscriptions(ctx.chat.id);
    if (subs.length === 0) {
      return ctx.replyWithMarkdown(
        "ℹ️ У тебя нет активных подписок.\n\nДобавить: `/subscribe BTCUSDT 1h`"
      );
    }

    const list = subs
      .map((s) => `• \`${s.symbol}\` — ${s.interval}`)
      .join("\n");
    await ctx.replyWithMarkdown(`📋 *Твои подписки:*\n\n${list}`);
  });

  bot.on("text", (ctx) => {
    ctx.replyWithMarkdown(
      "Я понимаю команды. Введи /help для справки или /signal BTCUSDT для сигнала."
    );
  });

  bot.catch((err) => {
    logger.error({ err }, "Telegraf error");
  });

  return bot;
}

export function startBot(): void {
  try {
    const bot = createBot();
    startScheduler(bot);

    bot.launch({ dropPendingUpdates: true });
    logger.info("Telegram bot started (long polling)");

    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  } catch (err) {
    logger.error({ err }, "Failed to start Telegram bot");
  }
}
