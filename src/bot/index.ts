import { Telegraf, Markup } from "telegraf";
  import { generateSignal, formatSignal } from "./signals.js";
  import { validateSymbol } from "./binance.js";
  import {
    subscribe, unsubscribe, unsubscribeAll,
    listSubscriptions, startScheduler,
  } from "./scheduler.js";
  import { checkPaperPositions } from "./paper-trading.js";
  import {
    loadSettings, saveSettings, loadPaperAccount, loadWeights,
  } from "./storage.js";
  import { buildSelfAnalysis } from "./self-analysis.js";
  import { resumeTrading } from "./risk-manager.js";
  import { loadStrategyStats, formatStrategyStats } from "./strategies.js";
  import { initABVariants } from "./ab-testing.js";
  import { calcMarketRating, formatMarketRating } from "./market-rating.js";
  import { formatPrice } from "./risk.js";
  import { logger } from "../lib/logger.js";
  import type { Interval } from "./binance.js";
  import {
    getAllStrategyStatuses, getLearningHistory, generateLearningReport,
    getStrategyEvolutionHistory, detectMarketRegime,
  } from "./learning-engine.js";
  import { getTimeAnalytics } from "./time-analytics.js";
  import { getInstrumentAnalytics } from "./instrument-analytics.js";
  import { loadFeatureImportance, formatFeatureImportance } from "./feature-importance.js";
  import { getResearchHistory } from "./ai-researcher.js";
  import { getSimilarTradesStats } from "./similar-trades.js";

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
    const dashUrl = process.env["DASHBOARD_URL"];
    const rows: Parameters<typeof Markup.inlineKeyboard>[0] = [
      [Markup.button.callback("📂 Позиции",   "menu_positions"),
       Markup.button.callback("💰 Счёт",      "menu_account")],
      [Markup.button.callback("📊 Сигнал",    "menu_signal"),
       Markup.button.callback("🧠 Анализ",    "menu_analysis")],
      [Markup.button.callback("⚙️ Настройки", "menu_settings")],
    ];
    if (dashUrl) {
      rows.push([Markup.button.url("🖥 Live Дашборд", dashUrl)]);
    }
    return Markup.inlineKeyboard(rows);
  }
  function accountMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Обновить",  "menu_account"),
       Markup.button.callback("🗑 Сбросить",  "paperreset_confirm")],
      [Markup.button.callback("◀️ Меню",      "menu_main")],
    ]);
  }
  function analysisMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback("📊 Рейтинг рынка", "menu_marketrating"),
       Markup.button.callback("🏆 Стратегии",     "menu_strategies")],
      [Markup.button.callback("🔬 Важность факторов", "menu_feature_importance"),
       Markup.button.callback("🔭 AI Исследования",   "menu_ai_research")],
      [Markup.button.callback("📡 Похожие сделки",   "menu_similar_trades")],
      [Markup.button.callback("◀️ Меню",              "menu_main")],
    ]);
  }
  function pairsMenu(action: string, back = "menu_main") {
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
    // Compare against calendar boundaries, not rolling windows.
      // Rolling 86_400_000 ms doesn't reset at midnight — trades from 23:00
      // yesterday still appear as "today" at 09:00 today.
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const weekStart  = new Date(todayStart);
      weekStart.setDate(todayStart.getDate() - ((todayStart.getDay() + 6) % 7)); // Monday
      const pnlD = trades.filter(t => new Date(t.closedAt) >= todayStart).reduce((a, t) => a + t.pnl, 0);
      const pnlW = trades.filter(t => new Date(t.closedAt) >= weekStart).reduce((a, t) => a + t.pnl, 0);
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
      `📆 Неделя: ${pnlW >= 0 ? "+" : ""}$${pnlW.toFixed(2)}`, "",
      `📂 Открытых (${account.positions.length}/10):`,
      ...posLines,
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
        `🧠 Gemini AI + динамический порог по рынку\n💰 Виртуальный депозит $10,000\n\n` +
        `_Реальная торговля отключена на этом этапе._`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([
          [Markup.button.callback("🚀 Запустить автоторговлю","onboard_start")],
        ]) }
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
        `🧠 Динамический порог по активности рынка\n_Бот работает 24/7_ 😴`,
        { parse_mode: "Markdown", ...mainMenu() }
      );
    });

    // ── Navigation ─────────────────────────────────────────────────────────
    bot.action("menu_main", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply("Главное меню:", mainMenu());
    });

    // ── Сигнал ─────────────────────────────────────────────────────────────
    bot.action("menu_signal", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply("📊 *Выбери монету:*", { parse_mode:"Markdown", ...pairsMenu("signal") });
    });

    for (const pair of ALL_PAIRS) {
      bot.action(`signal_${pair}`, async (ctx) => { await ctx.answerCbQuery(); await doSignal(ctx, pair); });

      bot.action(`subpair_${pair}`, async (ctx) => {
        await ctx.answerCbQuery();
        subscribe(ctx.chat!.id, pair, "1h");
        await ctx.reply(`✅ Подписка *${pair}* добавлена.`, { parse_mode:"Markdown", ...mainMenu() });
      });
    }

    // ── Позиции ────────────────────────────────────────────────────────────
    bot.action("menu_positions", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId  = ctx.chat!.id;
      const account = await loadPaperAccount(chatId);
      const posMenu = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Обновить", "menu_positions"),
         Markup.button.callback("◀️ Меню",     "menu_main")],
      ]);

      if (account.positions.length === 0) {
        await ctx.reply(
          `📂 *Открытых позиций нет*\n\n_Бот следит за 21 монетой и откроет сделку при сигнале._`,
          { parse_mode: "Markdown", ...posMenu }
        );
        return;
      }

      const { getPrice } = await import("./binance.js");
      const lines: string[] = [`📂 *Позиции (${account.positions.length}/10)*\n`];

      for (const pos of account.positions) {
        const dir = pos.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
        const be  = pos.breakevenMoved ? " \\[BE✓\\]" : "";
        try {
          const price  = await getPrice(pos.symbol);
          const pnl    = pos.direction === "LONG"
            ? (price - pos.entryPrice) * pos.size
            : (pos.entryPrice - price) * pos.size;
          const pnlPct = pos.direction === "LONG"
            ? ((price - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - price) / pos.entryPrice) * 100;
          const pnlSign = pnl >= 0 ? "+" : "";
          const pnlIcon = pnl >= 0 ? "📈" : "📉";
          lines.push(
            `${dir} *${pos.symbol}*${be}\n` +
            `Вход: \`${formatPrice(pos.entryPrice)}\` → Сейчас: \`${formatPrice(price)}\`\n` +
            `${pnlIcon} P&L: *${pnlSign}${pnl.toFixed(2)}* (${pnlSign}${pnlPct.toFixed(2)}%)\n` +
            `SL: \`${formatPrice(pos.stopLoss)}\` | TP1: \`${formatPrice(pos.tp1)}\``
          );
        } catch {
          lines.push(
            `${dir} *${pos.symbol}*${be}\n` +
            `Вход: \`${formatPrice(pos.entryPrice)}\`\n` +
            `SL: \`${formatPrice(pos.stopLoss)}\` | TP1: \`${formatPrice(pos.tp1)}\``
          );
        }
      }

      const ret = ((account.balance - account.initialBalance) / account.initialBalance * 100);
      lines.push(`\n💰 Баланс: *${account.balance.toFixed(2)}* (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%)`);

      await ctx.reply(lines.join("\n\n"), { parse_mode: "Markdown", ...posMenu });
    });

    // ── Счёт ───────────────────────────────────────────────────────────────
    bot.action("menu_account", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply(await buildAccountStats(ctx.chat!.id), { parse_mode:"Markdown", ...accountMenu() });
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

    // ── Анализ ─────────────────────────────────────────────────────────────
    bot.action("menu_analysis", async (ctx) => {
      await ctx.answerCbQuery();
      const loading = await ctx.reply("⏳ Анализирую сделки...");
      const analysis = await buildSelfAnalysis(ctx.chat!.id);
      await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
      await ctx.reply(analysis, { parse_mode:"Markdown", ...analysisMenu() });
    });

    bot.action("menu_learning", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Загружаю историю обучения...");
        try {
          const history = await getLearningHistory();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(history, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Анализ","menu_analysis")]]) });
        } catch { await ctx.reply("❌ Ошибка загрузки истории"); }
      });
      bot.action("menu_aireport", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Генерирую AI отчёт...");
        try {
          const report = await generateLearningReport();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(report, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Анализ","menu_analysis")]]) });
        } catch { await ctx.reply("❌ Ошибка генерации отчёта"); }
      });
      bot.action("menu_timeanalytics", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Считаю статистику по времени...");
        try {
          const stats = await getTimeAnalytics();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(stats, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Анализ","menu_analysis")]]) });
        } catch { await ctx.reply("❌ Ошибка загрузки аналитики"); }
      });
      bot.action("menu_instruments", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Загружаю аналитику по инструментам...");
        try {
          const stats = await getInstrumentAnalytics();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(stats, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Анализ","menu_analysis")]]) });
        } catch { await ctx.reply("❌ Ошибка загрузки аналитики"); }
      });

      // ── AI Learning Engine v3 handlers ─────────────────────────────────────
      bot.action("menu_feature_importance", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Вычисляю влияние факторов...");
        try {
          const importances = await loadFeatureImportance();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          const text = formatFeatureImportance(importances);
          await ctx.reply(text, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Анализ","menu_analysis")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка загрузки данных о факторах");
        }
      });

      bot.action("menu_ai_research", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Загружаю историю AI-исследований...");
        try {
          const history = await getResearchHistory();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(history, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Анализ","menu_analysis")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка загрузки исследований");
        }
      });

      bot.action("menu_similar_trades", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Загружаю статистику похожих сделок...");
        try {
          const stats = await getSimilarTradesStats();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(stats, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Анализ","menu_analysis")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка загрузки данных");
        }
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
          { parse_mode:"Markdown", ...analysisMenu() });
      } catch {
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply("⚠️ Ошибка получения данных рынка.");
      }
    });

    bot.action("menu_strategies", async (ctx) => {
      await ctx.answerCbQuery();
      const loading = await ctx.reply("⏳ Загружаю статус стратегий...");
      try {
        // Detect current regime from BTC 1h
        const { getCandles } = await import("./binance.js");
        const { calcIndicators } = await import("./indicators.js");
        const { assessMarket } = await import("./chaos-filter.js");
        const candles = await getCandles("BTCUSDT","1h",200);
        const ind = calcIndicators(candles);
        const market = assessMarket(candles, ind);
        const rating = calcMarketRating(ind, market, candles);
        const regime = detectMarketRegime(market, rating);

        const statuses = await getAllStrategyStatuses(regime);
        const regimeLabels: Record<string,string> = {
          trend_up:"📈 Тренд↑",trend_down:"📉 Тренд↓",
          sideways:"↔️ Боковик",high_vol:"⚡ Волат.",low_vol:"😴 Затишье",
        };
        const statusIcon: Record<string,string> = {active:"✅",quarantine:"⚠️",disabled:"🚫"};
        const statusLabel: Record<string,string> = {active:"Активна",quarantine:"Карантин",disabled:"Shadow"};

        const lines = [
          `🏆 *Стратегии* | Режим: ${regimeLabels[regime] ?? regime}`,
          "",
        ];
        for (const s of statuses) {
          const icon = statusIcon[s.status] ?? "✅";
          const sl   = statusLabel[s.status] ?? s.status;
          const pf   = s.profitFactor >= 99 ? "∞" : s.profitFactor.toFixed(2);
          const wr   = (s.winRate * 100).toFixed(1);
          const sampleNote = s.trades < 30 ? " ⚠️" : "";
          lines.push(
            `${icon} *${s.strategy}* — ${sl}${sampleNote}\n` +
            `  Trust: ${s.trustScore}/100 | Вес: ${(s.weight*100).toFixed(0)}%\n` +
            `  WR: ${wr}% | PF: ${pf} | Сд: ${s.trades}`
          );
        }
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply(lines.join("\n"), {
          parse_mode:"Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📈 История изменений","menu_strat_history")],
            [Markup.button.callback("◀️ Анализ","menu_analysis")],
          ]),
        });
      } catch {
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        const stats = await loadStrategyStats();
        await ctx.reply(formatStrategyStats(stats), { parse_mode:"Markdown", ...analysisMenu() });
      }
    });

    bot.action("menu_strat_history", async (ctx) => {
      await ctx.answerCbQuery();
      const loading = await ctx.reply("⏳ Загружаю историю...");
      try {
        const history = await getStrategyEvolutionHistory();
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply(history, {
          parse_mode:"Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Стратегии","menu_strategies")]]),
        });
      } catch {
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply("❌ Ошибка загрузки истории изменений");
      }
    });

    // ── Настройки ──────────────────────────────────────────────────────────
    bot.action("menu_settings", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const s    = await loadSettings(chatId);
      const subs = listSubscriptions(chatId);
      await ctx.reply(
        `⚙️ *Настройки*\n\n` +
        `🤖 Авто-сделки: *${s.autoPaperTrade ? "ВКЛ ✅" : "ВЫКЛ ❌"}*\n` +
        `⚖️ Риск/сделку: *${s.riskPercent}%*\n` +
        `📡 Подписок: *${subs.length}*`,
        { parse_mode:"Markdown", ...Markup.inlineKeyboard([
          [Markup.button.callback(s.autoPaperTrade ? "🤖 Авто-сделки ✅" : "🤖 Авто-сделки ❌","toggle_autopaper")],
          [Markup.button.callback("📡 Подписки","menu_subs"), Markup.button.callback("🗑 Отписаться от всех","unsub_all")],
          [Markup.button.callback("◀️ Меню","menu_main")],
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

    bot.action("menu_subs", async (ctx) => {
      await ctx.answerCbQuery();
      const subs = listSubscriptions(ctx.chat!.id);
      const text = subs.length
        ? `📡 *Подписки (${subs.length}):*\n\n` + subs.map(s => `• ${s.symbol} ${s.interval}`).join("\n")
        : "📡 Нет активных подписок.";
      await ctx.reply(text, { parse_mode:"Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ Добавить","sub_add"), Markup.button.callback("🗑 Убрать все","unsub_all")],
        [Markup.button.callback("◀️ Настройки","menu_settings")],
      ]) });
    });
    bot.action("sub_add",   async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("Выбери монету:", pairsMenu("subpair","menu_subs")); });
    bot.action("unsub_all", async (ctx) => { await ctx.answerCbQuery(); unsubscribeAll(ctx.chat!.id); await ctx.reply("✅ Все подписки удалены.", mainMenu()); });
    bot.action("risk_resume", async (ctx) => { await ctx.answerCbQuery(); await resumeTrading(); await ctx.reply("✅ *Торговля возобновлена.*", { parse_mode:"Markdown", ...mainMenu() }); });

    // ── /scan ──────────────────────────────────────────────────────────────
    bot.command("scan", async (ctx) => {
      const chatId   = ctx.chat.id;
      const subs     = listSubscriptions(chatId);
      const settings = await loadSettings(chatId);
      if (subs.length === 0) { await ctx.reply("⚠️ Нет активных подписок! Нажми /start → 🚀 Запустить", { parse_mode:"Markdown" }); return; }
      if (!settings.autoPaperTrade) { await ctx.reply("⚠️ Авто-торговля выключена! Зайди в ⚙️ Настройки.", { parse_mode:"Markdown" }); return; }
      const msg = await ctx.reply(`🔍 Сканирую ${AUTO_PAIRS.length} монет... (~30 сек)`, { parse_mode:"Markdown" });
      const results: string[] = [];
      let tradeable = 0;
      for (const { symbol, interval } of AUTO_PAIRS.slice(0, 10)) {
        try {
          const sig = await generateSignal(symbol, interval, chatId);
          const score = sig.score.total, dir = sig.score.direction, conf = sig.confidence.score;
          let status: string;
          if (sig.market.isChaotic)  status = "🌪 Хаос";
          else if (dir === "NEUTRAL") status = "⚪ Нейтраль";
          else if (score < 45)       status = `📉 Score ${score}<45`;
          else if (conf < 20)        status = `🔴 Conf ${conf}%<20`;
          else { status = `✅ ${dir} Score ${score} Conf ${conf}%`; tradeable++; }
          results.push(`${symbol}: ${status}`);
        } catch { results.push(`${symbol}: ❌ ошибка`); }
      }
      await ctx.telegram.editMessageText(chatId, msg.message_id, undefined,
        `🔍 *Скан рынка (топ-10 монет)*\n\n` + results.join("\n") +
        `\n\n✅ Готовы к сделке: *${tradeable}*\n_Сделка откроется при закрытии следующей свечи_`,
        { parse_mode:"Markdown" });
    });

    // ── /status ────────────────────────────────────────────────────────────
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
        (subs.length === 0 ? `⚠️ Нажми /start → 🚀 Запустить` : `🟢 Бот активен, жду сигнал`),
        { parse_mode:"Markdown", ...mainMenu() }
      );
    });

    // ── Text fallback ──────────────────────────────────────────────────────
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
    logger.info("Telegram bot started");
  }
  