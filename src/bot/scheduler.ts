import cron from "node-cron";
  import type { Telegraf } from "telegraf";
  import { generateSignal } from "./signals.js";
  import { checkPaperPositions, openPaperPosition, getPaperStats } from "./paper-trading.js";
  import { canOpenTrade } from "./risk-manager.js";
  import { loadSettings, loadPaperAccount } from "./storage.js";
  import { kuCoinWs } from "./websocket.js";
  import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";
  import type { Interval } from "./binance.js";

  interface Sub { chatId: number; symbol: string; interval: Interval; }
  const subs    = new Map<string, Sub>();
  const chatIds = new Set<number>();
  let _bot: Telegraf | null = null;

  // Debounce: prevent opening the same symbol twice within one candle
  const recentlyProcessed = new Map<string, number>();
  const DEBOUNCE_MS = 60_000; // 1 minute per symbol

  function key(chatId: number, symbol: string) { return `${chatId}:${symbol}`; }

  async function safeSend(chatId: number, text: string) {
    try { await _bot?.telegram.sendMessage(chatId, text, { parse_mode: "Markdown" }); }
    catch (err) { logger.error({ err, chatId }, "safeSend failed"); }
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────
  export async function initSubscriptions(): Promise<void> {
    const { rows } = await pool.query("SELECT chat_id,symbol,interval FROM subscriptions");
    for (const r of rows as Record<string, unknown>[]) {
      const chatId = Number(r["chat_id"]);
      const sym    = r["symbol"] as string;
      const intv   = r["interval"] as Interval;
      subs.set(key(chatId, sym), { chatId, symbol: sym, interval: intv });
      chatIds.add(chatId);
      kuCoinWs.addSubscription(sym, intv);
    }
    logger.info({ count: subs.size }, "Subscriptions restored");
  }

  export function subscribe(chatId: number, symbol: string, interval: Interval = "1h"): void {
    subs.set(key(chatId, symbol), { chatId, symbol, interval });
    chatIds.add(chatId);
    kuCoinWs.addSubscription(symbol, interval);
    pool.query(
      "INSERT INTO subscriptions(chat_id,symbol,interval) VALUES($1,$2,$3) ON CONFLICT(chat_id,symbol) DO UPDATE SET interval=EXCLUDED.interval",
      [chatId, symbol, interval]
    ).catch((err: unknown) => logger.error({ err }, "subscribe DB error"));
  }

  export function unsubscribe(chatId: number, symbol: string): boolean {
    const sub     = subs.get(key(chatId, symbol));
    const removed = subs.delete(key(chatId, symbol));
    if (sub && ![...subs.values()].some(s => s.symbol === symbol && s.interval === sub.interval))
      kuCoinWs.removeSubscription(symbol, sub.interval);
    if (![...subs.values()].some(s => s.chatId === chatId)) chatIds.delete(chatId);
    pool.query("DELETE FROM subscriptions WHERE chat_id=$1 AND symbol=$2", [chatId, symbol])
      .catch((err: unknown) => logger.error({ err }, "unsubscribe DB error"));
    return removed;
  }

  export function unsubscribeAll(chatId: number): number {
    let n = 0;
    for (const [k, s] of subs.entries()) if (s.chatId === chatId) { subs.delete(k); n++; }
    chatIds.delete(chatId);
    pool.query("DELETE FROM subscriptions WHERE chat_id=$1", [chatId])
      .catch((err: unknown) => logger.error({ err }, "unsubscribeAll DB error"));
    return n;
  }

  export function listSubscriptions(chatId: number): Sub[] {
    return [...subs.values()].filter(s => s.chatId === chatId);
  }

  // ── Signal analysis — SILENT, only notifies when trade opens ─────────────
  const AUTO_MIN_SCORE = 55;

  async function analyzeAndTrade(sub: Sub): Promise<void> {
    // Debounce: skip if this symbol was processed recently
    const debounceKey = `${sub.chatId}:${sub.symbol}`;
    const lastRun = recentlyProcessed.get(debounceKey) ?? 0;
    if (Date.now() - lastRun < DEBOUNCE_MS) return;
    recentlyProcessed.set(debounceKey, Date.now());

    try {
      // Silent analysis — no messages regardless of result
      const sig = await generateSignal(sub.symbol, sub.interval, sub.chatId);

      if (sig.market.isChaotic) return;
      if (sig.score.direction === "NEUTRAL") return;
      if (sig.score.total < AUTO_MIN_SCORE) return;

      const settings = await loadSettings(sub.chatId);
      if (!settings.autoPaperTrade) return;

      const account  = await loadPaperAccount(sub.chatId);
      const openSyms = account.positions.map(p => p.symbol);
      const { allowed, reason } = await canOpenTrade(sub.symbol, openSyms);

      if (!allowed) {
        // Only log risk stops — no spam messages for routine limits
        if (reason.includes("DAILY_LIMIT") || reason.includes("WEEKLY_LIMIT") || reason.includes("3 убытка")) {
          await safeSend(sub.chatId, `🛑 *Торговля остановлена*\n${reason}`);
        }
        return;
      }

      // Open the trade
      const res = await openPaperPosition(
        sub.chatId, sub.symbol, sig.score.direction,
        sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
        settings.riskPercent, sig.risk.atr
      );

      if (res.success) {
        const dir   = sig.score.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
        const score = sig.score.total;
        logger.info({ symbol: sub.symbol, score, dir: sig.score.direction }, "Auto trade opened");

        // ONE message only — when trade opens
        await safeSend(sub.chatId,
          `🤖 *Новая позиция*\n\n` +
          `${dir} *${sub.symbol}*\n` +
          `Оценка: ${score}/100\n` +
          `Вход: \`${sig.risk.entryPrice.toPrecision(6)}\`\n` +
          `Стоп: \`${sig.risk.stopLoss.toPrecision(6)}\`\n` +
          `TP1: \`${sig.risk.tp1.toPrecision(6)}\` | TP2: \`${sig.risk.tp2.toPrecision(6)}\``
        );
      }
    } catch (err) {
      logger.error({ err, symbol: sub.symbol }, "analyzeAndTrade error");
    }
  }

  // ── WebSocket: new candle completed → analyze ─────────────────────────────
  async function onNewCandle(symbol: string, interval: string): Promise<void> {
    for (const sub of subs.values()) {
      if (sub.symbol === symbol && sub.interval === interval)
        void analyzeAndTrade(sub);   // fire-and-forget, non-blocking
    }
  }

  // ── Position monitor: check TP/SL every 30 seconds ───────────────────────
  async function checkPositions(): Promise<void> {
    for (const chatId of chatIds) {
      const msgs = await checkPaperPositions(chatId).catch(() => []);
      for (const m of msgs) await safeSend(chatId, m);   // only fires on close
    }
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  export function startScheduler(bot: Telegraf): void {
    _bot = bot;

    // Real-time WebSocket — triggers on each completed candle
    kuCoinWs.onNewCandle((sym, iv) => void onNewCandle(sym, iv));
    kuCoinWs.start().catch(err => logger.error({ err }, "KuCoin WS start error"));
    initSubscriptions().catch(err => logger.error({ err }, "initSubscriptions error"));

    // Position monitor every 30 seconds — checks TP/SL, trailing stop, breakeven
    // Only sends message when position actually closes
    setInterval(() => { void checkPositions(); }, 30_000);

    // Silent fallback: re-analyze all subscriptions every 30 min
    // (catches candles WebSocket might miss — NO messages, only opens trades)
    cron.schedule("*/30 * * * *", async () => {
      if (!subs.size) return;
      logger.debug({ count: subs.size }, "Silent fallback scan");
      for (const sub of subs.values()) void analyzeAndTrade(sub);
    });

    logger.info("Scheduler started — silent 24/7 mode (WS + 30s position check + 30min fallback)");
  }
  