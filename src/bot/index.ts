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
import { pool } from "../lib/db.js";
  import type { Interval } from "./binance.js";
  import {
    getAllStrategyStatuses, getLearningHistory, generateLearningReport,
    getStrategyEvolutionHistory, detectMarketRegime,
    runAdaptationCycle, snapshotStrategyVersion,
  } from "./learning-engine.js";
import { generateFullReport } from "./full-report.js";
import { generateDailyReport } from "./report-generator.js";
  import { getTimeAnalytics } from "./time-analytics.js";
  import { getInstrumentAnalytics } from "./instrument-analytics.js";
  import { loadFeatureImportance, formatFeatureImportance } from "./feature-importance.js";
  import { getResearchHistory } from "./ai-researcher.js";
  import { getSimilarTradesStats } from "./similar-trades.js";
  import { formatWalkForwardReport, getLatestWalkForwardResults, runWalkForwardTest } from "./walk-forward.js";
  import { testStrategyChange, formatSignificanceReport } from "./stat-significance.js";
  import { detectMarketDrift, formatDriftReport } from "./market-drift.js";
  import { getPortfolioCorrelationReport } from "./correlation-risk.js";
  import { checkLearningHealth, formatHealthReport } from "./health-monitor.js";
  import { getAllStrategyStabilities, formatStabilityReport } from "./stability-index.js";
  import { getEvolutionTimeline, formatTimeline } from "./evolution-timeline.js";
  import { evaluateCooldown, formatCooldownStatus } from "./auto-cooldown.js";
  import { generateWeeklyResearch, getLastWeeklyReport } from "./weekly-research.js";
  import { calcReadinessIndex, formatReadinessReport } from "./readiness-index.js";
