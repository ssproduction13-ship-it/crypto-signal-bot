import { getPrice } from "./binance.js";
import {
  loadPaperAccount, savePaperAccount, saveBalance, insertPosition, deletePosition, updatePosition, insertClosedTrade, loadSettings, genId,
  type PaperPosition, type ClosedPaperTrade,
} from "./storage.js";
import { recordPositionClosed, recordPositionOpened, canOpenTrade } from "./risk-manager.js";
import { formatPrice } from "./risk.js";
import { recordStrategyTrade, type StrategyName } from "./strategies.js";
import { checkNewPeak, checkDrawdown, checkMilestone } from "./notifications.js";
import { logger } from "../lib/logger.js";
  import { recordRegimeTrade, recordLossReason, classifyLossReason, type MarketRegime } from "./learning-engine.js";
  import { recordTimeTrade } from "./time-analytics.js";
  import { recordInstrumentTrade } from "./instrument-analytics.js";
  import { updateTradeResult } from "./similar-trades.js";
// Position → market regime map (populated at open, consumed at close)
const positionRegimes = new Map<string, MarketRegime>();


export async function openPaperPosition(
  chatId: number, symbol: string, direction: "LONG"|"SHORT",
  entryPrice: number, stopLoss: number, tp1: number, tp2: number,
  riskPercent?: number, atr?: number,
  strategy: StrategyName = "TREND",
  marketRegime: MarketRegime = "sideways"
): Promise<{success:boolean;message:string;position?:PaperPosition}> {
  const account  = await loadPaperAccount(chatId);
  const settings = await loadSettings(chatId);
  const rp = riskPercent ?? settings.riskPercent;
  const maxLoss  = account.balance * (rp / 100);
  const stopDist = Math.abs(entryPrice - stopLoss);
  const size     = stopDist > 0 ? maxLoss / stopDist : 0;
  if (size <= 0) return {success:false,message:"❌ Ошибка расчёта размера позиции"};

  const existing = account.positions.find(p=>p.symbol===symbol&&p.direction===direction);
  if (existing) return {success:false,message:`⚠️ Позиция ${symbol} ${direction} уже открыта`};
  if (account.positions.length >= 10) return {success:false,message:"⚠️ Макс. 10 позиций открыто"};

  const pos: PaperPosition = {
    id:genId(), symbol, direction, entryPrice, size,
    stopLoss, tp1, tp2, openedAt:new Date().toISOString(),
    chatId, strategy, breakevenMoved:false, trailAtr:atr??null,
  };
  account.positions.push(pos);
  await insertPosition(chatId, pos);
  positionRegimes.set(pos.id, marketRegime);
    await saveBalance(chatId, account.balance, account.initialBalance, account.peakBalance);
  await recordPositionOpened();

  const stratNames: Record<string, string> = {
    TREND:"📈 Тренд", BREAKOUT:"🚀 Пробой",
    VOLUME_IMPULSE:"⚡ Объёмный импульс", MEAN_REVERSION:"↩️ Возврат к среднему",
  };

  return {
    success:true, position:pos,
    message:
      `✅ *Виртуальная позиция открыта*\n\n` +
      `${direction==="LONG"?"🟢 LONG":"🔴 SHORT"} ${symbol}\n` +
      `Стратегия: ${stratNames[strategy] ?? strategy}\n` +
      `Вход: ${formatPrice(entryPrice)}\n` +
      `Стоп: ${formatPrice(stopLoss)}\n` +
      `TP1: ${formatPrice(tp1)} | TP2: ${formatPrice(tp2)}\n` +
      `Размер: ${size.toFixed(4)} ед. | Риск: $${maxLoss.toFixed(2)}`
  };
}

