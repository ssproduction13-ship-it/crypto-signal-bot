import { Telegraf, Markup } from "telegraf";
import { generateSignal, formatSignal } from "./signals.js";
import { validateSymbol } from "./binance.js";
import {
  subscribe,
  unsubscribe,
  unsubscribeAll,
  listSubscriptions,
  startScheduler,
  initSubscriptions,
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
  loadJournal,
  loadWeights,
} from "./storage.js";
import { logger } from "../lib/logger.js";
import type { Interval } from "./binance.js";

const AUTO_PAIRS: Array<{ symbol: string; interval: Interval }> = [
  { symbol: "BTCUSDT",  interval: "1h"  },
  { symbol: "ETHUSDT",  interval: "1h"  },
  { symbol: "SOLUSDT",  interval: "1h"  },
  { symbol: "BNBUSDT",  interval: "1h"  },
  { symbol: "XRPUSDT",  interval: "1h"  },
  { symbol: "DOGEUSDT", interval: "15m" },
  { symbol: "ADAUSDT",  interval: "15m" },
  { symbol: "AVAXUSDT", interval: "1h"  },
  { symbol: "LINKUSDT", interval: "15m" },
  { symbol: "NEARUSDT", interval: "15m" },
  { symbol: "SUIUSDT",  interval: "15m" },
  { symbol: "APTUSDT",  interval: "15m" },
  { symbol: "OPUSDT",   interval: "1h"  },
  { symbol: "ARBUSDT",  interval: "1h"  },
  { symbol: "ATOMUSDT", interval: "1h"  },
  { symbol: "DOTUSDT",  interval: "1h"  },
  { symbol: "LTCUSDT",  interval: "1h"  },
  { symbol: "TRXUSDT",  interval: "1h"  },
  { symbol: "PEPEUSDT", interval: "15m" },
  { symbol: "WIFUSDT",  interval: "15m" },
  { symbol: "SHIBUSDT", interval: "15m" },
];

const POPULAR_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT",
  "ADAUSDT","AVAXUSDT","LINKUSDT","NEARUSDT","SUIUSDT","APTUSDT",
  "OPUSDT","ARBUSDT","ATOMUSDT","DOTUSDT","LTCUSDT","TRXUSDT",
  "PEPEUSDT","WIFUSDT","SHIBUSDT",
];
const VALID_INTERVALS: Interval[] = ["5m", "15m", "1h", "4h", "1d"];

function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📊 Сигнал", "menu_signal"),
      Markup.button.callback("💼 Мой счёт", "menu_paper"),
    ],
    [
      Markup.button.callback("📓 Журнал & Статистика", "menu_journal"),
      Markup.button.callback("🌅 Итоговый отчёт", "menu_report"),
    ],
    [
      Markup.button.callback("⚙️ Настройки", "menu_settings"),
      Markup.button.callback("❓ Помощь", "menu_help"),
    ],
  ]);
}

function pairsMenu(action: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("₿ BTC",   `${action}_BTCUSDT`),
      Markup.button.callback("Ξ ETH",   `${action}_ETHUSDT`),
      Markup.button.callback("◎ SOL",   `${action}_SOLUSDT`),
    ],
    [
      Markup.button.callback("🔶 BNB",  `${action}_BNBUSDT`),
      Markup.button.callback("✕ XRP",   `${action}_XRPUSDT`),
      Markup.button.callback("🐶 DOGE", `${action}_DOGEUSDT`),
    ],
    [
      Markup.button.callback("🔗 LINK", `${action}_LINKUSDT`),
      Markup.button.callback("🌊 ADA",  `${action}_ADAUSDT`),
      Markup.button.callback("🔺 AVAX", `${action}_AVAXUSDT`),
    ],
    [
      Markup.button.callback("🟣 NEAR", `${action}_NEARUSDT`),
      Markup.button.callback("🔵 SUI",  `${action}_SUIUSDT`),
      Markup.button.callback("🅰 APT",  `${action}_APTUSDT`),
    ],
    [
      Markup.button.callback("🔴 OP",   `${action}_OPUSDT`),
      Markup.button.callback("🔷 ARB",  `${action}_ARBUSDT`),
      Markup.button.callback("⚛ ATOM",  `${action}_ATOMUSDT`),
    ],
    [
      Markup.button.callback("⬡ DOT",  `${action}_DOTUSDT`),
      Markup.button.callback("🌕 LTC",  `${action}_LTCUSDT`),
      Markup.button.callback("⚡ TRX",  `${action}_TRXUSDT`),
    ],
    [
      Markup.button.callback("🐸 PEPE", `${action}_PEPEUSDT`),
      Markup.button.callback("🐕 WIF",  `${action}_WIFUSDT`),
      Markup.button.callback("🐕 SHIB", `${action}_SHIBUSDT`),
    ],
    [Markup.button.callback("◀️ Назад", "menu_main")],
  ]);
}