import { getDecisionStats, getRecentDecisionLog } from "./decision-trace.js";
import { getListingsReport } from "./listing-watcher.js";
import { runDataCleanup } from "./data-cleanup.js";

  const AUTO_PAIRS: Array<{ symbol: string; interval: Interval }> = [
    // ── Tier 1: Крупные ликвидные пары ───────────────────────────────────────
    { symbol: "BTCUSDT",    interval: "1h"  }, { symbol: "ETHUSDT",    interval: "1h"  },
    { symbol: "SOLUSDT",    interval: "1h"  }, { symbol: "BNBUSDT",    interval: "1h"  },
    { symbol: "XRPUSDT",    interval: "1h"  }, { symbol: "DOGEUSDT",   interval: "15m" },
    { symbol: "ADAUSDT",    interval: "15m" }, { symbol: "AVAXUSDT",   interval: "1h"  },
    { symbol: "LINKUSDT",   interval: "15m" }, { symbol: "NEARUSDT",   interval: "15m" },
    { symbol: "SUIUSDT",    interval: "15m" }, { symbol: "APTUSDT",    interval: "15m" },
    { symbol: "OPUSDT",     interval: "1h"  }, { symbol: "ARBUSDT",    interval: "1h"  },
    { symbol: "ATOMUSDT",   interval: "1h"  }, { symbol: "DOTUSDT",    interval: "1h"  },
    { symbol: "LTCUSDT",    interval: "1h"  }, { symbol: "TRXUSDT",    interval: "1h"  },
    { symbol: "PEPEUSDT",   interval: "15m" }, { symbol: "WIFUSDT",    interval: "15m" },
    { symbol: "SHIBUSDT",   interval: "15m" },
    // ── Tier 2: Перспективные пары (добавлены) ────────────────────────────────
    { symbol: "INJUSDT",    interval: "1h"  }, { symbol: "TONUSDT",    interval: "1h"  },
    { symbol: "RENDERUSDT", interval: "1h"  }, { symbol: "RUNEUSDT",   interval: "1h"  },
    { symbol: "HBARUSDT",   interval: "1h"  }, { symbol: "STXUSDT",    interval: "1h"  },
    { symbol: "MNTUSDT",    interval: "1h"  }, { symbol: "FETUSDT",    interval: "1h"  },
    { symbol: "TIAUSDT",    interval: "15m" }, { symbol: "WLDUSDT",    interval: "15m" },
    { symbol: "SEIUSDT",    interval: "15m" }, { symbol: "JUPUSDT",    interval: "15m" },
    { symbol: "ORDIUSDT",   interval: "15m" }, { symbol: "NOTUSDT",    interval: "15m" },
    { symbol: "PYTHUSDT",   interval: "15m" }, { symbol: "EIGENUSDT",  interval: "15m" },
    // ── Tier 1 (4h timeframe — parallel analysis) ────────────────────────────
    { symbol: "BTCUSDT",   interval: "4h" }, { symbol: "ETHUSDT",   interval: "4h" },
    { symbol: "SOLUSDT",   interval: "4h" }, { symbol: "BNBUSDT",   interval: "4h" },
    { symbol: "XRPUSDT",   interval: "4h" }, { symbol: "AVAXUSDT",  interval: "4h" },
    { symbol: "LINKUSDT",  interval: "4h" }, { symbol: "DOTUSDT",   interval: "4h" },
    { symbol: "ATOMUSDT",  interval: "4h" }, { symbol: "LTCUSDT",   interval: "4h" },
    // ── Tier 3 ────────────────────────────────────────────────────────────────
    { symbol: "AAVEUSDT",  interval: "1h"  }, { symbol: "UNIUSDT",   interval: "1h"  },
    { symbol: "ONDOUSDT",  interval: "1h"  }, { symbol: "ICPUSDT",   interval: "1h"  },
    { symbol: "FILUSDT",   interval: "1h"  }, { symbol: "LDOUSDT",   interval: "1h"  },
    { symbol: "STRKUSDT",  interval: "15m" }, { symbol: "BONKUSDT",  interval: "15m" },
    { symbol: "FLOKIUSDT", interval: "15m" }, { symbol: "BOMEUSDT",  interval: "15m" },
    { symbol: "ZKUSDT",    interval: "15m" }, { symbol: "TNSRUSDT",  interval: "15m" },
    { symbol: "ETHFIUSDT", interval: "15m" }, { symbol: "REZUSDT",   interval: "15m" },
    { symbol: "BBUSDT",    interval: "15m" },
  ];
  const ALL_PAIRS = AUTO_PAIRS.map(p => p.symbol);

  // ── Menus ─────────────────────────────────────────────────────────────────
  function mainMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback("💰 Заработок",  "menu_earnings"),
       Markup.button.callback("🧠 Обучение",   "menu_learning")],
      [Markup.button.callback("📋 Полный отчёт", "menu_fullreport")],
      [Markup.button.callback("⚙️ Настройки",  "menu_settings")],
    ]);
  }
  function backMenu() {
    return Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню", "menu_main")]]);
  }
  function analysisMenu() {
    return backMenu();
  }
  function pairsMenu(action: string, back = "menu_main") {
    return Markup.inlineKeyboard([
      // Tier 1
      [Markup.button.callback("₿ BTC",    `${action}_BTCUSDT`),   Markup.button.callback("Ξ ETH",     `${action}_ETHUSDT`),   Markup.button.callback("◎ SOL",    `${action}_SOLUSDT`)],
      [Markup.button.callback("🔶 BNB",   `${action}_BNBUSDT`),   Markup.button.callback("✕ XRP",     `${action}_XRPUSDT`),   Markup.button.callback("🐶 DOGE",  `${action}_DOGEUSDT`)],
      [Markup.button.callback("🔗 LINK",  `${action}_LINKUSDT`),  Markup.button.callback("🌊 ADA",    `${action}_ADAUSDT`),   Markup.button.callback("🔺 AVAX",  `${action}_AVAXUSDT`)],
      [Markup.button.callback("🟣 NEAR",  `${action}_NEARUSDT`),  Markup.button.callback("🔵 SUI",    `${action}_SUIUSDT`),   Markup.button.callback("🅰 APT",   `${action}_APTUSDT`)],
      [Markup.button.callback("🔴 OP",    `${action}_OPUSDT`),    Markup.button.callback("🔷 ARB",    `${action}_ARBUSDT`),   Markup.button.callback("⚛ ATOM",   `${action}_ATOMUSDT`)],
      [Markup.button.callback("⬡ DOT",    `${action}_DOTUSDT`),   Markup.button.callback("🌕 LTC",    `${action}_LTCUSDT`),   Markup.button.callback("⚡ TRX",   `${action}_TRXUSDT`)],
      [Markup.button.callback("🐸 PEPE",  `${action}_PEPEUSDT`),  Markup.button.callback("🐕 WIF",    `${action}_WIFUSDT`),   Markup.button.callback("🐕 SHIB",  `${action}_SHIBUSDT`)],
      // Tier 2
      [Markup.button.callback("🔮 INJ",   `${action}_INJUSDT`),   Markup.button.callback("💎 TON",    `${action}_TONUSDT`),   Markup.button.callback("🖥 RNDR",   `${action}_RENDERUSDT`)],
      [Markup.button.callback("⚗ RUNE",  `${action}_RUNEUSDT`),  Markup.button.callback("🌐 HBAR",   `${action}_HBARUSDT`),  Markup.button.callback("🟠 STX",   `${action}_STXUSDT`)],
      [Markup.button.callback("🔷 MNT",   `${action}_MNTUSDT`),   Markup.button.callback("🤖 FET",    `${action}_FETUSDT`),   Markup.button.callback("🌌 TIA",   `${action}_TIAUSDT`)],
      [Markup.button.callback("🌍 WLD",   `${action}_WLDUSDT`),   Markup.button.callback("⚡ SEI",    `${action}_SEIUSDT`),   Markup.button.callback("🪐 JUP",   `${action}_JUPUSDT`)],
      [Markup.button.callback("🔸 ORDI",  `${action}_ORDIUSDT`),  Markup.button.callback("🔔 NOT",    `${action}_NOTUSDT`),   Markup.button.callback("🔭 PYTH",  `${action}_PYTHUSDT`)],
      [Markup.button.callback("⚖ EIGEN", `${action}_EIGENUSDT`)],
      // Tier 3
      [Markup.button.callback("🏦 AAVE",   `${action}_AAVEUSDT`),  Markup.button.callback("🦄 UNI",    `${action}_UNIUSDT`),   Markup.button.callback("💧 ONDO",  `${action}_ONDOUSDT`)],
      [Markup.button.callback("🌐 ICP",    `${action}_ICPUSDT`),   Markup.button.callback("📁 FIL",    `${action}_FILUSDT`),   Markup.button.callback("🔵 LDO",   `${action}_LDOUSDT`)],
      [Markup.button.callback("⚡ STRK",  `${action}_STRKUSDT`),  Markup.button.callback("🐶 BONK",   `${action}_BONKUSDT`),  Markup.button.callback("🐸 FLOKI", `${action}_FLOKIUSDT`)],
      [Markup.button.callback("🅱 BOME",   `${action}_BOMEUSDT`),  Markup.button.callback("⬡ ZK",     `${action}_ZKUSDT`),    Markup.button.callback("🧠 TNSR",  `${action}_TNSRUSDT`)],
      [Markup.button.callback("🔷 ETHFI",  `${action}_ETHFIUSDT`), Markup.button.callback("🟥 REZ",    `${action}_REZUSDT`),   Markup.button.callback("🅱 BB",    `${action}_BBUSDT`)],
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
          const dir = p.direction === "LONG" ? "⬆️" : "⬇️";
          const be  = p.breakevenMoved ? " [BE✓]" : "";
          return `  ${dir} ${p.symbol} @ ${formatPrice(p.entryPrice)}${be}`;
        });
    return [
      `💰 *Виртуальный счёт*`, "",
      `Баланс: *$${account.balance.toFixed(2)}*`,
      `${ret >= 0 ? "📈" : "📉"} P&L: ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`,
      `📉 Просадка от пика: ${dd.toFixed(2)}%`, "",
      `📊 Сделок: ${trades.length} | WR: ${trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0}%`,
      `Profit Factor: ${pf === 999 ? "∞" : pf.toFixed(2)}`,
      `  Gross Profit: +${gW.toFixed(2)} | Gross Loss: -${gL.toFixed(2)}`, "",
      `📅 Сегодня: ${pnlD >= 0 ? "+" : ""}$${pnlD.toFixed(2)}`,
      `📆 Неделя: ${pnlW >= 0 ? "+" : ""}$${pnlW.toFixed(2)}`, "",
      `📂 Открытых (${account.positions.length}):`,
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
        `✅ *Автоторговля запущена!*\n\nСлежу за *${AUTO_PAIRS.length} монетами* в реальном времени\n` +
        `🧠 Динамический порог по активности рынка\n_Бот работает 24/7_ 😴`,
        { parse_mode: "Markdown", ...mainMenu() }
      );
    });

    // ── /menu command — persistent shortcut to main menu ──────────────────
    bot.command("menu", async (ctx) => {
      await ctx.reply("Главное меню:", mainMenu());
    });

    // ── Navigation ─────────────────────────────────────────────────────────
    bot.action("menu_main", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply("Главное меню:", mainMenu());
    });

    // ── Заработок ──────────────────────────────────────────────────────────
    bot.action("menu_earnings", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId  = ctx.chat!.id;
      const account = await loadPaperAccount(chatId);
      const trades  = account.closedTrades;
      const wins    = trades.filter(t => t.pnl > 0);
      const ret     = ((account.balance - account.initialBalance) / account.initialBalance) * 100;
      const dd      = (account.peakBalance ?? account.balance) > 0
        ? (((account.peakBalance ?? account.balance) - account.balance) / (account.peakBalance ?? account.balance)) * 100
        : 0;
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const weekStart  = new Date(todayStart);
      weekStart.setDate(todayStart.getDate() - ((todayStart.getDay() + 6) % 7));
      const pnlD = trades.filter(t => new Date(t.closedAt) >= todayStart).reduce((a, t) => a + t.pnl, 0);
      const pnlW = trades.filter(t => new Date(t.closedAt) >= weekStart).reduce((a, t) => a + t.pnl, 0);
      const gW   = wins.reduce((a, t) => a + t.pnl, 0);
      const gL   = Math.abs(trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
      const pf   = gL > 0 ? gW / gL : gW > 0 ? 999 : 0;

      const posLines = account.positions.length === 0
        ? ["_нет открытых позиций_"]
        : await Promise.all(account.positions.map(async p => {
            const dir = p.direction === "LONG" ? "⬆️" : "⬇️";
            try {
              const { getPrice } = await import("./binance.js");
              const price = await getPrice(p.symbol);
              const pnlVal = p.direction === "LONG"
                ? (price - p.entryPrice) * p.size
                : (p.entryPrice - price) * p.size;
              const sign = pnlVal >= 0 ? "+" : "";
              return `${dir} *${p.symbol}* ${sign}$${pnlVal.toFixed(2)}`;
            } catch {
              return `${dir} *${p.symbol}* @ ${formatPrice(p.entryPrice)}`;
            }
          }));

      const lines = [
        `💰 *Заработок*`, ``,
        `Баланс: *$${account.balance.toFixed(2)}*  (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%)`,
        `📉 Просадка: ${dd.toFixed(2)}%`,
        ``,
        `📅 Сегодня: *${pnlD >= 0 ? "+" : ""}$${pnlD.toFixed(2)}*`,
        `📆 Неделя: *${pnlW >= 0 ? "+" : ""}$${pnlW.toFixed(2)}*`,
        ``,
        `📊 Сделок: ${trades.length} | WR: ${trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0}% | PF: ${pf >= 999 ? "∞" : pf.toFixed(2)}`,
        ``,
        `📂 Открыто (${account.positions.length}):`,
        ...posLines,
      ];

      await ctx.reply(lines.join("\n"), {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Обновить", "menu_earnings")],
          [Markup.button.callback("🗑 Сбросить счёт", "paperreset_confirm"), Markup.button.callback("◀️ Меню", "menu_main")],
        ]),
      });
    });

    // ── Обучение ───────────────────────────────────────────────────────────
    bot.action("menu_learning", async (ctx) => {
      await ctx.answerCbQuery();
      const loading = await ctx.reply("⏳ Загружаю...");
      try {
        const chatId = ctx.chat!.id;

        // Gather learning data in parallel
        const [statuses, health, readiness] = await Promise.all([
          getAllStrategyStatuses().catch(() => []),
          checkLearningHealth(chatId).catch(() => null),
          calcReadinessIndex(chatId).catch(() => null),
        ]);

        const totalTrades = statuses.reduce((a: number, s: any) => a + (s.trades ?? 0), 0);
        const best = statuses.sort((a: any, b: any) => (b.trustScore ?? 0) - (a.trustScore ?? 0))[0];

        const statusIcons: Record<string, string> = { active: "✅", quarantine: "⚠️", disabled: "🔴" };
        const levelIcons: Record<string, string> = { excellent:"🟢", good:"🟢", watch:"🟡", warning:"🟠", critical:"🔴" };
        const levelLabels: Record<string, string> = { excellent:"Отлично", good:"Хорошо", watch:"Наблюдение", warning:"Внимание", critical:"Критично" };
        const healthIcon = health ? (levelIcons[health.overall] ?? "⚪") : "⚪";
        const healthText = health ? (levelLabels[health.overall] ?? health.overall) : "Нет данных";
        const trendIcon  = health?.trend === "improving" ? "📈" : health?.trend === "degrading" ? "📉" : "→";

        const lines = [
          `🧠 *Обучение AI*`, ``,
          `📊 Сделок накоплено: *${totalTrades}*`,
          `${trendIcon} Тренд: *${health?.trend === "improving" ? "Улучшается" : health?.trend === "degrading" ? "Ухудшается" : "Стабильно"}*`,
          `${healthIcon} Состояние: *${healthText}*`,
          ``,
        ];

        if (best && best.trades > 0) {
          const wr = (best.winRate * 100).toFixed(1);
          const pf = best.profitFactor >= 99 ? "∞" : best.profitFactor.toFixed(2);
          lines.push(
            `🏆 Лучшая стратегия: *${best.strategy}*`,
            `   WR ${wr}% | PF ${pf} | Trust ${best.trustScore}/100`,
            ``,
          );
        } else {
          lines.push(`🏆 Лучшая стратегия: _накапливаю данные..._`, ``);
        }

        
          // Per-strategy breakdown
          const stratLines: string[] = [``, `📋 *Стратегии — состояние:*`];
          const stratEmoji: Record<string, string> = {
            TREND: "📈", BREAKOUT: "🚀", VOLUME_IMPULSE: "⚡", MEAN_REVERSION: "↩️"
          };
          const stratLabel: Record<string, string> = {
            TREND: "Тренд", BREAKOUT: "Пробой", VOLUME_IMPULSE: "Импульс", MEAN_REVERSION: "Возврат"
          };
          for (const s of (statuses as any[])) {
            const icon = stratEmoji[s.strategy] ?? "▪️";
            const name = stratLabel[s.strategy] ?? s.strategy;
            const statusMark = s.status === "active" ? "✅" : s.status === "quarantine" ? "⚠️" : "🔴";
            const wr   = s.trades > 0 ? (s.winRate * 100).toFixed(0) + "%" : "—";
            const pf   = s.trades > 0 ? (s.profitFactor >= 99 ? "∞" : s.profitFactor.toFixed(2)) : "—";
            const wPct = Math.round((s.weight ?? 1) * 100);
            const trust = s.trades >= 5 ? `${s.trustScore}/100` : `boot(${s.trades})`;
            stratLines.push(`${statusMark}${icon} *${name}*  вес ${wPct}% | Trust ${trust}`);
            stratLines.push(`   WR ${wr} | PF ${pf} | сделок ${s.trades}`);
          }
          lines.push(...stratLines);

  if (readiness) {
          const ri = readiness.percent;
          const riIcon = ri >= 70 ? "🟢" : ri >= 40 ? "🟡" : "🔴";
          lines.push(`${riIcon} Готовность: *${ri}/100*`);
        }

        const needMore = totalTrades < 50;
        if (needMore) {
          lines.push(``, `_💡 Нужно ≥50 сделок для уверенных выводов — ${50 - totalTrades} осталось_`);
        }

        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply(lines.join("\n"), {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔄 Обновить", "menu_learning")],
            [Markup.button.callback("◀️ Меню", "menu_main")],
          ]),
        });
      } catch {
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply("⏳ Данных ещё мало — бот только начал обучение.", backMenu());
      }
    });

    for (const pair of ALL_PAIRS) {
      bot.action(`signal_${pair}`, async (ctx) => { await ctx.answerCbQuery(); await doSignal(ctx, pair); });

      bot.action(`subpair_${pair}`, async (ctx) => {
        await ctx.answerCbQuery();
        subscribe(ctx.chat!.id, pair, "1h");
        await ctx.reply(`✅ Подписка *${pair}* добавлена.`, { parse_mode:"Markdown", ...mainMenu() });
      });
    }

    // ── Позиции (редирект) ────────────────────────────────────────────────
    bot.action("menu_positions", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId  = ctx.chat!.id;
      const account = await loadPaperAccount(chatId);
      const posMenu = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Обновить", "menu_earnings"),
         Markup.button.callback("◀️ Меню",     "menu_main")],
      ]);

      if (account.positions.length === 0) {
        await ctx.reply(
          `📂 *Открытых позиций нет*\n\n_Бот следит за ${AUTO_PAIRS.length} монетами и откроет сделку при сигнале._`,
          { parse_mode: "Markdown", ...posMenu }
        );
        return;
      }

      const { getPrice } = await import("./binance.js");
      const lines: string[] = [`📂 *Позиции (${account.positions.length})*\n`];

      for (const pos of account.positions) {
        const dir = pos.direction === "LONG" ? "⬆️ LONG" : "⬇️ SHORT";
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

    // ── Счёт (редирект на earnings) ────────────────────────────────────────
    bot.action("menu_account", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply(await buildAccountStats(ctx.chat!.id), { parse_mode:"Markdown", ...backMenu() });
    });

    bot.action("paperreset_confirm", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply("⚠️ Сбросить счёт до $10,000?",
        Markup.inlineKeyboard([[Markup.button.callback("✅ Да","paperreset_do"), Markup.button.callback("❌ Отмена","menu_earnings")]]));
    });
    bot.action("paperreset_do", async (ctx) => {
      await ctx.answerCbQuery();
      const { savePaperAccount } = await import("./storage.js");
      await savePaperAccount(ctx.chat!.id, { balance:10000, initialBalance:10000, peakBalance:10000, positions:[], closedTrades:[] });
      await ctx.reply("✅ Счёт сброшен до $10,000", mainMenu());
    });

    // ── Анализ (редирект на обучение) ──────────────────────────────────────
    bot.action("menu_analysis", async (ctx) => {
      await ctx.answerCbQuery();
      // Redirect to new simplified learning screen
      const chatId = ctx.chat!.id;
      const analysis = await buildSelfAnalysis(chatId);
      await ctx.reply(analysis, { parse_mode:"Markdown", ...backMenu() });
    });

    
      bot.action("menu_aireport", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Генерирую AI отчёт...");
        try {
          const report = await generateLearningReport();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(report, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch { await ctx.reply("❌ Ошибка генерации отчёта"); }
      });
      bot.action("menu_timeanalytics", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Считаю статистику по времени...");
        try {
          const stats = await getTimeAnalytics();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(stats, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch { await ctx.reply("❌ Ошибка загрузки аналитики"); }
      });
      bot.action("menu_instruments", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Загружаю аналитику по инструментам...");
        try {
          const stats = await getInstrumentAnalytics();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(stats, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
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
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
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
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
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
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка загрузки данных");
        }
      });

      // ── Release Candidate: 10 new module handlers ──────────────────────

      bot.action("menu_readiness", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Вычисляю Readiness Index...");
        try {
          const result = await calcReadinessIndex(ctx.chat!.id);
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(formatReadinessReport(result), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка вычисления Readiness Index");
        }
      });

      bot.action("menu_health", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Проверяю здоровье обучения...");
        try {
          const health = await checkLearningHealth(ctx.chat!.id);
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(formatHealthReport(health), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка проверки здоровья");
        }
      });

      bot.action("menu_evolution", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Загружаю историю эволюции...");
        try {
          const snapshots = await getEvolutionTimeline(10);
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(formatTimeline(snapshots), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка загрузки эволюции");
        }
      });

      bot.action("menu_walkforward", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Запускаю Walk-Forward тесты...");
        try {
          const strategies: Array<"TREND"|"BREAKOUT"|"VOLUME_IMPULSE"|"MEAN_REVERSION"> = ["TREND","BREAKOUT","VOLUME_IMPULSE","MEAN_REVERSION"];
          const results = await Promise.all(strategies.map(s => runWalkForwardTest(s)));
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(formatWalkForwardReport(results), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка Walk-Forward теста");
        }
      });

      bot.action("menu_stat_sig", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Проверяю изменения статистически...");
        try {
          const strategies = ["TREND","BREAKOUT","VOLUME_IMPULSE","MEAN_REVERSION"];
          const tests = await Promise.all(strategies.map(s => testStrategyChange(s)));
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(formatSignificanceReport(tests), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка статистической проверки");
        }
      });

      bot.action("menu_drift", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Анализирую дрейф рынка...");
        try {
          const drift = await detectMarketDrift();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(formatDriftReport(drift), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка анализа дрейфа");
        }
      });

      bot.action("menu_stability", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Вычисляю индексы стабильности...");
        try {
          const results = await getAllStrategyStabilities();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(formatStabilityReport(results), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка вычисления стабильности");
        }
      });

  
    // ── /whynotrade — диагностика почему не открываются сделки ───────────────
    bot.command('whynotrade', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const loading = await ctx.reply('⏳ Анализирую логи решений...', { parse_mode: 'Markdown' });
      try {
        // Ensure table exists before querying
        const [stats, recent] = await Promise.all([
          getDecisionStats().catch(() => ({ total: 0, opened: 0, rejected: 0, topRejectReasons: [] })),
          getRecentDecisionLog(30).catch(() => []),
        ]);

        const rejects = recent.filter(d => d.verdict === 'REJECT');
        const opens   = recent.filter(d => d.verdict === 'OPEN');

        const lines: string[] = [
          '🔍 *Почему не открываются сделки?*',
          `_Последние 30 решений: ✅ ${opens.length} открыто, ❌ ${rejects.length} отклонено_`,
          '',
        ];

        if (!rejects.length && !opens.length) {
          lines.push('⚠️ Данных нет. Бот ещё не анализировал сигналы.', '', '_Подождите следующего закрытия свечи (до 15 мин)._');
        } else {
          // Топ причин отказов за последние 30 решений
          const reasonCount = new Map<string, number>();
          for (const r of rejects) {
            const key = r.rejectReason ?? 'Неизвестно';
            reasonCount.set(key, (reasonCount.get(key) ?? 0) + 1);
          }
          const topReasons = [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

          if (topReasons.length) {
            lines.push('*Топ причин отказов:*');
            const icons: Record<string, string> = {
              'MTF': '📊', 'Score': '📉', 'Confidence': '🎯',
              'Trust': '🏆', 'Profit': '💰', 'Режим': '🌊',
              'Вес': '⚖️', 'хаос': '🌪', 'Нейтральный': '➡️',
              'Временной': '🕐',
            };
            for (const [reason, count] of topReasons) {
              const icon = Object.entries(icons).find(([k]) => reason.includes(k))?.[1] ?? '❌';
              const pct = Math.round((count / rejects.length) * 100);
              lines.push(`${icon} ${reason}: *${count}x* (${pct}%)`);
            }
            lines.push('');
          }

          // Последние 3 полных трейса для диагностики
          const last3 = rejects.slice(0, 3);
          if (last3.length) {
            lines.push('*Последние отказы (подробно):*');
            for (const trace of last3) {
              const ts = new Date(trace.timestamp).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
              const failStep = trace.steps.find(s => s.result === 'FAIL');
              lines.push(`❌ ${trace.symbol} [${ts}] → ${failStep?.check ?? trace.rejectReason}`);
            }
            lines.push('');
          }

          // Подсказка по самой частой причине
          if (topReasons[0]) {
            const top = topReasons[0][0];
            const hints: Record<string, string> = {
              'MTF': '📊 *4H фильтр* блокирует большинство сигналов. Это нормально при боковом рынке — ждём когда 4H EMA20 и EMA50 выстроятся в одну сторону.',
              'Score': '📉 *Сигналы слабые* — score не дотягивает до порога. Рынок в консолидации, ждём импульса.',
              'Нейтральный': '➡️ *Нейтральное направление* — рынок не определился. Нормально для бокового движения.',
              'хаос': '🌪 *Хаотичный рынок* — ATR слишком высокий. Бот защищает от высоковолатильных входов.',
              'Режим': '🌊 *Режим рынка* — текущая стратегия не подходит к условиям. Система ищет другую.',
              'Trust': '🏆 *Trust Score* — стратегия ещё набирает репутацию. Нужно больше сделок для доверия.',
            };
            const hint = Object.entries(hints).find(([k]) => top.includes(k))?.[1];
            if (hint) lines.push('💡 ' + hint);
          }
        }

        await ctx.telegram.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        await ctx.telegram.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Ошибка: ${msg.slice(0, 300)}`);
      }
    });

    // ── /listings — отчёт об авто-найденных листингах ───────────────────────
    bot.command("listings", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const report = await getListingsReport().catch(() => "❌ Ошибка");
      await ctx.reply(report, { parse_mode: "Markdown" });
    });

    bot.action("menu_cooldown", async (ctx) => {
        await ctx.answerCbQuery();
        try {
          const state = await evaluateCooldown(ctx.chat!.id);
          await ctx.reply(formatCooldownStatus(state), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch { await ctx.reply("❌ Ошибка проверки Cooldown"); }
      });

      bot.action("menu_weekly", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Загружаю недельный отчёт...");
        try {
          let report = await getLastWeeklyReport();
          if (!report) {
            report = await generateWeeklyResearch();
          }
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          const text = report.fullText.slice(0, 4000);
          await ctx.reply(text, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("🔄 Обновить","menu_weekly_refresh")],
              [Markup.button.callback("◀️ Меню","menu_main")],
            ]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка генерации отчёта");
        }
      });

      bot.action("menu_weekly_refresh", async (ctx) => {
        await ctx.answerCbQuery();
        const loading = await ctx.reply("⏳ Генерирую свежий недельный отчёт...");
        try {
          const report = await generateWeeklyResearch();
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply(report.fullText.slice(0, 4000), { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch {
          await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await ctx.reply("❌ Ошибка генерации отчёта");
        }
      });

      bot.action("menu_correlation", async (ctx) => {
        await ctx.answerCbQuery();
        try {
          const report = await getPortfolioCorrelationReport(ctx.chat!.id);
          await ctx.reply(report, { parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню","menu_main")]]) });
        } catch { await ctx.reply("❌ Ошибка анализа корреляций"); }
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
          { parse_mode:"Markdown", ...backMenu() });
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

        const [statuses, {rows: dirStatRows}] = await Promise.all([
            getAllStrategyStatuses(regime),
            pool.query(`SELECT strategy, direction, trades, wins, win_pnl, loss_pnl
              FROM strategy_direction_stats WHERE trades >= 10`),
          ]);
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
            const ADAPT_THRESHOLD = 30;
            const adaptLine = s.trades >= ADAPT_THRESHOLD
              ? `Адаптация активна | Вес: ${(s.weight*100).toFixed(0)}%`
              : `До адаптации: ${ADAPT_THRESHOLD - s.trades} сделок`;
            lines.push(
              `${icon} *${s.strategy}* — ${sl}\n` +
              `  Сделок: ${s.trades} | ${adaptLine}\n` +
              `  Trust: ${s.trustScore}/100 | WR: ${wr}% | PF: ${pf}`
            );
            // ↳ TREND_LONG / TREND_SHORT direction breakdown
            for (const dir of ["LONG","SHORT"]) {
              const dr = (dirStatRows as Record<string,unknown>[]).find(
                r => r["strategy"]===s.strategy && r["direction"]===dir
              );
              if (!dr) continue;
              const dt=Number(dr["trades"]),dw=Number(dr["wins"]),dwp=Number(dr["win_pnl"]),dlp=Number(dr["loss_pnl"]);
              const dwr=(dw/dt*100).toFixed(0);
              const dpf=dlp>0?(dwp/dlp).toFixed(2):dwp>0?"∞":"—";
              lines.push(`  ↳ ${s.strategy}_${dir}: WR ${dwr}% | PF ${dpf} | n=${dt}`);
            }
          }
            await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply(lines.join("\n"), {
          parse_mode:"Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📈 История изменений","menu_strat_history")],
            [Markup.button.callback("◀️ Меню","menu_main")],
          ]),
        });
      } catch {
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        const stats = await loadStrategyStats();
        await ctx.reply(formatStrategyStats(stats), { parse_mode:"Markdown", ...backMenu() });
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

    // ── Полный отчёт ───────────────────────────────────────────────────────
    bot.action("menu_fullreport", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const loading = await ctx.reply("⏳ Генерирую HTML-отчёт...");
      try {
        const { html, filename } = await generateDailyReport(chatId);
        await ctx.telegram.deleteMessage(chatId, loading.message_id).catch(() => {});
        await ctx.telegram.sendDocument(chatId, { source: html, filename }, {
          caption: "📄 HTML-отчёт — открой в браузере для полного просмотра",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("🔄 Обновить", "menu_fullreport")],
            [Markup.button.callback("◀️ Меню",     "menu_main")],
          ]).reply_markup,
        });
      } catch (err) {
        await ctx.telegram.deleteMessage(chatId, loading.message_id).catch(() => {});
        logger.error({ err }, "full report error");
        await ctx.reply("❌ Ошибка при формировании отчёта: " + String(err).slice(0,200), backMenu());
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
        `📂 Открыто позиций: *${account.positions.length}*
` +
        `💰 Баланс: *$${account.balance.toFixed(2)}* (${Number(ret) >= 0 ? "+" : ""}${ret}%)\n\n` +
        (subs.length === 0 ? `⚠️ Нажми /start → 🚀 Запустить` : `🟢 Бот активен, жду сигнал`),
        { parse_mode:"Markdown", ...mainMenu() }
      );
    });

    // ── Text fallback ──────────────────────────────────────────────────────
    // /adapt — manually trigger strategy weight adaptation
    bot.command("adapt", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const loading = await ctx.reply("⚙️ Запускаю адаптацию весов стратегий...");
      try {
        const chatIds = new Set([chatId]);
        const changes = await runAdaptationCycle(chatIds);
        await snapshotStrategyVersion(changes);
        const report  = await generateLearningReport();
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        const bulletLines = changes.split("\n").filter(Boolean).map((l: string) => "• " + l).join("\n");
        const summary = bulletLines
          ? "<b>⚙️ Адаптация выполнена</b>\n\n" + bulletLines
          : "<b>⚙️ Адаптация выполнена</b>\n\n<i>Веса не изменились — данных ещё мало.</i>";
        await ctx.reply(summary, { parse_mode: "HTML" });
        await ctx.reply(report, { parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Меню", "menu_main")]]) });
      } catch (err) {
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply("❌ Ошибка адаптации: " + String(err));
      }
    });

    // cleandata — dedup phantom trades and recalculate balance
    bot.command("cleandata", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const loading = await ctx.reply("🧹 Запускаю очистку данных... (~10 сек)");
      try {
        const result = await runDataCleanup(chatId);
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        const diff     = result.newBalance - result.oldBalance;
        const diffSign = diff >= 0 ? "+" : "";
        await ctx.reply(
          `<b>✅ Очистка завершена</b>\n\n` +
          `🗑 Удалено дублей: <b>${result.dupesRemoved}</b>\n` +
          `📊 Реальных сделок: <b>${result.tradesKept}</b>\n\n` +
          `💰 <b>Баланс</b>\n` +
          `  Было:  <code>${result.oldBalance.toFixed(2)}</code>\n` +
          `  Стало: <code>${result.newBalance.toFixed(2)}</code>\n` +
          `  Коррекция: <b>${diffSign}${diff.toFixed(2)}</b>\n\n` +
          `🧠 <b>Статистика обучения</b>\n` +
          `  ✅ Восстановлено в strategy_stats: <b>${result.statsRebuilt}</b> стратегий\n` +
          `  • Веса → нейтральные (trust 50/100)\n` +
          `  • time_analytics, instrument_analytics — очищены\n` +
          `  • strategy_versions, learning_reports — очищены\n\n` +
          `<i>Бот обучается на реальных ${result.tradesKept} сделках ✨</i>`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
        await ctx.reply("❌ Ошибка при очистке: " + String(err));
      }
    });

    // /report — send HTML daily report on demand
  bot.command("report", async (ctx) => {
    const chatId = ctx.chat.id;
    const msg = await ctx.reply("⏳ Генерирую HTML-отчёт...", { parse_mode: "Markdown" });
    try {
      const { html, filename, summary } = await generateDailyReport(chatId);
      await ctx.reply(summary, { parse_mode: "Markdown" });
      await ctx.telegram.sendDocument(chatId, { source: html, filename }, { caption: "📄 Полный HTML-отчёт" });
    } catch (err) {
      logger.error({ err, chatId }, "/report command failed");
      await ctx.reply("❌ Ошибка генерации отчёта.");
    }
    try { await ctx.telegram.deleteMessage(chatId, msg.message_id); } catch { /* ignore */ }
  });

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
    // Register commands so Telegram shows the ☰ Menu button automatically
    bot.telegram.setMyCommands([
      { command: "menu",        description: "📋 Главное меню" },
      { command: "start",       description: "🚀 Запустить / перезапустить бота" },
      { command: "status",      description: "📊 Статус бота и позиций" },
      { command: "report",      description: "📄 Полный HTML-отчёт" },
      { command: "scan",        description: "🔍 Ручное сканирование сигналов" },
      { command: "listings",    description: "🆕 Новые листинги монет" },
      { command: "whynotrade",  description: "❓ Почему нет сделок" },
      { command: "adapt",       description: "🧠 Запустить цикл адаптации" },
      { command: "cleandata",   description: "🗑 Очистка устаревших данных" },
    ]).catch(err => logger.warn({ err }, "setMyCommands failed"));
    logger.info("Telegram bot started");
  }
  