/** Returns string[] of alert messages — fires on TP/SL/BE close only */
export async function checkPaperPositions(
  chatId: number,
  sendNotification?: (msg: string) => Promise<void>
): Promise<string[]> {
  const account  = await loadPaperAccount(chatId);
  const msgs: string[] = [];
  const remaining: PaperPosition[] = [];

  for (const pos of account.positions) {
    try {
      const price = await getPrice(pos.symbol);

      // Breakeven: move SL when position reaches +1R
      if (!pos.breakevenMoved && pos.trailAtr != null) {
        const r1   = Math.abs(pos.tp1 - pos.entryPrice);
        const gain = pos.direction==="LONG" ? price-pos.entryPrice : pos.entryPrice-price;
        if (gain >= r1) {
          pos.stopLoss = pos.entryPrice;
          pos.breakevenMoved = true;
          msgs.push(`🟡 *${pos.symbol}*: стоп перенесён в безубыток (${formatPrice(pos.entryPrice)})`);
        }
      }

      // Trailing stop: after breakeven, trail by 1.5×ATR
      if (pos.breakevenMoved && pos.trailAtr != null && pos.trailAtr > 0) {
        const trail = pos.direction==="LONG"
          ? price - pos.trailAtr * 1.5
          : price + pos.trailAtr * 1.5;
        if (pos.direction==="LONG"  && trail > pos.stopLoss) pos.stopLoss = trail;
        if (pos.direction==="SHORT" && trail < pos.stopLoss) pos.stopLoss = trail;
      }

      // Check close conditions
      let closeReason: string|null = null, closePrice = price;
      if (pos.direction==="LONG") {
        if (price<=pos.stopLoss)  { closeReason=pos.breakevenMoved?"BE":"SL"; closePrice=pos.stopLoss; }
        else if (price>=pos.tp2)  { closeReason="TP2"; closePrice=pos.tp2; }
        else if (price>=pos.tp1)  { closeReason="TP1"; closePrice=pos.tp1; }
      } else {
        if (price>=pos.stopLoss)  { closeReason=pos.breakevenMoved?"BE":"SL"; closePrice=pos.stopLoss; }
        else if (price<=pos.tp2)  { closeReason="TP2"; closePrice=pos.tp2; }
        else if (price<=pos.tp1)  { closeReason="TP1"; closePrice=pos.tp1; }
      }

      if (closeReason) {
        const pnl = pos.direction==="LONG"
          ? (closePrice-pos.entryPrice)*pos.size
          : (pos.entryPrice-closePrice)*pos.size;
        const pnlPct = pos.direction==="LONG"
          ? ((closePrice-pos.entryPrice)/pos.entryPrice)*100
          : ((pos.entryPrice-closePrice)/pos.entryPrice)*100;

        const trade: ClosedPaperTrade = {
          id:genId(), symbol:pos.symbol, direction:pos.direction,
          entryPrice:pos.entryPrice, closePrice, size:pos.size,
          pnl, pnlPercent:pnlPct, outcome:closeReason,
          strategy: pos.strategy ?? "TREND",
          openedAt:pos.openedAt, closedAt:new Date().toISOString(),
        };
        account.balance += pnl;
        account.closedTrades.unshift(trade);
        await insertClosedTrade(chatId, trade);

        // Record strategy stat
        recordStrategyTrade(pos.strategy ?? "TREND", pnlPct, pnl > 0).catch(() => {});

          // Self Learning Engine v2: record analytics
          const regime = positionRegimes.get(pos.id) ?? "sideways";
          positionRegimes.delete(pos.id);
          recordRegimeTrade(pos.strategy ?? "TREND" as StrategyName, regime as MarketRegime, pnlPct, pnl > 0).catch(() => {});
          recordTimeTrade(pos.openedAt, pnlPct, pnl > 0).catch(() => {});
          recordInstrumentTrade(pos.symbol, pos.strategy ?? "TREND" as StrategyName, pnlPct, pnl > 0).catch(() => {});
          // Record loss reason for SL/BE losses
          if (pnl <= 0 && (closeReason === "SL" || closeReason === "BE")) {
            const lossReason = classifyLossReason(pos.strategy ?? "TREND" as StrategyName, regime as MarketRegime, closeReason);
            recordLossReason(pos.strategy ?? "TREND" as StrategyName, lossReason).catch(() => {});
          }
          // AI Learning Engine v3: update trade features with result
          updateTradeResult(pos.id, pnlPct, pnl > 0, closeReason).catch(() => {});

        const isProfit = pnl > 0;
        const isBreakeven = closeReason === "BE";
        const header = isBreakeven
          ? `🟡 БЕЗУБЫТОК — ${pos.symbol}`
          : closeReason === "TP2"
          ? `🚀 ПРОФИТ — ${pos.symbol}`
          : isProfit
          ? `✅ ПРОФИТ — ${pos.symbol}`
          : `❌ УБЫТОК — ${pos.symbol}`;
        const stratNames: Record<string, string> = {
          TREND:"Тренд", BREAKOUT:"Пробой",
          VOLUME_IMPULSE:"Импульс", MEAN_REVERSION:"Возврат к ср.",
        };
        const stratLabel = stratNames[pos.strategy ?? "TREND"] ?? pos.strategy ?? "TREND";
        const dirLabel   = pos.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
        const closeMsg = isBreakeven
          ? `*${header}*\n` +
            `${dirLabel} | ${stratLabel}\n` +
            `Вход: \`${formatPrice(pos.entryPrice)}\` → Закрыто: \`${formatPrice(closePrice)}\`\n` +
            `P&L: *≈$0* (стоп был в точке входа)\n` +
            `💰 Баланс: *${account.balance.toFixed(2)}*`
          : `*${header}*\n` +
            `${dirLabel} | ${closeReason} | ${stratLabel}\n` +
            `Вход: \`${formatPrice(pos.entryPrice)}\` → Закрыто: \`${formatPrice(closePrice)}\`\n` +
            `P&L: *${isProfit?"+":""}${pnl.toFixed(2)}* (${isProfit?"+":""}${pnlPct.toFixed(2)}%)\n` +
            `💰 Баланс: *${account.balance.toFixed(2)}*`;
        msgs.push(closeMsg);

        const riskAlert = await recordPositionClosed((pnl/(account.balance-pnl+0.001))*100, pnl>0);
        if (riskAlert) msgs.push(riskAlert);

        // Notifications: peak, drawdown, milestone
        if (sendNotification) {
          const peak = Math.max(account.balance, account.peakBalance ?? account.balance);
          await checkNewPeak(chatId, account.balance, account.peakBalance ?? account.balance, sendNotification);
          await checkDrawdown(chatId, account.balance, peak, sendNotification);
          await checkMilestone(chatId, account.balance, account.initialBalance, sendNotification);
        }
        // Update peak
        if (account.balance > (account.peakBalance ?? 0)) account.peakBalance = account.balance;
      } else {
        remaining.push(pos);
      }
    } catch(err) {
      logger.warn({err,symbol:pos.symbol},"checkPaperPositions: getPrice failed");
      remaining.push(pos);
    }
  }

  // Atomic: remove closed positions individually, update modified ones (no race condition)
    const remainingIds = new Set(remaining.map(p => p.id));
    for (const p of account.positions) {
      if (!remainingIds.has(p.id)) await deletePosition(chatId, p.id);
      else await updatePosition(chatId, p);
    }
    account.positions = remaining;
  await saveBalance(chatId, account.balance, account.initialBalance, account.peakBalance);
  return msgs;
}