function parseArgs(text: string): string[] {
  return text.trim().split(/\s+/).slice(1);
}

async function sendMainMenu(ctx: any, text?: string) {
  await ctx.reply(
    text ?? "Выбери действие:",
    mainMenu()
  );
}

async function doSignal(ctx: any, symbol: string, interval: Interval = "1h") {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  const msg = await ctx.reply(`⏳ Анализирую *${symbol}* (${interval})...`, { parse_mode: "Markdown" });
  try {
    const sig = await generateSignal(symbol, interval, chatId);
    await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    await ctx.reply(formatSignal(sig), {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📊 Ещё сигнал", "menu_signal"),
          Markup.button.callback("🏠 Главное меню", "menu_main"),
        ],
      ]),
    });
  } catch (err) {
    logger.error({ err }, "Signal error");
    await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    await ctx.reply("⚠️ Ошибка при получении данных. Попробуй позже.");
  }
}

async function buildReport(chatId: number): Promise<string> {
  const journal = await loadJournal();
  const account = await loadPaperAccount(chatId);
  const weights = await loadWeights();
  const subs = listSubscriptions(chatId);

  const myEntries = journal.filter((e) => e.chatId === chatId);
  const closed = myEntries.filter((e) => e.closedAt);
  const open = myEntries.filter((e) => !e.closedAt);

  const wins = closed.filter((e) => (e.pnlPercent ?? 0) > 0);
  const losses = closed.filter((e) => (e.pnlPercent ?? 0) <= 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((a, e) => a + (e.pnlPercent ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, e) => a + (e.pnlPercent ?? 0), 0) / losses.length) : 0;

  const paperTrades = account.closedTrades;
  const paperWins = paperTrades.filter((t) => t.pnlPercent > 0);
  const paperPnl = paperTrades.reduce((a, t) => a + t.pnl, 0);
  const paperReturn = ((account.balance - account.initialBalance) / account.initialBalance) * 100;

  const lines: string[] = [
    `🌅 *Итоговый отчёт*`,
    ``,
    `📡 *Подписки (авто-сигналы):* ${subs.length}`,
    subs.length ? subs.map((s) => `  • ${s.symbol} ${s.interval}`).join("\n") : "  нет подписок",
    ``,
    `📊 *Сигналы (журнал):*`,
    `  Всего сгенерировано: ${myEntries.length}`,
    `  Отслежено (закрыто): ${closed.length}`,
    `  Открытых: ${open.length}`,
    closed.length > 0 ? [
      `  WinRate: ${winRate.toFixed(1)}%`,
      `  Ср. выигрыш: +${avgWin.toFixed(2)}%`,
      `  Ср. убыток: -${avgLoss.toFixed(2)}%`,
    ].join("\n") : "  Пока нет закрытых сигналов — ждём результатов.",
    ``,
    `💼 *Виртуальный счёт ($10 000 стартовый):*`,
    `  Текущий баланс: $${account.balance.toFixed(2)}`,
    `  Доходность: ${paperReturn >= 0 ? "+" : ""}${paperReturn.toFixed(2)}%`,
    `  Сделок закрыто: ${paperTrades.length}`,
    paperTrades.length > 0 ? [
      `  Прибыльных: ${paperWins.length} из ${paperTrades.length}`,
      `  Общий P&L: ${paperPnl >= 0 ? "+" : ""}$${paperPnl.toFixed(2)}`,
    ].join("\n") : "  Пока сделок нет — бот открывает позиции при хороших сигналах.",
    ``,
    `🧠 *Чему научился ИИ (веса):*`,
    `  Тренд: ${(weights.trend * 100).toFixed(0)}%`,
    `  Объём: ${(weights.volume * 100).toFixed(0)}%`,
    `  Импульс: ${(weights.momentum * 100).toFixed(0)}%`,
    `  Уровни: ${(weights.levels * 100).toFixed(0)}%`,
    `  Паттерн: ${(weights.pattern * 100).toFixed(0)}%`,
    ``,
    `⚠️ _Виртуальный счёт — не реальные деньги._`,
  ];

  return lines.join("\n");
}

