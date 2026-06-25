import { Telegraf, Markup } from "telegraf";
import { generateSignal, formatSignal } from "./signals.js";
import { validateSymbol } from "./binance.js";
import {
  subscribe, unsubscribe, unsubscribeAll,
  listSubscriptions, startScheduler,
} from "./scheduler.js";
import { runBacktest } from "./backtest.js";
import { openPaperPosition, getPaperStats, checkPaperPositions } from "./paper-trading.js";
import { getJournalStats } from "./journal.js";
import {
  loadSettings, saveSettings, loadPaperAccount, loadJournal, loadWeights,
} from "./storage.js";
import { buildSelfAnalysis } from "./self-analysis.js";
import { getRiskStatus, resumeTrading } from "./risk-manager.js";
import { getStrategyStatus, snapshotStrategy } from "./strategy-guard.js";
import { getMissedStats } from "./missed-trades.js";
import { loadStrategyStats, formatStrategyStats } from "./strategies.js";
import { loadABVariants, formatABReport, initABVariants } from "./ab-testing.js";
import { calcMarketRating, formatMarketRating } from "./market-rating.js";
import { formatPrice } from "./risk.js";
import { logger } from "../lib/logger.js";
import type { Interval } from "./binance.js";

const AUTO_PAIRS: Array<{ symbol: string; interval: Interval }> = [
  { symbol: "BTCUSDT",  interval: "1h"  }, { symbol: "ETHUSDT",  interval: "1h"  },
  { symbol: "SOLUSDT",  interval: "1h"  }, { symbol: "BNBUSDT",  interval: "1h"  },
  { symbol: "XRPUSDT",  interval: "1h"  }, { symbol: "DOGEUSDT", interval: "15m" },
  { symbol: "ADAUSDT",  interval: "15m" }, { symbol: "AVAXUSDT", interval: "1h"  },
  { symbol: "LINKUSDT", interval: "15m" }, { symbol: "NEARUSDT", interval: "15m" },
  { symbol: "SUIUSDT",  interval: "15m" }, { symbol: "APTUSDT",  interval: "15m" },
  { symbol: "OPUSDT",   interval: "1h"  }, { symbol: "ARBUSDT",  interval: "1h"  },
  { symbol: "ATOMUSDT", interval: "1h"  }, { symbol: "DOTUSDT",  interval: "1h"  },
  { symbol: "LTCUSDT",  interval: "1h"  }, { symbol: "TRXUSDT",  interval: "1h"  },
  { symbol: "PEPEUSDT", interval: "15m" }, { symbol: "WIFUSDT",  interval: "15m" },
  { symbol: "SHIBUSDT", interval: "15m" },
];
const ALL_PAIRS = AUTO_PAIRS.map(p => p.symbol);

