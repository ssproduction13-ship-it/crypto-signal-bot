import cron from "node-cron";
  import type { Telegraf } from "telegraf";
  import { generateSignal, formatSignal } from "./signals.js";
  import { checkOpenSignals } from "./journal.js";
  import { checkPaperPositions, openPaperPosition } from "./paper-trading.js";
  import { canOpenTrade, loadRiskState } from "./risk-manager.js";
  import { loadSettings, loadPaperAccount } from "./storage.js";
  import { checkMissedTrades } from "./missed-trades.js";
  import { checkAndProtect } from "./strategy-guard.js";
  import { kuCoinWs } from "./websocket.js";
  import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";
  import type { Interval } from "./binance.js";

  interface Sub { chatId:number; symbol:string; interval:Interval; }
  const subs = new Map<string,Sub>();
  const chatIds = new Set<number>();
  let _bot: Telegraf|null = null;

  function key(chatId:number, symbol:string) { return `${chatId}:${symbol}`; }

  async function safeSend(chatId:number, text:string) {
    try { await _bot?.telegram.sendMessage(chatId,text,{parse_mode:"Markdown"}); }
    catch(err){ logger.error({err,chatId},"safeSend failed"); }
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────
  export async function initSubscriptions(): Promise<void> {
    const {rows} = await pool.query("SELECT chat_id,symbol,interval FROM subscriptions");
    for (const r of rows as Record<string,unknown>[]) {
      const chatId=Number(r["chat_id"]), sym=r["symbol"] as string, intv=r["interval"] as Interval;
      subs.set(key(chatId,sym),{chatId,symbol:sym,interval:intv});
      chatIds.add(chatId);
      kuCoinWs.addSubscription(sym,intv);
    }
    logger.info({count:subs.size},"Subscriptions restored from DB");
  }

  export function subscribe(chatId:number, symbol:string, interval:Interval="1h"): void {
    subs.set(key(chatId,symbol),{chatId,symbol,interval});
    chatIds.add(chatId);
    kuCoinWs.addSubscription(symbol,interval);
    pool.query(
      "INSERT INTO subscriptions(chat_id,symbol,interval) VALUES($1,$2,$3) ON CONFLICT(chat_id,symbol) DO UPDATE SET interval=EXCLUDED.interval",
      [chatId,symbol,interval]
    ).catch((err:unknown)=>logger.error({err},"subscribe DB error"));
  }

  export function unsubscribe(chatId:number, symbol:string): boolean {
    const sub = subs.get(key(chatId,symbol));
    const removed = subs.delete(key(chatId,symbol));
    if (sub && ![...subs.values()].some(s=>s.symbol===symbol&&s.interval===sub.interval))
      kuCoinWs.removeSubscription(symbol,sub.interval);
    if(![...subs.values()].some(s=>s.chatId===chatId)) chatIds.delete(chatId);
    pool.query("DELETE FROM subscriptions WHERE chat_id=$1 AND symbol=$2",[chatId,symbol])
      .catch((err:unknown)=>logger.error({err},"unsubscribe DB error"));
    return removed;
  }

  export function unsubscribeAll(chatId:number): number {
    let n=0;
    for(const [k,s] of subs.entries()) if(s.chatId===chatId){subs.delete(k);n++;}
    chatIds.delete(chatId);
    pool.query("DELETE FROM subscriptions WHERE chat_id=$1",[chatId])
      .catch((err:unknown)=>logger.error({err},"unsubscribeAll DB error"));
    return n;
  }

  export function listSubscriptions(chatId:number): Sub[] {
    return [...subs.values()].filter(s=>s.chatId===chatId);
  }

  // ── Auto-trade on new candle ──────────────────────────────────────────────
  async function processSignal(sub: Sub): Promise<void> {
    try {
      const sig = await generateSignal(sub.symbol, sub.interval, sub.chatId);
      await safeSend(sub.chatId, `🔔 *Авто-сигнал*\n\n${formatSignal(sig)}`);

      if (!sig.filtered && sig.score.direction!=="NEUTRAL") {
        const settings = await loadSettings(sub.chatId);
        if (!settings.autoPaperTrade) return;

        const account    = await loadPaperAccount(sub.chatId);
        const openSyms   = account.positions.map(p=>p.symbol);
        const {allowed,reason} = await canOpenTrade(sub.symbol.toUpperCase(), openSyms);
        if (!allowed) {
          await safeSend(sub.chatId, `⚠️ Авто-сделка заблокирована: ${reason}`);
          return;
        }
        const res = await openPaperPosition(
          sub.chatId, sub.symbol, sig.score.direction,
          sig.risk.entryPrice, sig.risk.stopLoss, sig.risk.tp1, sig.risk.tp2,
          settings.riskPercent, sig.risk.atr??undefined
        );
        if (res.success) await safeSend(sub.chatId,
          `🤖 *Авто-сделка открыта*\n${res.message}`);
      }
    } catch(err){ logger.error({err,sub},"processSignal error"); }
  }

  // ── WebSocket handler ─────────────────────────────────────────────────────
  async function onNewCandle(symbol: string, interval: string): Promise<void> {
    for (const sub of subs.values()) {
      if (sub.symbol===symbol && sub.interval===interval)
        await processSignal(sub);
    }
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  export function startScheduler(bot: Telegraf): void {
    _bot = bot;

    // Real-time WebSocket
    kuCoinWs.onNewCandle((sym,iv) => void onNewCandle(sym,iv));
    kuCoinWs.start().catch(err=>logger.error({err},"WS start error"));
    initSubscriptions().catch(err=>logger.error({err},"initSubscriptions error"));

    // Position monitor every 5 min — check TP/SL, trailing stop, missed trades
    cron.schedule("*/5 * * * *", async () => {
      for (const chatId of chatIds) {
        const msgs = await checkPaperPositions(chatId).catch(()=>[]);
        for (const m of msgs) await safeSend(chatId,m);
      }
      // Check open journal signals
      const results = await checkOpenSignals().catch(()=>[]);
      for (const {message} of results)
        for (const chatId of chatIds) await safeSend(chatId,message);
      // Check missed trades outcomes
      const missedMsgs = await checkMissedTrades().catch(()=>[]);
      for (const m of missedMsgs)
        for (const chatId of chatIds) await safeSend(chatId,m);
      // Strategy protection check (every ~hour via 12×5min)
      const alert = await checkAndProtect().catch(()=>null);
      if (alert) for (const chatId of chatIds) await safeSend(chatId,alert);
    });

    // Fallback scan every 15 min (catches candles WS might miss)
    cron.schedule("*/15 * * * *", async () => {
      if (!subs.size) return;
      for (const sub of subs.values()) await processSignal(sub);
    });

    logger.info("Scheduler started — WS real-time + 5min monitor + 15min fallback");
  }
  