export function createBot(): Telegraf {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const name = ctx.from?.first_name ?? "трейдер";
    await ctx.reply(
      `👋 Привет, *${name}*!\n\n` +
      `Я торговый бот с искусственным интеллектом.\n\n` +
      `🔍 Анализирую крипторынок по 9+ индикаторам\n` +
      `🧠 Использую Gemini AI для оценки сигналов\n` +
      `📈 Веду виртуальный счёт и учусь на ошибках\n` +
      `🔔 Отправляю сигналы автоматически 24/7\n\n` +
      `_Не нужно ничего знать о торговле — я всё объясню!_`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Начать торговать", "onboard_start")],
        [Markup.button.callback("📖 Как это работает?", "onboard_how")],
      ])}
    );
  });

  bot.action("onboard_how", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `📖 *Как работает бот?*\n\n` +
      `1️⃣ *Сигнал* — бот анализирует график монеты и говорит: покупать 🟢, продавать 🔴, или ждать ⚪\n\n` +
      `2️⃣ *Оценка /100* — чем выше балл, тем надёжнее сигнал. Только 70+ проходит фильтр.\n\n` +
      `3️⃣ *Стоп-лосс* — защита от больших потерь. Бот всегда считает риск.\n\n` +
      `4️⃣ *Виртуальный счёт* — бот торгует на бумаге ($10 000), не на реальные деньги.\n\n` +
      `5️⃣ *Самообучение* — после каждой сделки ИИ корректирует веса индикаторов.\n\n` +
      `⚠️ _Бот не даёт финансовых советов. Это инструмент обучения._`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Понятно, запустить!", "onboard_start")],
      ])}
    );
  });

  bot.action("onboard_start", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;

    const s = await loadSettings(chatId);
    s.autoPaperTrade = true;
    await saveSettings(chatId, s);

    for (const { symbol, interval } of AUTO_PAIRS) {
      subscribe(chatId, symbol, interval);
    }

    await ctx.reply(
      `✅ *Автоторговля запущена!*\n\n` +
      `Бот следит за *21 монетой* на разных таймфреймах:\n\n` +
      `📊 *1h:* BTC, ETH, SOL, BNB, XRP, AVAX, OP, ARB, ATOM, DOT, LTC, TRX\n` +
      `⚡ *15m:* DOGE, ADA, LINK, NEAR, SUI, APT, PEPE, WIF, SHIB\n\n` +
      `🤖 Сигналы генерируются каждые 15 минут\n` +
      `💼 При сильном сигнале — автоматически открывается виртуальная сделка\n` +
      `🌅 Утром нажми *"Итоговый отчёт"* чтобы увидеть результаты\n\n` +
      `_Можешь ложиться спать — бот работает 24/7!_ 😴`,
      { parse_mode: "Markdown", ...mainMenu() }
    );
  });

  bot.action("menu_main", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Главное меню:", mainMenu());
  });

  bot.action("menu_signal", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "📊 *Выбери монету для анализа:*\n\n_Бот покажет направление, уровни и AI-оценку_",
      { parse_mode: "Markdown", ...pairsMenu("signal") }
    );
  });

  bot.action("menu_paper", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const stats = await getPaperStats(chatId);
    await ctx.reply(stats, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📂 Открыть сделку", "menu_paperopen"),
          Markup.button.callback("🔄 Обновить позиции", "papercheck"),
        ],
        [
          Markup.button.callback("🗑 Сбросить счёт", "paperreset_confirm"),
          Markup.button.callback("🏠 Меню", "menu_main"),
        ],
      ]),
    });
  });

  bot.action("menu_paperopen", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "💼 *Открыть виртуальную сделку*\n\nВыбери монету:",
      { parse_mode: "Markdown", ...pairsMenu("paperopen") }
    );
  });

  bot.action("papercheck", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const messages = await checkPaperPositions(chatId);
    if (messages.length === 0) {
      const account = await loadPaperAccount(chatId);
      if (account.positions.length === 0) {
        await ctx.reply("ℹ️ Нет открытых позиций.\n\nЖди авто-сигналов или открой сделку через меню 💼.");
      } else {
        await ctx.reply(`✅ ${account.positions.length} позиций открыты — TP/SL ещё не достигнуты.`);
      }
    } else {
      for (const msg of messages) {
        await ctx.reply(msg, { parse_mode: "Markdown" });
      }
    }
  });

  bot.action("paperreset_confirm", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "⚠️ Сбросить виртуальный счёт до $10 000?\n\nВсе позиции и история будут удалены.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Да, сбросить", "paperreset_do"),
          Markup.button.callback("❌ Отмена", "menu_paper"),
        ],
      ])
    );
  });

  bot.action("paperreset_do", async (ctx) => {
    await ctx.answerCbQuery();
    const { savePaperAccount } = await import("./storage.js");
    await savePaperAccount(ctx.chat!.id, {
      balance: 10000,
      initialBalance: 10000,
      positions: [],
      closedTrades: [],
    });
    await ctx.reply("✅ Счёт сброшен до $10,000", mainMenu());
  });

  bot.action("menu_journal", async (ctx) => {
    await ctx.answerCbQuery();
    const stats = await getJournalStats();
    await ctx.reply(stats, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🏠 Главное меню", "menu_main")],
      ]),
    });
  });

  bot.action("menu_report", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const report = await buildReport(chatId);
    await ctx.reply(report, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🏠 Главное меню", "menu_main")],
      ]),
    });
  });

  bot.action("menu_settings", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const s = await loadSettings(chatId);
    const subs = listSubscriptions(chatId);
    await ctx.reply(
      `⚙️ *Настройки*\n\n` +
      `🎯 Мин. оценка сигнала: *${s.minScore}/100*\n` +
      `⚖️ Риск на сделку: *${s.riskPercent}%*\n` +
      `💰 Размер счёта: *$${s.accountSize}*\n` +
      `🚫 Режим "не торговать": *${s.noTradeMode ? "ВКЛ" : "ВЫКЛ"}*\n` +
      `🤖 Авто-бумажные сделки: *${s.autoPaperTrade ? "ВКЛ ✅" : "ВЫКЛ ❌"}*\n` +
      `📡 Активных подписок: *${subs.length}*`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              s.autoPaperTrade ? "🤖 Авто-сделки: ВКЛ ✅" : "🤖 Авто-сделки: ВЫКЛ ❌",
              "toggle_autopaper"
            ),
          ],
          [
            Markup.button.callback(
              s.noTradeMode ? "🚫 Не торговать: ВКЛ" : "✅ Торговать: ВКЛ",
              "toggle_notrade"
            ),
          ],
          [
            Markup.button.callback("📡 Мои подписки", "menu_subs"),
            Markup.button.callback("🗑 Отключить всё", "unsub_all"),
          ],
          [Markup.button.callback("🏠 Главное меню", "menu_main")],
        ]),
      }
    );
  });

  bot.action("toggle_autopaper", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const s = await loadSettings(chatId);
    s.autoPaperTrade = !s.autoPaperTrade;
    await saveSettings(chatId, s);
    await ctx.reply(
      s.autoPaperTrade
        ? "🤖 Авто-сделки *включены* — при каждом хорошем сигнале открывается виртуальная позиция."
        : "❌ Авто-сделки *выключены*.",
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⚙️ Назад к настройкам", "menu_settings")]]) }
    );
  });

  bot.action("toggle_notrade", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const s = await loadSettings(chatId);
    s.noTradeMode = !s.noTradeMode;
    await saveSettings(chatId, s);
    await ctx.reply(
      s.noTradeMode ? "🚫 Режим «не торговать» включён." : "✅ Режим «торговать» включён.",
      Markup.inlineKeyboard([[Markup.button.callback("⚙️ Назад к настройкам", "menu_settings")]])
    );
  });

  bot.action("menu_subs", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const subs = listSubscriptions(chatId);
    if (subs.length === 0) {
      await ctx.reply(
        "📡 Нет активных подписок.\n\nНажми «🚀 Начать торговать» на главном экране чтобы подписаться на топ-5 монет.",
        Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню", "menu_main")]])
      );
    } else {
      const list = subs.map((s) => `• ${s.symbol} (${s.interval})`).join("\n");
      await ctx.reply(
        `📡 *Твои подписки (${subs.length}):*\n\n${list}\n\nСигналы каждые 15 мин ✅`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню", "menu_main")]]) }
      );
    }
  });

  bot.action("unsub_all", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat!.id;
    const count = unsubscribeAll(chatId);
    await ctx.reply(
      count > 0 ? `✅ Отключено ${count} подписок.` : "ℹ️ Подписок не было.",
      Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню", "menu_main")]])
    );
  });

  bot.action("menu_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `❓ *Помощь*\n\n` +
      `📊 *Сигнал* — анализ монеты: купить/продать/ждать\n` +
      `💼 *Мой счёт* — виртуальный счёт $10 000\n` +
      `📓 *Журнал* — история сигналов и статистика\n` +
      `🌅 *Отчёт* — итоги работы бота за всё время\n` +
      `⚙️ *Настройки* — авто-сделки, риск, подписки\n\n` +
      `*Что такое оценка сигнала?*\n` +
      `Бот считает от 0 до 100. 70+ = сильный сигнал.\n\n` +
      `*Что такое R/R?*\n` +
      `Соотношение прибыли к риску. 1:2 = на риск $1 ожидаем $2 прибыли.\n\n` +
      `*Что такое TP/SL?*\n` +
      `Take Profit (зафиксировать прибыль) и Stop Loss (остановить убыток).\n\n` +
      `_Команды: /signal, /paper, /journal, /settings, /report_`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Главное меню", "menu_main")]]) }
    );
  });

  for (const pair of POPULAR_PAIRS) {
    bot.action(`signal_${pair}`, async (ctx) => {
      await ctx.answerCbQuery(`Анализирую ${pair}...`);
      await doSignal(ctx, pair, "1h");
    });

    bot.action(`paperopen_${pair}`, async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const msg = await ctx.reply(`⏳ Получаю сигнал для *${pair}*...`, { parse_mode: "Markdown" });
      try {
        const sig = await generateSignal(pair, "1h", chatId);
        await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        if (sig.filtered || sig.score.direction === "NEUTRAL") {
          await ctx.reply(
            `⚠️ Сигнал не прошёл фильтры:\n${sig.filterReason ?? "Нет чёткого направления"}\n\nВиртуальная сделка не открыта.`,
            Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню", "menu_main")]])
          );
          return;
        }
        const settings = await loadSettings(chatId);
        const result = await openPaperPosition(
          chatId, pair, sig.score.direction,
          sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
          settings.riskPercent
        );
        await ctx.reply(result.message, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("💼 Мой счёт", "menu_paper"), Markup.button.callback("🏠 Меню", "menu_main")]]),
        });
      } catch (err) {
        logger.error({ err }, "Paper open error");
        await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        await ctx.reply("⚠️ Ошибка. Попробуй позже.");
      }
    });
  }

  bot.command("start", async (ctx) => {
    const name = ctx.from?.first_name ?? "трейдер";
    await ctx.reply(
      `👋 Привет, *${name}*!\n\n` +
      `Я торговый бот с искусственным интеллектом.\n\n` +
      `🔍 Анализирую крипторынок по 9+ индикаторам\n` +
      `🧠 Использую Gemini AI для оценки сигналов\n` +
      `📈 Веду виртуальный счёт и учусь на ошибках\n` +
      `🔔 Отправляю сигналы автоматически 24/7\n\n` +
      `_Не нужно ничего знать о торговле — я всё объясню!_`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Начать торговать", "onboard_start")],
        [Markup.button.callback("📖 Как это работает?", "onboard_how")],
      ])}
    );
  });

  bot.command("menu", async (ctx) => {
    await sendMainMenu(ctx, "Главное меню:");
  });

  bot.command("report", async (ctx) => {
    const report = await buildReport(ctx.chat.id);
    await ctx.reply(report, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Главное меню", "menu_main")]]),
    });
  });

  bot.command("signal", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const rawSymbol = args[0];
    if (!rawSymbol) {
      return ctx.reply("📊 Выбери монету:", pairsMenu("signal"));
    }
    const symbol = rawSymbol.toUpperCase();
    const interval: Interval = VALID_INTERVALS.includes(args[1] as Interval) ? args[1] as Interval : "1h";
    await doSignal(ctx, symbol, interval);
  });

  bot.command("paper", async (ctx) => {
    const stats = await getPaperStats(ctx.chat.id);
    await ctx.reply(stats, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📂 Открыть сделку", "menu_paperopen"), Markup.button.callback("🔄 Обновить", "papercheck")],
        [Markup.button.callback("🏠 Меню", "menu_main")],
      ]),
    });
  });

  bot.command("journal", async (ctx) => {
    const stats = await getJournalStats();
    await ctx.reply(stats, { parse_mode: "Markdown" });
  });

  bot.command("settings", async (ctx) => {
    const chatId = ctx.chat.id;
    const s = await loadSettings(chatId);
    const subs = listSubscriptions(chatId);
    await ctx.reply(
      `⚙️ *Настройки*\n\n` +
      `🤖 Авто-сделки: *${s.autoPaperTrade ? "ВКЛ ✅" : "ВЫКЛ ❌"}*\n` +
      `🎯 Мин. оценка: *${s.minScore}/100*\n` +
      `📡 Подписок: *${subs.length}*`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(s.autoPaperTrade ? "🤖 Авто-сделки: ВКЛ ✅" : "🤖 Авто-сделки: ВЫКЛ ❌", "toggle_autopaper")],
          [Markup.button.callback("📡 Подписки", "menu_subs"), Markup.button.callback("🏠 Меню", "menu_main")],
        ]),
      }
    );
  });

  bot.command("backtest", async (ctx) => {
    const args = parseArgs(ctx.message.text);
    const rawSymbol = args[0];
    if (!rawSymbol) {
      return ctx.reply("❌ Укажи пару. Например: /backtest BTCUSDT 1h");
    }
    const symbol = rawSymbol.toUpperCase();
    const interval: Interval = VALID_INTERVALS.includes(args[1] as Interval) ? args[1] as Interval : "1h";
    const loading = await ctx.reply(`⏳ Бэктест *${symbol}* (${interval})...`, { parse_mode: "Markdown" });
    try {
      const settings = await loadSettings(ctx.chat.id);
      const result = await runBacktest(symbol, interval, settings.minScore);
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
      await ctx.reply(result.summary, { parse_mode: "Markdown" });
    } catch {
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
      await ctx.reply("⚠️ Ошибка бэктеста. Попробуй другую пару.");
    }
  });

  bot.on("text", async (ctx) => {
    await ctx.reply("Выбери действие:", mainMenu());
  });

  bot.catch((err) => {
    logger.error({ err }, "Telegraf error");
  });

  return bot;
}

export async function startBot(): Promise<void> {
  try {
    const bot = createBot();
    await initSubscriptions();
    startScheduler(bot);
    bot.launch({ dropPendingUpdates: true });
    logger.info("Telegram bot started (long polling)");
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  } catch (err) {
    logger.error({ err }, "Failed to start Telegram bot");
  }
}