// ── Menus ─────────────────────────────────────────────────────────────────
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚀 Торговля",         "menu_trading"),
     Markup.button.callback("📈 Аналитика",        "menu_analytics")],
    [Markup.button.callback("💰 Виртуальный счёт", "menu_account"),
     Markup.button.callback("🧠 AI Лаборатория",  "menu_ailab")],
    [Markup.button.callback("⚙️ Настройки",        "menu_settings"),
     Markup.button.callback("❓ Помощь",           "menu_help")],
  ]);
}
function tradingMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Получить сигнал","menu_signal"), Markup.button.callback("🔔 Подписки","menu_subs")],
    [Markup.button.callback("🛡 Статус рисков", "menu_risk"),   Markup.button.callback("🔬 Бэктест", "menu_backtest")],
    [Markup.button.callback("◀️ Главное меню",  "menu_main")],
  ]);
}
function analyticsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📓 Журнал",         "menu_journal"),   Markup.button.callback("🌅 Отчёт",       "menu_report")],
    [Markup.button.callback("🏆 Лучшие сигналы","menu_topsignals"),Markup.button.callback("🔵 Упущенные",   "menu_missed")],
    [Markup.button.callback("◀️ Главное меню",  "menu_main")],
  ]);
}
function accountMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💼 Счёт",          "menu_paper"),     Markup.button.callback("📂 Открыть сделку","menu_paperopen")],
    [Markup.button.callback("🔄 Проверить",     "papercheck"),     Markup.button.callback("🗑 Сбросить",     "paperreset_confirm")],
    [Markup.button.callback("◀️ Главное меню", "menu_main")],
  ]);
}
function ailabMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧠 Самоанализ AI","menu_analysis"),   Markup.button.callback("📊 Рейтинг рынка","menu_marketrating")],
    [Markup.button.callback("🏆 Стратегии",   "menu_strategies"),  Markup.button.callback("🧪 A/B Тест",    "menu_abtest")],
    [Markup.button.callback("🛡 Защита страт.","menu_stratguard"), Markup.button.callback("⚖️ Веса",        "menu_weights")],
    [Markup.button.callback("🌅 AI Отчёт",    "menu_ailab_full"),  Markup.button.callback("◀️ Главное меню","menu_main")],
  ]);
}
function pairsMenu(action: string, back = "menu_trading") {
  return Markup.inlineKeyboard([
    [Markup.button.callback("₿ BTC",  `${action}_BTCUSDT`),  Markup.button.callback("Ξ ETH",  `${action}_ETHUSDT`),  Markup.button.callback("◎ SOL",  `${action}_SOLUSDT`)],
    [Markup.button.callback("🔶 BNB", `${action}_BNBUSDT`),  Markup.button.callback("✕ XRP",  `${action}_XRPUSDT`),  Markup.button.callback("🐶 DOGE",`${action}_DOGEUSDT`)],
    [Markup.button.callback("🔗 LINK",`${action}_LINKUSDT`), Markup.button.callback("🌊 ADA", `${action}_ADAUSDT`),  Markup.button.callback("🔺 AVAX",`${action}_AVAXUSDT`)],
    [Markup.button.callback("🟣 NEAR",`${action}_NEARUSDT`), Markup.button.callback("🔵 SUI", `${action}_SUIUSDT`),  Markup.button.callback("🅰 APT", `${action}_APTUSDT`)],
    [Markup.button.callback("🔴 OP",  `${action}_OPUSDT`),   Markup.button.callback("🔷 ARB", `${action}_ARBUSDT`),  Markup.button.callback("⚛ ATOM",`${action}_ATOMUSDT`)],
    [Markup.button.callback("⬡ DOT",  `${action}_DOTUSDT`),  Markup.button.callback("🌕 LTC", `${action}_LTCUSDT`),  Markup.button.callback("⚡ TRX", `${action}_TRXUSDT`)],
    [Markup.button.callback("🐸 PEPE",`${action}_PEPEUSDT`), Markup.button.callback("🐕 WIF", `${action}_WIFUSDT`),  Markup.button.callback("🐕 SHIB",`${action}_SHIBUSDT`)],
    [Markup.button.callback("◀️ Назад", back)],
  ]);
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function doSignal(ctx: any, symbol: string, interval: Interval = "1h") {
  const chatId = ctx.chat?.id;
  const loading = await ctx.reply(`⏳ Анализирую *${symbol}* (${interval})...`, { parse_mode: "Markdown" });
  try {
    const sig = await generateSignal(symbol, interval, chatId);
    await ctx.telegram.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(formatSignal(sig), {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("📊 Ещё сигнал","menu_signal"), Markup.button.callback("🏠 Меню","menu_main")]]),
    });
  } catch (err) {
    logger.error({ err }, "Signal error");
    await ctx.telegram.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    await ctx.reply("⚠️ Ошибка при получении данных. Попробуй позже.");
  }
}

