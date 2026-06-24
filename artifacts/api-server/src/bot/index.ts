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
import { runBacktest } from "./backtest.js";
import {
  openPaperPosition,
  getPaperStats,
  checkPaperPositions,
} from "./paper-trading.js";
import { getJournalStats } from "./journal.js";
import {
  loadSettings,
  saveSettings,
  loadPaperAccount,
} from "./storage.js";
import { logger } from "../lib/logger.js";
import type { Interval } from "./binance.js";

const POPULAR_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT",
  "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
];
const VALID_INTERVALS: Interval[] = ["5m", "15m", "1h", "4h", "1d"];

const HELP_TEXT = `
🤖 *Торговый сигнал-бот*

*📊 Сигналы:*
/signal \\<ПАРА\\> \\[интервал\\] — получить сигнал
/subscribe \\<ПАРА\\> \\[интервал\\] — авто-сигналы каждые 15 мин
/unsubscribe \\<ПАРА\\> — отключить пару
/unsubscribeall — отключить все
/mysubs — мои подписки

*📈 Бэктест:*
/backtest \\<ПАРА\\> \\[интервал\\] — проверить стратегию на истории

*💼 Виртуальный счёт:*
/paper — статистика счёта
/paper\\_open \\<ПАРА\\> \\[интервал\\] — открыть виртуальную сделку
/paper\\_check — обновить позиции
/paper\\_reset — сбросить счёт \\(\\$10 000\\)

*📓 Журнал:*
/journal — статистика сигналов и самообучение

*⚙️ Настройки:*
/settings — текущие настройки
/setminсcore \\<число\\> — мин. оценка сигнала \\(по умол. 70\\)
/setrisk \\<\\%\\> — риск на сделку \\(по умол. 1\\%\\)
/setbalance \\<USD\\> — размер счёта \\(по умол. 1000\\)
/notrade on\\|off — режим «не торговать»

*📋 Прочее:*
/pairs — популярные пары
/help — эта справка

*Интервалы:* 5m · 15m · 1h · 4h · 1d

*Индикаторы:* RSI · MACD · BB · EMA20/50/200 · StochRSI · ADX · ATR · Volume
*Уровни:* Поддержка/Сопротивление · Фибоначчи
*Паттерны:* Пробой · Флаг · Треугольник · Двойная вершина/дно · Консолидация

⚠️ _Не является финансовой рекомендацией. Торгуйте осознанно._
`.trim();

function parseArgs(text: string): string[] {
  return text.trim().split(/\s+/).slice(1);
}

