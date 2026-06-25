import { Telegraf, Markup } from "telegraf";
  import { generateSignal, formatSignal } from "./signals.js";
  import { validateSymbol } from "./binance.js";
  import {
    subscribe, unsubscribe, unsubscribeAll,
    listSubscriptions, startScheduler, initSubscriptions,
  } from "./scheduler.js";
  import { runBacktest } from "./backtest.js";
  import {
    openPaperPosition, getPaperStats, checkPaperPositions,
  } from "./paper-trading.js";
  import { getJournalStats } from "./journal.js";
  import {
    loadSettings, saveSettings, loadPaperAccount, loadJournal, loadWeights,
  } from "./storage.js";
  import { buildSelfAnalysis } from "./self-analysis.js";
  import { getRiskStatus, resumeTrading } from "./risk-manager.js";
  import { getStrategyStatus, snapshotStrategy } from "./strategy-guard.js";
  import { getMissedStats } from "./missed-trades.js";
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
        Markup.button.callback("📊 Сигнал",           "menu_signal"),
        Markup.button.callback("💼 Мой счёт",          "menu_paper"),
      ],
      [
        Markup.button.callback("📓 Журнал",           "menu_journal"),
        Markup.button.callback("🌅 Отчёт",            "menu_report"),
      ],
      [
        Markup.button.callback("🧠 Самоанализ",       "menu_analysis"),
        Markup.button.callback("🛡 Риск",             "menu_risk"),
      ],
      [
        Markup.button.callback("⚙️ Настройки",        "menu_settings"),
        Markup.button.callback("❓ Помощь",           "menu_help"),
      ],
    ]);
  }

  function pairsMenu(action: string) {
    return Markup.inlineKeyboard([
      [ Markup.button.callback("₿ BTC","${action}_BTCUSDT"), Markup.button.callback("Ξ ETH","${action}_ETHUSDT"), Markup.button.callback("◎ SOL","${action}_SOLUSDT") ],
      [ Markup.button.callback("🔶 BNB","${action}_BNBUSDT"), Markup.button.callback("✕ XRP","${action}_XRPUSDT"), Markup.button.callback("🐶 DOGE","${action}_DOGEUSDT") ],
      [ Markup.button.callback("🔗 LINK","${action}_LINKUSDT"), Markup.button.callback("🌊 ADA","${action}_ADAUSDT"), Markup.button.callback("🔺 AVAX","${action}_AVAXUSDT") ],
      [ Markup.button.callback("🟣 NEAR","${action}_NEARUSDT"), Markup.button.callback("🔵 SUI","${action}_SUIUSDT"), Markup.button.callback("🅰 APT","${action}_APTUSDT") ],
      [ Markup.button.callback("🔴 OP","${action}_OPUSDT"), Markup.button.callback("🔷 ARB","${action}_ARBUSDT"), Markup.button.callback("⚛ ATOM","${action}_ATOMUSDT") ],
      [ Markup.button.callback("⬡ DOT","${action}_DOTUSDT"), Markup.button.callback("🌕 LTC","${action}_LTCUSDT"), Markup.button.callback("⚡ TRX","${action}_TRXUSDT") ],
      [ Markup.button.callback("🐸 PEPE","${action}_PEPEUSDT"), Markup.button.callback("🐕 WIF","${action}_WIFUSDT"), Markup.button.callback("🐕 SHIB","${action}_SHIBUSDT") ],
      [ Markup.button.callback("◀️ Назад","menu_main") ],
    ]);
  }

  function parseArgs(text: string): string[] { return text.trim().split(/s+/).slice(1); }

  async function sendMainMenu(ctx: any, text?: string) {
    await ctx.reply(text ?? "Выбери действие:", mainMenu());
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
          [ Markup.button.callback("📊 Ещё сигнал", "menu_signal"), Markup.button.callback("🏠 Меню", "menu_main") ],
        ]),
      });
    } catch (err) {
      logger.error({ err }, "Signal error");
      await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      await ctx.reply("⚠️ Ошибка при получении данных. Попробуй позже.");
    }
  }

  async function buildReport(chatId: number): Promise<string> {
    const [journal, account, weights] = await Promise.all([
      loadJournal(), loadPaperAccount(chatId), loadWeights(),
    ]);
    const subs = listSubscriptions(chatId);
    const mine   = journal.filter(e => e.chatId === chatId);
    const closed = mine.filter(e => e.closedAt);
    const open   = mine.filter(e => !e.closedAt);
    const wins   = closed.filter(e => (e.pnlPercent ?? 0) > 0);
    const losses = closed.filter(e => (e.pnlPercent ?? 0) <= 0);
    const wr     = closed.length ? (wins.length / closed.length) * 100 : 0;
    const avgWin = wins.length   ? wins.reduce((a,e)=>a+(e.pnlPercent??0),0)/wins.length : 0;
    const avgL   = losses.length ? Math.abs(losses.reduce((a,e)=>a+(e.pnlPercent??0),0)/losses.length) : 0;
    const pTrades= account.closedTrades;
    const pRet   = ((account.balance - account.initialBalance) / account.initialBalance) * 100;
    const pPnl   = pTrades.reduce((a,t)=>a+t.pnl,0);
    return [
      `🌅 *Итоговый отчёт*`, ``,
      `📡 *Подписки:* ${subs.length}`,
      subs.length ? subs.map(s=>`  • ${s.symbol} ${s.interval}`).join("\n") : "  нет подписок",
      ``,
      `📊 *Сигналы:* всего ${mine.length} | закрыто ${closed.length} | открыто ${open.length}`,
      closed.length ? `  WR: ${wr.toFixed(1)}% | Win: +${avgWin.toFixed(2)}% | Loss: -${avgL.toFixed(2)}%` : "  Ждём закрытых сигналов",
      ``,
      `💼 *Виртуальный счёт:* $${account.balance.toFixed(2)} (${pRet>=0?"+":""}${pRet.toFixed(2)}%)`,
      pTrades.length ? `  Сделок: ${pTrades.length} | P&L: ${pPnl>=0?"+":""}$${pPnl.toFixed(2)}` : "  Сделок пока нет",
      ``,
      `🧠 *Веса ИИ:* тренд ${(weights.trend*100).toFixed(0)}% | объём ${(weights.volume*100).toFixed(0)}% | импульс ${(weights.momentum*100).toFixed(0)}%`,
      ``,
      `⚠️ _Виртуальный счёт — не реальные деньги._`,
    ].join("\n");
  }

  export function createBot(): Telegraf {
    const token = process.env["TELEGRAM_BOT_TOKEN"];
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const bot = new Telegraf(token);

    // ── Onboarding ───────────────────────────────────────────────────────────
    bot.start(async (ctx) => {
      const name = ctx.from?.first_name ?? "трейдер";
      await ctx.reply(
        `👋 Привет, *${name}*!\n\n` +
        `Я торговый бот с ИИ-самообучением.\n\n` +
        `🔍 9+ индикаторов | 🧠 Gemini AI\n` +
        `📈 Виртуальный счёт $10,000\n` +
        `🔔 Авто-сигналы 24/7 (WebSocket)\n` +
        `🛡 Риск-менеджмент: -3%/день, -7%/нед.\n` +
        `📊 Самоанализ каждые 100 сделок\n\n` +
        `_Не нужно ничего знать о торговле!_`,
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
        `1️⃣ *Сигнал* — купить 🟢, продать 🔴, ждать ⚪\n` +
        `2️⃣ *Оценка /100* — только 70+ проходит фильтр\n` +
        `3️⃣ *Стоп-лосс* — авто-защита от потерь\n` +
        `4️⃣ *Trailing Stop* — стоп двигается за прибылью\n` +
        `5️⃣ *Безубыток* — стоп в 0 при +1R\n` +
        `6️⃣ *Риск-лимиты* — стоп после -3%/день или 3 убытков\n` +
        `7️⃣ *Самообучение* — ИИ корректирует веса после каждой сделки\n\n` +
        `⚠️ _Виртуальный счёт — не реальные деньги._`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🚀 Запустить!", "onboard_start")]]) }
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
        `✅ *Автоторговля запущена!*\n\n` +
        `Слежу за *21 монетой* в реальном времени (WebSocket)\n` +
        `🛡 Риск-лимиты: -3%/день, -7%/неделя, 3 убытка подряд\n` +
        `⚡ Trailing Stop + безубыток на каждой сделке\n` +
        `📊 Самоанализ: /analysis\n` +
        `🛡 Статус рисков: /risk\n\n` +
        `_Бот работает 24/7 — можешь ложиться спать! 😴_`,
        { parse_mode: "Markdown", ...mainMenu() }
      );
    });

    // ── Main menu actions ────────────────────────────────────────────────────
    bot.action("menu_main",     async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("Главное меню:", mainMenu()); });
    bot.action("menu_signal",   async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("📊 *Выбери монету:*", { parse_mode:"Markdown", ...pairsMenu("signal") }); });

    bot.action("menu_paper", async (ctx) => {
      await ctx.answerCbQuery();
      const stats = await getPaperStats(ctx.chat!.id);
      await ctx.reply(stats, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [ Markup.button.callback("📂 Открыть сделку","menu_paperopen"), Markup.button.callback("🔄 Проверить позиции","papercheck") ],
          [ Markup.button.callback("🗑 Сбросить счёт","paperreset_confirm"), Markup.button.callback("🏠 Меню","menu_main") ],
        ]),
      });
    });

    bot.action("menu_paperopen", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply("💼 *Открыть виртуальную сделку*\n\nВыбери монету:", { parse_mode:"Markdown", ...pairsMenu("paperopen") });
    });

    bot.action("papercheck", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const msgs = await checkPaperPositions(chatId);
      if (!msgs.length) {
        const acc = await loadPaperAccount(chatId);
        await ctx.reply(acc.positions.length ? `✅ ${acc.positions.length} позиций открыты — TP/SL не достигнуты.` : "ℹ️ Нет открытых позиций.");
      } else {
        for (const m of msgs) await ctx.reply(m, { parse_mode: "Markdown" });
      }
    });

    bot.action("paperreset_confirm", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply("⚠️ Сбросить счёт до $10,000? Все позиции будут удалены.",
        Markup.inlineKeyboard([[Markup.button.callback("✅ Да","paperreset_do"), Markup.button.callback("❌ Отмена","menu_paper")]]));
    });

    bot.action("paperreset_do", async (ctx) => {
      await ctx.answerCbQuery();
      const { savePaperAccount } = await import("./storage.js");
      await savePaperAccount(ctx.chat!.id, { balance:10000, initialBalance:10000, positions:[], closedTrades:[] });
      await ctx.reply("✅ Счёт сброшен до $10,000", mainMenu());
    });

    bot.action("menu_journal", async (ctx) => {
      await ctx.answerCbQuery();
      const stats = await getJournalStats();
      await ctx.reply(stats, { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню","menu_main")]]) });
    });

    bot.action("menu_report", async (ctx) => {
      await ctx.answerCbQuery();
      const report = await buildReport(ctx.chat!.id);
      await ctx.reply(report, { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню","menu_main")]]) });
    });

    // ── NEW: Self-Analysis ───────────────────────────────────────────────────
    bot.action("menu_analysis", async (ctx) => {
      await ctx.answerCbQuery();
      const loading = await ctx.reply("⏳ Анализирую последние сделки...");
      const analysis = await buildSelfAnalysis(ctx.chat!.id);
      await ctx.telegram.deleteMessage(ctx.chat!.id, loading.message_id).catch(()=>{});
      await ctx.reply(analysis, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [ Markup.button.callback("🛡 Статус рисков","menu_risk"), Markup.button.callback("🏠 Меню","menu_main") ],
        ]),
      });
    });

    // ── NEW: Risk Status ─────────────────────────────────────────────────────
    bot.action("menu_risk", async (ctx) => {
      await ctx.answerCbQuery();
      const status = await getRiskStatus();
      await ctx.reply(status, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [ Markup.button.callback("▶️ Возобновить торговлю","risk_resume"), Markup.button.callback("🛡 Защита стратегии","risk_protect") ],
          [ Markup.button.callback("🏠 Меню","menu_main") ],
        ]),
      });
    });

    bot.action("risk_resume", async (ctx) => {
      await ctx.answerCbQuery();
      await resumeTrading();
      await ctx.reply("✅ *Торговля возобновлена.*\n\nКонсекутивные убытки сброшены.", { parse_mode:"Markdown", ...mainMenu() });
    });

    bot.action("risk_protect", async (ctx) => {
      await ctx.answerCbQuery();
      const status = await getStrategyStatus();
      await ctx.reply(status, { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню","menu_main")]]) });
    });

    // ── Settings ─────────────────────────────────────────────────────────────
    bot.action("menu_settings", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const s = await loadSettings(chatId);
      const subs = listSubscriptions(chatId);
      await ctx.reply(
        `⚙️ *Настройки*\n\n` +
        `🤖 Авто-сделки: *${s.autoPaperTrade?"ВКЛ ✅":"ВЫКЛ ❌"}*\n` +
        `🎯 Мин. оценка: *${s.minScore}/100*\n` +
        `⚖️ Риск/сделку: *${s.riskPercent}%*\n` +
        `💰 Размер счёта: *$${s.accountSize}*\n` +
        `🚫 Не торговать: *${s.noTradeMode?"ВКЛ":"ВЫКЛ"}*\n` +
        `📡 Подписок: *${subs.length}*`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [ Markup.button.callback(s.autoPaperTrade?"🤖 Авто-сделки ✅":"🤖 Авто-сделки ❌","toggle_autopaper") ],
            [ Markup.button.callback(s.noTradeMode?"🚫 Не торговать: ВКЛ":"✅ Торговать: ВКЛ","toggle_notrade") ],
            [ Markup.button.callback("📡 Мои подписки","menu_subs"), Markup.button.callback("🗑 Отключить всё","unsub_all") ],
            [ Markup.button.callback("🏠 Главное меню","menu_main") ],
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
        s.autoPaperTrade ? "🤖 Авто-сделки *включены*." : "❌ Авто-сделки *выключены*.",
        { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⚙️ Назад","menu_settings")]]) }
      );
    });

    bot.action("toggle_notrade", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const s = await loadSettings(chatId);
      s.noTradeMode = !s.noTradeMode;
      await saveSettings(chatId, s);
      await ctx.reply(s.noTradeMode ? "🚫 Режим «не торговать» включён." : "✅ Режим «торговать» включён.",
        Markup.inlineKeyboard([[Markup.button.callback("⚙️ Назад","menu_settings")]]));
    });

    bot.action("menu_subs", async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const subs = listSubscriptions(chatId);
      if (!subs.length) {
        await ctx.reply("📡 Нет активных подписок.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню","menu_main")]]));
      } else {
        const list = subs.map(s=>`• ${s.symbol} (${s.interval})`).join("\n");
        await ctx.reply(`📡 *Твои подписки (${subs.length}):*\n\n${list}\n\nРеальный-тайм сигналы (WebSocket) ✅`,
          { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню","menu_main")]]) });
      }
    });

    bot.action("unsub_all", async (ctx) => {
      await ctx.answerCbQuery();
      const count = unsubscribeAll(ctx.chat!.id);
      await ctx.reply(count>0?`✅ Отключено ${count} подписок.`:"ℹ️ Подписок не было.",
        Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню","menu_main")]]));
    });

    bot.action("menu_help", async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply(
        `❓ *Помощь*\n\n` +
        `📊 /signal — сигнал для любой монеты\n` +
        `💼 /paper — виртуальный счёт и позиции\n` +
        `📓 /journal — журнал сигналов\n` +
        `🧠 /analysis — самоанализ (WR, PF, Шарп, просадка)\n` +
        `🛡 /risk — статус риск-менеджмента\n` +
        `▶️ /resume — возобновить торговлю после стопа\n` +
        `🔍 /backtest — бэктест на истории\n` +
        `⚙️ /settings — настройки\n\n` +
        `*Риск-лимиты:*\n` +
        `  • -3% в день → стоп до завтра\n` +
        `  • -7% в неделю → стоп до след. недели\n` +
        `  • 3 убытка подряд → ручной /resume\n` +
        `  • Макс. 3 открытых позиции\n\n` +
        `*Trailing Stop:* при +1R стоп в безубыток, затем тянется за ценой`,
        { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Главное меню","menu_main")]]) }
      );
    });

    // ── Pair action handlers ─────────────────────────────────────────────────
    for (const pair of POPULAR_PAIRS) {
      bot.action(`signal_${pair}`, async (ctx) => {
        await ctx.answerCbQuery(`Анализирую ${pair}...`);
        await doSignal(ctx, pair, "1h");
      });

      bot.action(`paperopen_${pair}`, async (ctx) => {
        await ctx.answerCbQuery();
        const chatId = ctx.chat!.id;
        const msg = await ctx.reply(`⏳ Получаю сигнал для *${pair}*...`, { parse_mode:"Markdown" });
        try {
          const sig = await generateSignal(pair, "1h", chatId);
          await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(()=>{});
          if (sig.filtered || sig.score.direction === "NEUTRAL") {
            await ctx.reply(`⚠️ ${sig.filterReason ?? "Нет чёткого направления"}`,
              Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню","menu_main")]]));
            return;
          }
          const settings = await loadSettings(chatId);
          const result = await openPaperPosition(chatId, pair, sig.score.direction,
            sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2, settings.riskPercent);
          await ctx.reply(result.message, {
            parse_mode:"Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("💼 Мой счёт","menu_paper"), Markup.button.callback("🏠 Меню","menu_main")]]),
          });
        } catch(err) {
          logger.error({err},"Paper open error");
          await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(()=>{});
          await ctx.reply("⚠️ Ошибка. Попробуй позже.");
        }
      });
    }

    // ── Text commands ────────────────────────────────────────────────────────
    bot.command("menu",     async (ctx) => { await sendMainMenu(ctx, "Главное меню:"); });
    bot.command("start",    async (ctx) => { await sendMainMenu(ctx, "👋 Привет! Выбери действие:"); });
    bot.command("report",   async (ctx) => { await ctx.reply(await buildReport(ctx.chat.id), { parse_mode:"Markdown" }); });
    bot.command("paper",    async (ctx) => { await ctx.reply(await getPaperStats(ctx.chat.id), { parse_mode:"Markdown" }); });
    bot.command("journal",  async (ctx) => { await ctx.reply(await getJournalStats(), { parse_mode:"Markdown" }); });

    bot.command("analysis", async (ctx) => {
      const loading = await ctx.reply("⏳ Анализирую сделки...");
      const text = await buildSelfAnalysis(ctx.chat.id);
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});
      await ctx.reply(text, { parse_mode:"Markdown" });
    });

    bot.command("risk", async (ctx) => {
      await ctx.reply(await getRiskStatus(), { parse_mode:"Markdown" });
    });

    bot.command("resume", async (ctx) => {
      await resumeTrading();
      await ctx.reply("✅ *Торговля возобновлена.* Убытки сброшены.", { parse_mode:"Markdown" });
    });

    bot.command("protect", async (ctx) => {
      await ctx.reply(await getStrategyStatus(), { parse_mode:"Markdown" });
    });

    bot.command("missed", async (ctx) => {
      await ctx.reply(await getMissedStats(), { parse_mode:"Markdown" });
    });

    bot.command("signal", async (ctx) => {
      const args = parseArgs(ctx.message.text);
      const rawSym = args[0];
      if (!rawSym) return ctx.reply("📊 Выбери монету:", pairsMenu("signal"));
      const sym = rawSym.toUpperCase();
      const iv: Interval = VALID_INTERVALS.includes(args[1] as Interval) ? args[1] as Interval : "1h";
      await doSignal(ctx, sym, iv);
    });

    bot.command("settings", async (ctx) => {
      const chatId = ctx.chat.id;
      const s = await loadSettings(chatId);
      const subs = listSubscriptions(chatId);
      await ctx.reply(
        `⚙️ *Настройки*\n\n` +
        `🤖 Авто-сделки: *${s.autoPaperTrade?"ВКЛ ✅":"ВЫКЛ ❌"}*\n` +
        `🎯 Мин. оценка: *${s.minScore}/100*\n` +
        `📡 Подписок: *${subs.length}*`,
        {
          parse_mode:"Markdown",
          ...Markup.inlineKeyboard([
            [ Markup.button.callback(s.autoPaperTrade?"🤖 Авто-сделки ✅":"🤖 Авто-сделки ❌","toggle_autopaper") ],
            [ Markup.button.callback("📡 Подписки","menu_subs"), Markup.button.callback("🏠 Меню","menu_main") ],
          ]),
        }
      );
    });

    bot.command("backtest", async (ctx) => {
      const args = parseArgs(ctx.message.text);
      if (!args[0]) return ctx.reply("❌ Пример: /backtest BTCUSDT 1h");
      const sym = args[0].toUpperCase();
      const iv: Interval = VALID_INTERVALS.includes(args[1] as Interval) ? args[1] as Interval : "1h";
      const loading = await ctx.reply(`⏳ Бэктест *${sym}* (${iv})...`, { parse_mode:"Markdown" });
      try {
        const settings = await loadSettings(ctx.chat.id);
        const result = await runBacktest(sym, iv, settings.minScore);
        await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
        await ctx.reply(result.summary, { parse_mode:"Markdown" });
      } catch {
        await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(()=>{});
        await ctx.reply("⚠️ Ошибка бэктеста. Попробуй другую пару.");
      }
    });

    bot.on("text", async (ctx) => { await ctx.reply("Выбери действие:", mainMenu()); });
    bot.catch((err) => logger.error({ err }, "Telegraf error"));

    return bot;
  }

  export async function startBot(): Promise<void> {
    try {
      const bot = createBot();
      await initSubscriptions();
      startScheduler(bot);
      bot.launch({ dropPendingUpdates: true });
      logger.info("Telegram bot started (long polling + WebSocket)");
      process.once("SIGINT", () => bot.stop("SIGINT"));
      process.once("SIGTERM", () => bot.stop("SIGTERM"));
    } catch (err) {
      logger.error({ err }, "Failed to start Telegram bot");
    }
  }
  