async function buildAccountStats(chatId: number): Promise<string> {
  const account = await loadPaperAccount(chatId);
  const trades  = account.closedTrades;
  const wins    = trades.filter(t => t.pnl > 0);
  const losses  = trades.filter(t => t.pnl <= 0);
  const gW      = wins.reduce((a, t) => a + t.pnl, 0);
  const gL      = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf      = gL > 0 ? gW / gL : gW > 0 ? 999 : 0;
  const ret     = ((account.balance - account.initialBalance) / account.initialBalance) * 100;
  const dd      = (account.peakBalance ?? account.balance) > 0
    ? (((account.peakBalance ?? account.balance) - account.balance) / (account.peakBalance ?? account.balance)) * 100
    : 0;
  const now  = Date.now();
  const pnlD = trades.filter(t => now - new Date(t.closedAt).getTime() < 86_400_000).reduce((a, t) => a + t.pnl, 0);
  const pnlW = trades.filter(t => now - new Date(t.closedAt).getTime() < 604_800_000).reduce((a, t) => a + t.pnl, 0);
  const pnlM = trades.filter(t => now - new Date(t.closedAt).getTime() < 2_592_000_000).reduce((a, t) => a + t.pnl, 0);
  const posLines = account.positions.length === 0
    ? ["  нет открытых позиций"]
    : account.positions.map(p => {
        const dir = p.direction === "LONG" ? "🟢" : "🔴";
        const be  = p.breakevenMoved ? " [BE✓]" : "";
        return `  ${dir} ${p.symbol} @ ${formatPrice(p.entryPrice)}${be}`;
      });
  return [
    `💰 *Виртуальный счёт*`, "",
    `Баланс: *$${account.balance.toFixed(2)}*`,
    `${ret >= 0 ? "📈" : "📉"} P&L: ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`,
    `📉 Просадка от пика: ${dd.toFixed(2)}%`, "",
    `📊 Сделок: ${trades.length} | WR: ${trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0}%`,
    `Profit Factor: ${pf === 999 ? "∞" : pf.toFixed(2)}`, "",
    `📅 Сегодня: ${pnlD >= 0 ? "+" : ""}$${pnlD.toFixed(2)}`,
    `📆 Неделя: ${pnlW >= 0 ? "+" : ""}$${pnlW.toFixed(2)}`,
    `🗓 Месяц: ${pnlM >= 0 ? "+" : ""}$${pnlM.toFixed(2)}`, "",
    `📂 Открытых (${account.positions.length}/10):`,
    ...posLines,
  ].join("\n");
}

async function buildTopSignals(chatId: number): Promise<string> {
  const journal = await loadJournal();
  const mine    = journal.filter(e => e.chatId === chatId && e.closedAt && (e.pnlPercent ?? 0) > 0);
  const top10   = mine.sort((a, b) => (b.confidence ?? b.score) - (a.confidence ?? a.score)).slice(0, 10);
  if (!top10.length) return "📊 Нет закрытых прибыльных сделок пока.";
  const lines = top10.map((e, i) => {
    const dir = e.direction === "LONG" ? "🟢" : "🔴";
    const pnl = (e.pnlPercent ?? 0) >= 0 ? `+${(e.pnlPercent ?? 0).toFixed(2)}%` : `${(e.pnlPercent ?? 0).toFixed(2)}%`;
    return `${i + 1}. ${dir} *${e.symbol}* | Score ${e.score} | Conf ${e.confidence ?? "—"} | ${pnl}`;
  });
  return [`🏆 *ТОП-10 лучших сигналов*`, `_Сортировка по Confidence_`, "", ...lines].join("\n");
}

async function buildReport(chatId: number): Promise<string> {
  const [journal, account, weights] = await Promise.all([loadJournal(), loadPaperAccount(chatId), loadWeights()]);
  const subs   = listSubscriptions(chatId);
  const mine   = journal.filter(e => e.chatId === chatId);
  const closed = mine.filter(e => e.closedAt);
  const wins   = closed.filter(e => (e.pnlPercent ?? 0) > 0);
  const wr     = closed.length ? (wins.length / closed.length) * 100 : 0;
  const pRet   = ((account.balance - account.initialBalance) / account.initialBalance) * 100;
  const pPnl   = account.closedTrades.reduce((a, t) => a + t.pnl, 0);
  return [
    `🌅 *Итоговый отчёт*`, "",
    `📡 *Подписки:* ${subs.length}`,
    subs.length ? subs.map(s => `  • ${s.symbol} ${s.interval}`).join("\n") : "  нет подписок", "",
    `📊 *Сигналы:* ${mine.length} | закрыто ${closed.length} | открыто ${mine.filter(e => !e.closedAt).length}`,
    closed.length ? `  WR: ${wr.toFixed(1)}%` : "  Ждём закрытых сигналов", "",
    `💼 *Счёт:* $${account.balance.toFixed(2)} (${pRet >= 0 ? "+" : ""}${pRet.toFixed(2)}%)`,
    account.closedTrades.length ? `  Сделок: ${account.closedTrades.length} | P&L: ${pPnl >= 0 ? "+" : ""}$${pPnl.toFixed(2)}` : "  Сделок пока нет", "",
    `🧠 *Веса:* тренд ${(weights.trend * 100).toFixed(0)}% | объём ${(weights.volume * 100).toFixed(0)}% | импульс ${(weights.momentum * 100).toFixed(0)}%`,
    "", `⚠️ _Виртуальный счёт._`,
  ].join("\n");
}