export function createBot(): Telegraf {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const bot = new Telegraf(token);

  bot.start((ctx) => {
    const name = ctx.from?.first_name ?? "трейдер";
    ctx.replyWithMarkdown(`Привет, *${name}*! 👋\n\n${HELP_TEXT}`);
  });

  bot.help((ctx) => ctx.replyWithMarkdown(HELP_TEXT));

  bot.command("pairs", (ctx) => {
    const list = POPULAR_PAIRS.map((p) => `• \`${p}\``).join("\n");
    ctx.replyWithMarkdown(`📋 *Популярные пары:*\n\n${list}\n\nИспользуй: \`/signal BTCUSDT\``);
  });

  bot.command("signal", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const rawSymbol = args[0];
    const rawInterval = args[1];

    if (!rawSymbol) {
      return ctx.replyWithMarkdown("❌ Укажи пару. Например: `/signal BTCUSDT` или `/signal ETHUSDT 4h`");
    }

    const symbol = rawSymbol.toUpperCase();
    const interval: Interval = VALID_INTERVALS.includes(rawInterval as Interval)
      ? (rawInterval as Interval) : "1h";

    const loading = await ctx.replyWithMarkdown(`⏳ Анализирую *${symbol}* (${interval})...`);

    try {
      const valid = await validateSymbol(symbol);
      if (!valid) {
        await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
        return ctx.replyWithMarkdown(`❌ Пара \`${symbol}\` не найдена на Binance.`);
      }

      const sig = await generateSignal(symbol, interval, ctx.chat.id);
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
      await ctx.replyWithMarkdown(formatSignal(sig));
    } catch (err) {
      logger.error({ err }, "Signal error");
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
      await ctx.reply("⚠️ Ошибка при получении данных. Попробуй позже.");
    }
  });

  bot.command("backtest", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const rawSymbol = args[0];
    const rawInterval = args[1];

    if (!rawSymbol) {
      return ctx.replyWithMarkdown("❌ Укажи пару. Например: `/backtest BTCUSDT 1h`");
    }

    const symbol = rawSymbol.toUpperCase();
    const interval: Interval = VALID_INTERVALS.includes(rawInterval as Interval)
      ? (rawInterval as Interval) : "1h";

    const loading = await ctx.replyWithMarkdown(
      `⏳ Запускаю бэктест *${symbol}* (${interval})...\nЭто займёт несколько секунд.`
    );

    try {
      const settings = await loadSettings(ctx.chat.id);
      const result = await runBacktest(symbol, interval, settings.minScore);
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
      await ctx.replyWithMarkdown(result.summary);
    } catch (err) {
      logger.error({ err }, "Backtest error");
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
      await ctx.reply("⚠️ Ошибка бэктеста. Попробуй другую пару или интервал.");
    }
  });

  bot.command("paper", async (ctx) => {
    const stats = await getPaperStats(ctx.chat.id);
    await ctx.replyWithMarkdown(stats);
  });

  bot.command("paper_open", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const rawSymbol = args[0];
    const rawInterval = args[1];

    if (!rawSymbol) {
      return ctx.replyWithMarkdown("❌ Укажи пару. Например: `/paper_open BTCUSDT 1h`");
    }

    const symbol = rawSymbol.toUpperCase();
    const interval: Interval = VALID_INTERVALS.includes(rawInterval as Interval)
      ? (rawInterval as Interval) : "1h";

    const loading = await ctx.replyWithMarkdown(`⏳ Получаю сигнал для *${symbol}*...`);

    try {
      const valid = await validateSymbol(symbol);
      if (!valid) {
        await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
        return ctx.replyWithMarkdown(`❌ Пара \`${symbol}\` не найдена на Binance.`);
      }

      const sig = await generateSignal(symbol, interval, ctx.chat.id);
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);

      if (sig.filtered || sig.score.direction === "NEUTRAL") {
        return ctx.replyWithMarkdown(
          `⚠️ Сигнал не прошёл фильтры:\n${sig.filterReason ?? "Нет чёткого направления"}\n\nВиртуальная сделка не открыта.`
        );
      }

      const settings = await loadSettings(ctx.chat.id);
      const result = await openPaperPosition(
        ctx.chat.id,
        symbol,
        sig.score.direction,
        sig.risk.entryPrice,
        sig.risk.stopLoss,
        sig.risk.tp1,
        sig.risk.tp2,
        settings.riskPercent
      );
      await ctx.replyWithMarkdown(result.message);
    } catch (err) {
      logger.error({ err }, "Paper open error");
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
      await ctx.reply("⚠️ Ошибка. Попробуй позже.");
    }
  });

  bot.command("paper_check", async (ctx) => {
    const messages = await checkPaperPositions(ctx.chat.id);
    if (messages.length === 0) {
      const account = await loadPaperAccount(ctx.chat.id);
      if (account.positions.length === 0) {
        return ctx.reply("ℹ️ Нет открытых виртуальных позиций. Открой через /paper_open");
      }
      return ctx.reply("✅ Все позиции открыты, TP/SL ещё не достигнуты.");
    }
    for (const msg of messages) {
      await ctx.replyWithMarkdown(msg);
    }
  });

  bot.command("paper_reset", async (ctx) => {
    const { savePaperAccount } = await import("./storage.js");
    await savePaperAccount(ctx.chat.id, {
      balance: 10000,
      initialBalance: 10000,
      positions: [],
      closedTrades: [],
    });
    await ctx.reply("✅ Виртуальный счёт сброшен. Баланс: $10,000");
  });

  bot.command("journal", async (ctx) => {
    const stats = await getJournalStats();
    await ctx.replyWithMarkdown(stats);
  });

  bot.command("settings", async (ctx) => {
    const s = await loadSettings(ctx.chat.id);
    await ctx.replyWithMarkdown(
      `⚙️ *Настройки*\n\n` +
      `Мин. оценка сигнала: ${s.minScore}/100\n` +
      `Риск на сделку: ${s.riskPercent}%\n` +
      `Размер счёта: $${s.accountSize}\n` +
      `Режим "не торговать": ${s.noTradeMode ? "✅ Включён" : "❌ Выключен"}\n\n` +
      `Изменить:\n` +
      `/setminscore 75\n` +
      `/setrisk 2\n` +
      `/setbalance 5000\n` +
      `/notrade on`
    );
  });

  bot.command("setminscore", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const val = parseInt(args[0] ?? "");
    if (isNaN(val) || val < 50 || val > 100) {
      return ctx.reply("❌ Укажи число от 50 до 100. Например: /setminscore 75");
    }
    const s = await loadSettings(ctx.chat.id);
    s.minScore = val;
    await saveSettings(ctx.chat.id, s);
    await ctx.reply(`✅ Минимальная оценка сигнала: ${val}/100`);
  });

  bot.command("setrisk", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const val = parseFloat(args[0] ?? "");
    if (isNaN(val) || val < 0.1 || val > 10) {
      return ctx.reply("❌ Укажи % от 0.1 до 10. Например: /setrisk 1.5");
    }
    const s = await loadSettings(ctx.chat.id);
    s.riskPercent = val;
    await saveSettings(ctx.chat.id, s);
    await ctx.reply(`✅ Риск на сделку: ${val}%`);
  });

  bot.command("setbalance", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const val = parseFloat(args[0] ?? "");
    if (isNaN(val) || val < 10) {
      return ctx.reply("❌ Укажи сумму от $10. Например: /setbalance 5000");
    }
    const s = await loadSettings(ctx.chat.id);
    s.accountSize = val;
    await saveSettings(ctx.chat.id, s);
    await ctx.reply(`✅ Размер счёта: $${val}`);
  });

  bot.command("notrade", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const val = args[0]?.toLowerCase();
    if (val !== "on" && val !== "off") {
      return ctx.reply('❌ Укажи on или off. Например: /notrade on');
    }
    const s = await loadSettings(ctx.chat.id);
    s.noTradeMode = val === "on";
    await saveSettings(ctx.chat.id, s);
    await ctx.reply(
      val === "on"
        ? "🚫 Режим «не торговать» включён. Сигналы будут заблокированы."
        : "✅ Режим «не торговать» выключен. Сигналы снова активны."
    );
  });

  bot.command("subscribe", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const rawSymbol = args[0];
    const rawInterval = args[1];
    if (!rawSymbol) return ctx.replyWithMarkdown("❌ Укажи пару. Например: `/subscribe BTCUSDT 1h`");
    const symbol = rawSymbol.toUpperCase();
    const interval: Interval = VALID_INTERVALS.includes(rawInterval as Interval)
      ? (rawInterval as Interval) : "1h";
    const valid = await validateSymbol(symbol);
    if (!valid) return ctx.replyWithMarkdown(`❌ Пара \`${symbol}\` не найдена на Binance.`);
    subscribe(ctx.chat.id, symbol, interval);
    await ctx.replyWithMarkdown(
      `✅ Подписка на *${symbol}* (${interval}) активирована!\nСигналы каждые 15 мин.\n\nОтключить: \`/unsubscribe ${symbol}\``
    );
  });

  bot.command("unsubscribe", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const rawSymbol = args[0];
    if (!rawSymbol) return ctx.replyWithMarkdown("❌ Укажи пару. Например: `/unsubscribe BTCUSDT`");
    const symbol = rawSymbol.toUpperCase();
    const removed = unsubscribe(ctx.chat.id, symbol);
    await ctx.replyWithMarkdown(
      removed ? `✅ Подписка на *${symbol}* отключена.` : `ℹ️ Подписки на *${symbol}* не было.`
    );
  });

  bot.command("unsubscribeall", async (ctx) => {
    const count = unsubscribeAll(ctx.chat.id);
    await ctx.reply(count > 0 ? `✅ Отключено ${count} подписок.` : "ℹ️ Активных подписок не было.");
  });

  bot.command("mysubs", async (ctx) => {
    const subs = listSubscriptions(ctx.chat.id);
    if (subs.length === 0) {
      return ctx.replyWithMarkdown("ℹ️ Нет активных подписок.\n\nДобавить: `/subscribe BTCUSDT 1h`");
    }
    const list = subs.map((s) => `• \`${s.symbol}\` — ${s.interval}`).join("\n");
    await ctx.replyWithMarkdown(`📋 *Твои подписки:*\n\n${list}`);
  });

  bot.on("text", (ctx) => {
    ctx.replyWithMarkdown("Введи /help для справки или /signal BTCUSDT для сигнала.");
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