export async function getPaperStats(chatId: number): Promise<string> {
  const account = await loadPaperAccount(chatId);
  const trades  = account.closedTrades;
  const wins    = trades.filter(t=>t.pnl>0);
  const losses  = trades.filter(t=>t.pnl<=0);
  const avgW    = wins.length   ? wins.reduce((a,t)=>a+t.pnlPercent,0)/wins.length   : 0;
  const avgL    = losses.length ? Math.abs(losses.reduce((a,t)=>a+t.pnlPercent,0)/losses.length) : 0;
  const gW      = wins.reduce((a,t)=>a+t.pnl,0);
  const gL      = Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  const pf      = gL>0 ? gW/gL : gW>0?999:0;
  const ret     = ((account.balance-account.initialBalance)/account.initialBalance)*100;

  const posLines = account.positions.length===0
    ? ["  нет открытых позиций"]
    : account.positions.map(p=>{
        const dir = p.direction==="LONG"?"🟢":"🔴";
        const be  = p.breakevenMoved?" [BE✓]":"";
        return `  ${dir} ${p.symbol} @ ${formatPrice(p.entryPrice)}${be} | SL: ${formatPrice(p.stopLoss)}`;
      });

  return [
    `💼 *Виртуальный счёт*`, "",
    `Баланс: *$${account.balance.toFixed(2)}*`,
    `${ret>=0?"📈":"📉"} P&L: ${ret>=0?"+":""}${ret.toFixed(2)}%`, "",
    `📊 Сделок: ${trades.length} | WR: ${trades.length?(wins.length/trades.length*100).toFixed(1):0}%`,
    `Win avg: +${avgW.toFixed(2)}% | Loss avg: -${avgL.toFixed(2)}%`,
    `Profit Factor: ${pf===999?"∞":pf.toFixed(2)}`, "",
    `📂 Открытых позиций (${account.positions.length}/10):`,
    ...posLines,
  ].join("\n");
}