async function buildAILabReport(chatId: number): Promise<string> {
  const [stats, abVariants, weights, , journal] = await Promise.all([
    loadStrategyStats(), loadABVariants(), loadWeights(), loadPaperAccount(chatId), loadJournal(),
  ]);
  const mine  = journal.filter(e => e.chatId === chatId && e.closedAt);
  const wins  = mine.filter(e => (e.pnlPercent ?? 0) > 0);
  const bySym: Record<string, { wins: number; total: number; pnl: number }> = {};
  for (const e of mine) {
    if (!bySym[e.symbol]) bySym[e.symbol] = { wins: 0, total: 0, pnl: 0 };
    bySym[e.symbol]!.total++;
    bySym[e.symbol]!.pnl += e.pnlPercent ?? 0;
    if ((e.pnlPercent ?? 0) > 0) bySym[e.symbol]!.wins++;
  }
  const symsSorted   = Object.entries(bySym).sort(([, a], [, b]) => b.pnl - a.pnl);
  const bestSymbols  = symsSorted.slice(0, 3).map(([s, v]) => `  ✅ ${s}: WR ${(v.wins / v.total * 100).toFixed(0)}% | avg ${(v.pnl / v.total).toFixed(2)}%`);
  const worstSymbols = symsSorted.slice(-3).reverse().map(([s, v]) => `  ❌ ${s}: WR ${(v.wins / v.total * 100).toFixed(0)}% | avg ${(v.pnl / v.total).toFixed(2)}%`);
  const champion  = abVariants.find(v => v.isChampion);
  const bestStrat = [...stats].sort((a, b) => b.profitFactor - a.profitFactor)[0];
  return [
    `🧠 *AI Лаборатория — полный отчёт*`, "",
    mine.length >= 10
      ? `📊 ${mine.length} сделок | WR: ${(wins.length / mine.length * 100).toFixed(1)}%`
      : `📊 Собираю данные (${mine.length} из 10)`, "",
    `*Лучшая стратегия:* ${bestStrat && bestStrat.trades > 0 ? `✅ ${bestStrat.strategy} | PF ${bestStrat.profitFactor.toFixed(2)}` : "нет данных"}`,
    `*Чемпион A/B:* ${champion ? `👑 ${champion.name}` : "определяется..."}`, "",
    `*Лучшие инструменты:*`, ...(bestSymbols.length ? bestSymbols : ["  Нет данных"]), "",
    `*Слабые инструменты:*`, ...(worstSymbols.length ? worstSymbols : ["  Нет данных"]), "",
    `*Веса факторов:*`,
    `  Тренд ${(weights.trend*100).toFixed(0)}% | Объём ${(weights.volume*100).toFixed(0)}% | Импульс ${(weights.momentum*100).toFixed(0)}% | Уровни ${(weights.levels*100).toFixed(0)}% | Паттерн ${(weights.pattern*100).toFixed(0)}%`,
  ].join("\n");
}

// ── Bot factory ────────────────────────────────────────────────────────────
export function createBot(): Telegraf {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const name = ctx.from?.first_name ?? "трейдер";
    await ctx.reply(
      `👋 Привет, *${name}*!\n\nАвтономный AI-трейдер на виртуальном счёте.\n\n` +
      `🔍 4 стратегии: тренд, пробой, импульс, возврат к среднему\n` +
      `🧠 Gemini AI + Confidence Engine\n📊 Рейтинг рынка 0–100\n💰 Виртуальный депозит $10,000\n` +
      `🧪 A/B тестирование стратегий\n🛡 Риск-менеджмент + защита от деградации\n\n` +
      `_Реальная торговля отключена на этом этапе._`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Запустить автоторговлю","onboard_start")],
        [Markup.button.callback("📖 Как это работает?","onboard_how")],
      ]) }
    );
  });

  bot.action("onboard_how", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `📖 *Как работает бот?*\n\n` +
      `1️⃣ 4 независимые стратегии соревнуются между собой\n` +
      `2️⃣ Score /100 — оценка по 6 факторам\n` +
      `3️⃣ Confidence % — качество условий (рынок + история + стратегия)\n` +
      `4️⃣ Рейтинг рынка 0–100 — "сильный рост" → "волатильность"\n` +
      `5️⃣ A/B тест — 3 варианта весов, лучший побеждает автоматически\n` +
      `6️⃣ Самообучение — веса пересчитываются каждые 100 сделок\n` +
      `7️⃣ Риск-лимиты — стоп после -3%/день или 3 убытков подряд`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🚀 Запустить!","onboard_start")]]) }
    );
  });

  bot.action("onboard_start", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const s = await loadSettings(chatId);
    s.autoPaperTrade = true;
    await saveSettings(chatId, s);
    for (const { symbol, interval } of AUTO_PAIRS) subscribe(chatId, symbol, interval);
    await ctx.reply(
      `✅ *Автоторговля запущена!*\n\nСлежу за *21 монетой* в реальном времени\n` +
      `🧪 3 стратегии A/B соревнуются\n🛡 Лимиты: -3%/день, 3 убытка подряд\n_Бот работает 24/7_ 😴`,
      { parse_mode: "Markdown", ...mainMenu() }
    );
  });

  // Navigation
  bot.action("menu_main",      async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("Главное меню:", mainMenu()); });
  bot.action("menu_trading",   async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("🚀 *Торговля*", { parse_mode:"Markdown", ...tradingMenu() }); });
  bot.action("menu_analytics", async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("📈 *Аналитика*", { parse_mode:"Markdown", ...analyticsMenu() }); });
  bot.action("menu_account",   async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(await buildAccountStats(ctx.chat!.id), { parse_mode:"Markdown", ...accountMenu() }); });
  bot.action("menu_ailab",     async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("🧠 *AI Лаборатория*", { parse_mode:"Markdown", ...ailabMenu() }); });

  // Trading
  bot.action("menu_signal",   async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("📊 *Выбери монету:*", { parse_mode:"Markdown", ...pairsMenu("signal") }); });
  bot.action("menu_backtest", async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("🔬 *Бэктест — выбери монету:*", { parse_mode:"Markdown", ...pairsMenu("bt") }); });

  // Pair buttons
  for (const pair of ALL_PAIRS) {
    bot.action(`signal_${pair}`, async (ctx) => { await ctx.answerCbQuery(); await doSignal(ctx, pair); });

    bot.action(`bt_${pair}`, async (ctx) => {
      await ctx.answerCbQuery();
      const loading = await ctx.reply(`⏳ Бэктест ${pair}...`);
      try {
        const res = await runBacktest(pair, "1h", 500);
        await ctx.telegram.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
        await ctx.reply(res.summary, { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Торговля","menu_trading")]]) });
      } catch {
        await ctx.telegram.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
        await ctx.reply("⚠️ Ошибка бэктеста.");
      }
    });

    bot.action(`subpair_${pair}`, async (ctx) => {
      await ctx.answerCbQuery();
      subscribe(ctx.chat!.id, pair, "1h");
      await ctx.reply(`✅ Подписка *${pair}* добавлена.`, { parse_mode:"Markdown", ...tradingMenu() });
    });

    bot.action(`paperopen_${pair}`, async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const loading = await ctx.reply(`⏳ Анализирую *${pair}*...`, { parse_mode:"Markdown" });
      try {
        const sig = await generateSignal(pair, "1h", chatId);
        await ctx.telegram.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
        if (sig.filtered) { await ctx.reply(`⚠️ ${sig.filterReason}`, { parse_mode:"Markdown", ...accountMenu() }); return; }
        const res = await openPaperPosition(chatId, pair, sig.score.direction, sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2, undefined, sig.risk.atr, sig.bestStrategy?.strategy ?? "TREND");
        await ctx.reply(res.message, { parse_mode:"Markdown", ...accountMenu() });
      } catch {
        await ctx.telegram.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
        await ctx.reply("⚠️ Ошибка анализа.");
      }
    });
  }

  // Subscriptions
  bot.action("menu_subs", async (ctx) => {
    await ctx.answerCbQuery();
    const subs = listSubscriptions(ctx.chat!.id);
    const text = subs.length ? `📡 *Подписки (${subs.length}):*\n\n` + subs.map(s => `• ${s.symbol} ${s.interval}`).join("\n") : "📡 Нет активных подписок.";
    await ctx.reply(text, { parse_mode:"Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("➕ Добавить","sub_add"), Markup.button.callback("🗑 Убрать все","unsub_all")],
      [Markup.button.callback("◀️ Торговля","menu_trading")],
    ]) });
  });
  bot.action("sub_add",   async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("Выбери монету:", pairsMenu("subpair","menu_subs")); });
  bot.action("unsub_all", async (ctx) => { await ctx.answerCbQuery(); unsubscribeAll(ctx.chat!.id); await ctx.reply("✅ Все подписки удалены.", mainMenu()); });

  // Analytics
  bot.action("menu_journal",    async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(await getJournalStats(), { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Аналитика","menu_analytics")]]) }); });
  bot.action("menu_report",     async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(await buildReport(ctx.chat!.id), { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Аналитика","menu_analytics")]]) }); });
  bot.action("menu_topsignals", async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(await buildTopSignals(ctx.chat!.id), { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Аналитика","menu_analytics")]]) }); });
  bot.action("menu_missed",     async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(await getMissedStats(), { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Аналитика","menu_analytics")]]) }); });

  // Account
  bot.action("menu_paper",     async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(await buildAccountStats(ctx.chat!.id), { parse_mode:"Markdown", ...accountMenu() }); });
  bot.action("menu_paperopen", async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("💼 *Открыть сделку:*", { parse_mode:"Markdown", ...pairsMenu("paperopen","menu_account") }); });

  bot.action("papercheck", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const msgs = await checkPaperPositions(chatId);
    if (!msgs.length) {
      const acc = await loadPaperAccount(chatId);
      await ctx.reply(acc.positions.length ? `✅ ${acc.positions.length} позиций открыты — TP/SL не достигнуты.` : "ℹ️ Нет открытых позиций.");
    } else {
      for (const m of msgs) await ctx.reply(m, { parse_mode:"Markdown" });
    }
  });
  bot.action("paperreset_confirm", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("⚠️ Сбросить счёт до $10,000?",
      Markup.inlineKeyboard([[Markup.button.callback("✅ Да","paperreset_do"), Markup.button.callback("❌ Отмена","menu_account")]]));
  });
  bot.action("paperreset_do", async (ctx) => {
    await ctx.answerCbQuery();
    const { savePaperAccount } = await import("./storage.js");
    await savePaperAccount(ctx.chat!.id, { balance:10000, initialBalance:10000, peakBalance:10000, positions:[], closedTrades:[] });
    await ctx.reply("✅ Счёт сброшен до $10,000", mainMenu());
  });

  // AI Lab
  bot.action("menu_analysis", async (ctx) => {
    await ctx.answerCbQuery();
    const loading = await ctx.reply("⏳ Анализирую сделки...");
    const analysis = await buildSelfAnalysis(ctx.chat!.id);
    await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
    await ctx.reply(analysis, { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ AI Lab","menu_ailab")]]) });
  });

  bot.action("menu_marketrating", async (ctx) => {
    await ctx.answerCbQuery();
    const loading = await ctx.reply("⏳ Анализирую рынок...");
    try {
      const { getCandles } = await import("./binance.js");
      const { calcIndicators } = await import("./indicators.js");
      const { assessMarket } = await import("./chaos-filter.js");
      const candles = await getCandles("BTCUSDT","1h",200);
      const ind = calcIndicators(candles);
      const market = assessMarket(candles, ind);
      const rating = calcMarketRating(ind, market, candles);
      await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
      await ctx.reply(`📊 *Рейтинг рынка* (BTC 1h)\n\n` + formatMarketRating(rating),
        { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ AI Lab","menu_ailab")]]) });
    } catch {
      await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
      await ctx.reply("⚠️ Ошибка получения данных рынка.");
    }
  });

  bot.action("menu_strategies", async (ctx) => {
    await ctx.answerCbQuery();
    const stats = await loadStrategyStats();
    await ctx.reply(formatStrategyStats(stats), { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ AI Lab","menu_ailab")]]) });
  });

  bot.action("menu_abtest", async (ctx) => {
    await ctx.answerCbQuery();
    const variants = await loadABVariants();
    await ctx.reply(formatABReport(variants), { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ AI Lab","menu_ailab")]]) });
  });

  bot.action("menu_stratguard", async (ctx) => {
    await ctx.answerCbQuery();
    const status = await getStrategyStatus();
    await ctx.reply(status, { parse_mode:"Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("📸 Снимок стратегии","stratsnap")],
      [Markup.button.callback("◀️ AI Lab","menu_ailab")],
    ]) });
  });
  bot.action("stratsnap", async (ctx) => {
    await ctx.answerCbQuery();
    await snapshotStrategy();
    await ctx.reply("✅ Снимок стратегии сохранён.", Markup.inlineKeyboard([[Markup.button.callback("◀️ AI Lab","menu_ailab")]]));
  });

  bot.action("menu_weights", async (ctx) => {
    await ctx.answerCbQuery();
    const w = await loadWeights();
    await ctx.reply(
      `⚖️ *Текущие веса факторов:*\n\n` +
      `📈 Тренд: ${(w.trend*100).toFixed(1)}%\n📊 Объём: ${(w.volume*100).toFixed(1)}%\n` +
      `⚡ Импульс: ${(w.momentum*100).toFixed(1)}%\n🎯 Уровни: ${(w.levels*100).toFixed(1)}%\n` +
      `🔷 Паттерн: ${(w.pattern*100).toFixed(1)}%\n\n_Обновляются автоматически каждые 100 сделок._`,
      { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ AI Lab","menu_ailab")]]) }
    );
  });

  bot.action("menu_ailab_full", async (ctx) => {
    await ctx.answerCbQuery();
    const loading = await ctx.reply("⏳ Составляю AI-отчёт...");
    const report  = await buildAILabReport(ctx.chat!.id);
    await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
    await ctx.reply(report, { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ AI Lab","menu_ailab")]]) });
  });

  // Risk
  bot.action("menu_risk", async (ctx) => {
    await ctx.answerCbQuery();
    const status = await getRiskStatus();
    await ctx.reply(status, { parse_mode:"Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("▶️ Возобновить","risk_resume")],
      [Markup.button.callback("◀️ Торговля","menu_trading")],
    ]) });
  });
  bot.action("risk_resume", async (ctx) => {
    await ctx.answerCbQuery();
    await resumeTrading();
    await ctx.reply("✅ *Торговля возобновлена.*", { parse_mode:"Markdown", ...mainMenu() });
  });

  // Settings
  bot.action("menu_settings", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const s    = await loadSettings(chatId);
    const subs = listSubscriptions(chatId);
    await ctx.reply(
      `⚙️ *Настройки*\n\n` +
      `🤖 Авто-сделки: *${s.autoPaperTrade ? "ВКЛ ✅" : "ВЫКЛ ❌"}*\n` +
      `🎯 Мин. оценка: *${s.minScore}/100*\n` +
      `⚖️ Риск/сделку: *${s.riskPercent}%*\n💰 Счёт: *$${s.accountSize}*\n` +
      `🚫 Не торговать: *${s.noTradeMode ? "ВКЛ" : "ВЫКЛ"}*\n📡 Подписок: *${subs.length}*`,
      { parse_mode:"Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback(s.autoPaperTrade ? "🤖 Авто-сделки ✅":"🤖 Авто-сделки ❌","toggle_autopaper")],
        [Markup.button.callback(s.noTradeMode ? "🚫 Не торговать: ВКЛ":"✅ Торговать: ВКЛ","toggle_notrade")],
        [Markup.button.callback("📡 Подписки","menu_subs"), Markup.button.callback("🗑 Отключить всё","unsub_all")],
        [Markup.button.callback("🏠 Главное меню","menu_main")],
      ]) }
    );
  });
  bot.action("toggle_autopaper", async (ctx) => {
    await ctx.answerCbQuery();
    const s = await loadSettings(ctx.chat!.id);
    s.autoPaperTrade = !s.autoPaperTrade;
    await saveSettings(ctx.chat!.id, s);
    await ctx.reply(s.autoPaperTrade ? "🤖 Авто-сделки *включены*." : "❌ Авто-сделки *выключены*.", { parse_mode:"Markdown", ...mainMenu() });
  });
  bot.action("toggle_notrade", async (ctx) => {
    await ctx.answerCbQuery();
    const s = await loadSettings(ctx.chat!.id);
    s.noTradeMode = !s.noTradeMode;
    await saveSettings(ctx.chat!.id, s);
    await ctx.reply(s.noTradeMode ? "🚫 Режим 'не торговать' включён." : "✅ Торговля разрешена.", { parse_mode:"Markdown", ...mainMenu() });
  });

  // Help
  bot.action("menu_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `❓ *Помощь*\n\n` +
      `🚀 *Торговля* — сигналы, подписки, риски, бэктест\n` +
      `📈 *Аналитика* — журнал, отчёты, ТОП-10, упущенные\n` +
      `💰 *Виртуальный счёт* — баланс, P&L, позиции\n` +
      `🧠 *AI Лаборатория* — самоанализ, стратегии, A/B тест, рейтинг рынка\n` +
      `⚙️ *Настройки* — авто-торговля, риск, подписки\n\n` +
      `*Критерии для реальной торговли:*\n` +
      `• 1000+ виртуальных сделок | 90+ дней | PF ≥ 1.3 | просадка < 15%`,
      { parse_mode:"Markdown", ...mainMenu() }
    );
  });

  // /scan — live diagnosis of all 21 pairs
  bot.command("scan", async (ctx) => {
    const chatId = ctx.chat.id;
    const subs   = listSubscriptions(chatId);
    const settings = await loadSettings(chatId);

    if (subs.length === 0) {
      await ctx.reply(
        `⚠️ *Нет активных подписок!*\n\nНажми /start → 🚀 Запустить автоторговлю`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (!settings.autoPaperTrade) {
      await ctx.reply(`⚠️ Авто-торговля выключена! Зайди в ⚙️ Настройки → включи.`, { parse_mode: "Markdown" });
      return;
    }

    const msg = await ctx.reply(`🔍 Сканирую ${AUTO_PAIRS.length} монет... (~30 сек)`, { parse_mode: "Markdown" });

    const results: string[] = [];
    let tradeable = 0;

    for (const { symbol, interval } of AUTO_PAIRS.slice(0, 10)) {
      try {
        const sig = await generateSignal(symbol, interval, chatId);
        const score = sig.score.total;
        const dir   = sig.score.direction;
        const conf  = sig.confidence.score;
        let status: string;
        if (sig.market.isChaotic)         status = `🌪 Хаос`;
        else if (dir === "NEUTRAL")        status = `⚪ Нейтраль`;
        else if (score < 48)               status = `📉 Score ${score}<48`;
        else if (conf < 20)                status = `🔴 Conf ${conf}%<20`;
        else { status = `✅ ${dir} Score ${score} Conf ${conf}%`; tradeable++; }
        results.push(`${symbol}: ${status}`);
      } catch {
        results.push(`${symbol}: ❌ ошибка`);
      }
    }

    await ctx.telegram.editMessageText(chatId, msg.message_id, undefined,
      `🔍 *Скан рынка (топ-10 монет)*\n\n` +
      results.join("\n") + `\n\n` +
      `✅ Готовы к сделке: *${tradeable}*\n` +
      `📡 Подписок: ${subs.length} | Авто: ${settings.autoPaperTrade ? "ВКЛ" : "ВЫКЛ"}\n` +
      `_Сделка откроется при закрытии следующей свечи_`,
      { parse_mode: "Markdown" }
    );
  });

  // /status — quick bot status
  bot.command("status", async (ctx) => {
    const chatId  = ctx.chat.id;
    const subs    = listSubscriptions(chatId);
    const s       = await loadSettings(chatId);
    const account = await loadPaperAccount(chatId);
    const ret = ((account.balance - account.initialBalance) / account.initialBalance * 100).toFixed(2);
    await ctx.reply(
      `📊 *Статус бота*\n\n` +
      `📡 Подписок: *${subs.length}* монет\n` +
      `🤖 Авто-торговля: *${s.autoPaperTrade ? "ВКЛ ✅" : "ВЫКЛ ❌"}*\n` +
      `📂 Открыто позиций: *${account.positions.length}/10*\n` +
      `💰 Баланс: *$${account.balance.toFixed(2)}* (${Number(ret) >= 0 ? "+" : ""}${ret}%)\n\n` +
      (subs.length === 0
        ? `⚠️ Нажми /start → 🚀 Запустить автоторговлю`
        : `🟢 Бот активен, жду сигнал ≥48/100`),
      { parse_mode: "Markdown", ...mainMenu() }
    );
  });

  // Text fallback
  bot.on("text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/signal ")) {
      const parts = text.split(" ");
      const sym = parts[1]?.toUpperCase();
      if (sym) await doSignal(ctx, sym, (parts[2] as Interval) || "1h");
    } else { await ctx.reply("Используй кнопки меню:", mainMenu()); }
  });

  return bot;
}

export function startBot(): void {
  const bot = createBot();
  initABVariants().catch(err => logger.error({ err }, "initABVariants failed"));
  startScheduler(bot);
  bot.launch().catch(err => logger.error({ err }, "Bot launch error"));
  logger.info("Telegram bot started — TZ Phase 1");
}
