import { getPrice } from "./binance.js";
import {
  loadPaperAccount, saveBalance, insertPosition, deletePosition, updatePosition, insertClosedTrade, loadSettings, genId, addAccountCosts,
  type PaperPosition, type ClosedPaperTrade,
} from "./storage.js";
import { recordPositionClosed, recordPositionOpened } from "./risk-manager.js";
import { formatPrice } from "./risk.js";
import { recordStrategyTrade, type StrategyName } from "./strategies.js";
import { checkNewPeak, checkMilestone } from "./notifications.js";
import { logger } from "../lib/logger.js";
import { recordRegimeTrade, recordLossReason, classifyLossReason, type MarketRegime } from "./learning-engine.js";
import { recordTimeTrade } from "./time-analytics.js";
import { recordInstrumentTrade } from "./instrument-analytics.js";
import { updateTradeResult } from "./similar-trades.js";

// Position → market regime map (populated at open, consumed at close)
const positionRegimes = new Map<string, MarketRegime>();

// ── Realistic execution constants ──────────────────────────────────────────
/** Commission per side (0.1% — KuCoin taker fee) */
const COMMISSION_RATE = 0.001;
/** Slippage range: min 0.02%, max 0.10% (realistic for KuCoin liquid pairs <$20k notional) */
const SLIPPAGE_MIN_PCT = 0.0002;
const SLIPPAGE_MAX_PCT = 0.001;
/**
 * Max position notional as fraction of account balance (25%).
 * Prevents going all-in on a single trade when stop is tight.
 * With 10 max positions this implies up to 250% total exposure (≈2.5x leverage cap).
 */
const MAX_POSITION_NOTIONAL_PCT = 0.25;

/** Generate random slippage fraction */
function randomSlippagePct(): number {
  return SLIPPAGE_MIN_PCT + Math.random() * (SLIPPAGE_MAX_PCT - SLIPPAGE_MIN_PCT);
}

/** Helper: record one closed leg (partial or full) and return the notification message */
function buildCloseRecord(
  pos: PaperPosition,
  closePrice: number,
  size: number,
  outcome: string,
  equityAtOpen: number
): { trade: ClosedPaperTrade; pnl: number; pnlPct: number; pnlEquityPct: number; realisticPrice: number; commission: number; slippage: number } {
  const slipPct = randomSlippagePct();
  const realisticPrice = pos.direction === "LONG"
    ? closePrice * (1 - slipPct)
    : closePrice * (1 + slipPct);
  const slippage   = Math.abs(closePrice - realisticPrice) * size;
  const commission = realisticPrice * size * COMMISSION_RATE;
  const rawPnl = pos.direction === "LONG"
    ? (realisticPrice - pos.entryPrice) * size
    : (pos.entryPrice - realisticPrice) * size;
  const pnl    = rawPnl - commission;
  const pnlPct = pos.direction === "LONG"
    ? ((realisticPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - realisticPrice) / pos.entryPrice) * 100;
  const pnlEquityPct = equityAtOpen > 0 ? (pnl / equityAtOpen) * 100 : 0;

  const trade: ClosedPaperTrade = {
    id: genId(), symbol: pos.symbol, direction: pos.direction,
    entryPrice: pos.entryPrice, closePrice: realisticPrice, size,
    pnl, pnlPercent: pnlPct, outcome,
    strategy: pos.strategy ?? "TREND",
    openedAt: pos.openedAt, closedAt: new Date().toISOString(),
    commission, slippage, pnlEquityPct,
  };
  return { trade, pnl, pnlPct, pnlEquityPct, realisticPrice, commission, slippage };
}

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
  let size       = stopDist > 0 ? maxLoss / stopDist : 0;
  if (size <= 0) return {success:false,message:"❌ Ошибка расчёта размера позиции"};

  // ── Notional cap: max 25% of balance per position ──────────────────────
  const maxNotional = account.balance * MAX_POSITION_NOTIONAL_PCT;
  const rawNotional = size * entryPrice;
  if (rawNotional > maxNotional) {
    size = maxNotional / entryPrice;
  }

  // ── Partial entry: open 60% now, add remaining 40% on pullback ─────────
  // Requires ATR to set the pullback trigger level.
  let pendingEntrySize: number | undefined;
  let pendingEntryTrigger: number | undefined;
  if (atr != null && atr > 0) {
    const initialSize   = size * 0.6;
    pendingEntrySize    = size * 0.4;
    pendingEntryTrigger = direction === "LONG"
      ? entryPrice - atr * 0.3   // wait for slight dip
      : entryPrice + atr * 0.3;  // wait for slight bounce
    size = initialSize;
  }

  const notional = size * entryPrice;

  const existing = account.positions.find(p=>p.symbol===symbol&&p.direction===direction);
  if (existing) return {success:false,message:`⚠️ Позиция ${symbol} ${direction} уже открыта`};

  // ── Realistic: deduct open commission from balance ─────────────────────
  const openCommission = entryPrice * size * COMMISSION_RATE;
  account.balance -= openCommission;
  addAccountCosts(chatId, openCommission, 0).catch(() => {});

  const pos: PaperPosition = {
    id:genId(), symbol, direction, entryPrice, size,
    stopLoss, tp1, tp2, openedAt:new Date().toISOString(),
    chatId, strategy, breakevenMoved:false, trailAtr:atr??null,
    equityAtOpen: account.balance,
    pendingEntrySize, pendingEntryTrigger,
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
      `Размер: ${size.toFixed(4)} ед. | Объём: $${notional.toFixed(2)}\n` +
      `Риск: $${(size * stopDist).toFixed(2)} (${rp}% депозита)${rawNotional > maxNotional ? ` ⚠️ обрезано с $${rawNotional.toFixed(0)}` : ""}\n` +
      (pendingEntrySize != null && pendingEntryTrigger != null
        ? `📥 Вход частями: ещё ${pendingEntrySize.toFixed(4)} ед. при откате до \`${formatPrice(pendingEntryTrigger)}\`\n`
        : "") +
      `Комиссия открытия: -$${openCommission.toFixed(2)}`
  };
}

/** Returns string[] of alert messages — fires on TP/SL/BE/partial close */
export async function checkPaperPositions(
  chatId: number,
  sendNotification?: (msg: string) => Promise<void>
): Promise<string[]> {
  const account  = await loadPaperAccount(chatId);
  const msgs: string[] = [];
  const remaining: PaperPosition[] = [];

  const stratNames: Record<string, string> = {
    TREND:"Тренд", BREAKOUT:"Пробой",
    VOLUME_IMPULSE:"Импульс", MEAN_REVERSION:"Возврат к ср.",
  };

  for (const pos of account.positions) {
    try {
      const price = await getPrice(pos.symbol);
      const equityAtOpen = pos.equityAtOpen ?? account.initialBalance;
      const stratLabel = stratNames[pos.strategy ?? "TREND"] ?? pos.strategy ?? "TREND";
      const dirLabel   = pos.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";

      // ── Pending Second Entry: fill remaining 40% on pullback ──────────────
      if (pos.pendingEntrySize != null && pos.pendingEntrySize > 0 && pos.pendingEntryTrigger != null) {
        const filled = (pos.direction === "LONG"  && price <= pos.pendingEntryTrigger) ||
                       (pos.direction === "SHORT" && price >= pos.pendingEntryTrigger);
        if (filled) {
          const addSize = pos.pendingEntrySize;
          const addCommission = price * addSize * COMMISSION_RATE;
          account.balance -= addCommission;
          addAccountCosts(chatId, addCommission, 0).catch(() => {});
          // Recalculate blended entry price
          const blended = (pos.entryPrice * pos.size + price * addSize) / (pos.size + addSize);
          pos.entryPrice = blended;
          pos.size += addSize;
          pos.pendingEntrySize = undefined;
          pos.pendingEntryTrigger = undefined;
          msgs.push(
            `📥 *Второй вход — ${pos.symbol}*\n` +
            `${dirLabel} | +${addSize.toFixed(4)} ед. по \`${formatPrice(price)}\`\n` +
            `Средний вход: \`${formatPrice(blended)}\` | Комиссия: -$${addCommission.toFixed(2)}\n` +
            `_Полная позиция набрана_`
          );
        }
      }

      // ── Trailing stop: after TP1 partial (breakevenMoved), trail by 1.0×ATR ─
      if (pos.breakevenMoved && pos.trailAtr != null && pos.trailAtr > 0) {
        const trail = pos.direction === "LONG"
          ? price - pos.trailAtr * 1.0
          : price + pos.trailAtr * 1.0;
        if (pos.direction === "LONG"  && trail > pos.stopLoss) pos.stopLoss = trail;
        if (pos.direction === "SHORT" && trail < pos.stopLoss) pos.stopLoss = trail;
      }

      // ── Early Breakeven: unrealized profit ≥ 2× initial risk ──────────────
      // Fires while en route to TP1 (before partial close).
      // Guard: SL not yet at entry prevents re-triggering after BE move.
      if (!pos.breakevenMoved) {
        const originalStopDist = Math.abs(pos.entryPrice - pos.stopLoss);
        const unrealizedGain   = pos.direction === "LONG"
          ? price - pos.entryPrice
          : pos.entryPrice - price;
        const slNotAtEntry = pos.direction === "LONG"
          ? pos.stopLoss < pos.entryPrice
          : pos.stopLoss > pos.entryPrice;
        if (slNotAtEntry && originalStopDist > 0 && unrealizedGain >= 2 * originalStopDist) {
          pos.stopLoss = pos.entryPrice;
          msgs.push(
            `📌 *Стоп → безубыток — ${pos.symbol}*\n` +
            `${dirLabel} | Прибыль достигла 2× риска\n` +
            `Стоп перенесён в точку входа: \`${formatPrice(pos.entryPrice)}\`\n` +
            `_Позиция теперь без риска убытка_`
          );
        }
      }

      // ── TP1 Partial Close: 50% at TP1, move SL to breakeven ───────────────
      // Fires only once (breakevenMoved guards re-entry).
      const tp1Hit = !pos.breakevenMoved && (
        (pos.direction === "LONG"  && price >= pos.tp1) ||
        (pos.direction === "SHORT" && price <= pos.tp1)
      );

      if (tp1Hit) {
        const partialSize = pos.size * 0.5;
        const { trade, pnl, pnlPct, pnlEquityPct, realisticPrice, commission, slippage } =
          buildCloseRecord(pos, pos.tp1, partialSize, "TP1", equityAtOpen);

        account.balance += pnl;
        account.closedTrades.unshift(trade);
        await insertClosedTrade(chatId, trade);
        addAccountCosts(chatId, commission, slippage).catch(() => {});
        recordStrategyTrade(pos.strategy ?? "TREND", pnlEquityPct, true).catch(() => {});

        // Update position: halve size, move SL to breakeven, cancel pending entry
        pos.size              = pos.size * 0.5;
        pos.stopLoss          = pos.entryPrice;
        pos.breakevenMoved    = true;
        pos.pendingEntrySize  = undefined;
        pos.pendingEntryTrigger = undefined;

        // ── Pyramiding: add 50% of remaining (= 25% of original) at TP1 price ──
        // SL is now at breakeven → zero extra risk on pyramid units.
        const pyramidUnits      = pos.size * 0.5;
        const pyramidCommission = realisticPrice * pyramidUnits * COMMISSION_RATE;
        let pyramidNote = "";
        if (account.balance > pyramidCommission * 2) {
          account.balance -= pyramidCommission;
          pos.size        += pyramidUnits;
          addAccountCosts(chatId, pyramidCommission, 0).catch(() => {});
          pyramidNote = `\n📈 *Пирамидинг*: +${pyramidUnits.toFixed(4)} ед. добавлено по TP1 (риска нет — стоп в BE)\n` +
                        `Итого в позиции: ${pos.size.toFixed(4)} ед. → TP2: \`${formatPrice(pos.tp2)}\``;
        }

        msgs.push(
          `🎯 *ЧАСТИЧНОЕ ЗАКРЫТИЕ — ${pos.symbol}*\n` +
          `${dirLabel} | TP1 зафиксировано 50% | ${stratLabel}\n` +
          `Вход: \`${formatPrice(pos.entryPrice)}\` → TP1: \`${formatPrice(realisticPrice)}\`\n` +
          `P&L (50%): *+${pnl.toFixed(2)}* (+${pnlPct.toFixed(2)}%)\n` +
          `💸 комиссия -$${commission.toFixed(2)} | слипп -$${slippage.toFixed(2)}\n` +
          `📌 Стоп → безубыток` +
          pyramidNote + `\n` +
          `💰 Баланс: *${account.balance.toFixed(2)}*`
        );

        remaining.push(pos);
        continue;
      }

      // ── Full Close: SL / BE / TP2 ─────────────────────────────────────────
      let closeReason: string | null = null;
      let closePrice = price;

      if (pos.direction === "LONG") {
        if (price <= pos.stopLoss) { closeReason = pos.breakevenMoved ? "BE" : "SL"; closePrice = pos.stopLoss; }
        else if (price >= pos.tp2) { closeReason = "TP2"; closePrice = pos.tp2; }
      } else {
        if (price >= pos.stopLoss) { closeReason = pos.breakevenMoved ? "BE" : "SL"; closePrice = pos.stopLoss; }
        else if (price <= pos.tp2) { closeReason = "TP2"; closePrice = pos.tp2; }
      }

      if (closeReason) {
        const { trade, pnl, pnlPct, pnlEquityPct, realisticPrice, commission, slippage } =
          buildCloseRecord(pos, closePrice, pos.size, closeReason, equityAtOpen);

        account.balance += pnl;
        account.closedTrades.unshift(trade);
        await insertClosedTrade(chatId, trade);
        addAccountCosts(chatId, commission, slippage).catch(() => {});
        recordStrategyTrade(pos.strategy ?? "TREND", pnlEquityPct, pnl > 0).catch(() => {});

        const regime = positionRegimes.get(pos.id) ?? "sideways";
        positionRegimes.delete(pos.id);
        recordRegimeTrade(pos.strategy ?? "TREND" as StrategyName, regime as MarketRegime, pnlEquityPct, pnl > 0).catch(() => {});
        recordTimeTrade(pos.openedAt, pnlEquityPct, pnl > 0).catch(() => {});
        recordInstrumentTrade(pos.symbol, pos.strategy ?? "TREND" as StrategyName, pnlEquityPct, pnl > 0).catch(() => {});
        if (pnl <= 0 && (closeReason === "SL" || closeReason === "BE")) {
          const lossReason = classifyLossReason(pos.strategy ?? "TREND" as StrategyName, regime as MarketRegime, closeReason);
          recordLossReason(pos.strategy ?? "TREND" as StrategyName, lossReason).catch(() => {});
        }
        updateTradeResult(pos.id, pnlEquityPct, pnl > 0, closeReason).catch(() => {});

        const isProfit    = pnl > 0;
        const isBreakeven = closeReason === "BE";
        const isTP2       = closeReason === "TP2";
        const wasPartial  = pos.breakevenMoved && (closeReason === "TP2" || isBreakeven);

        const header = isBreakeven
          ? `🟡 БЕЗУБЫТОК — ${pos.symbol}`
          : isTP2
          ? `🚀 ПРОФИТ TP2 — ${pos.symbol}`
          : isProfit
          ? `✅ ПРОФИТ — ${pos.symbol}`
          : `❌ УБЫТОК — ${pos.symbol}`;

        const partialNote = wasPartial ? ` _(50% остаток)_` : "";
        const costsBreakdown = `комиссия -$${commission.toFixed(2)} | слипп -$${slippage.toFixed(2)}`;

        const closeMsg = isBreakeven
          ? `*${header}*\n` +
            `${dirLabel} | ${stratLabel}${partialNote}\n` +
            `Вход: \`${formatPrice(pos.entryPrice)}\` → Закрыто: \`${formatPrice(realisticPrice)}\`\n` +
            `P&L: *≈$0* (стоп был в точке входа)\n` +
            `💸 В P&L учтено: ${costsBreakdown}\n` +
            `💰 Баланс: *${account.balance.toFixed(2)}*`
          : `*${header}*\n` +
            `${dirLabel} | ${closeReason}${pos.breakevenMoved ? " 📌" : ""} | ${stratLabel}${partialNote}\n` +
            `Вход: \`${formatPrice(pos.entryPrice)}\` → Закрыто: \`${formatPrice(realisticPrice)}\`\n` +
            `P&L: *${isProfit?"+":""}${pnl.toFixed(2)}* (${isProfit?"+":""}${pnlPct.toFixed(2)}%)\n` +
            `💸 В P&L учтено: ${costsBreakdown}\n` +
            `💼 Депозит: *${pnlEquityPct >= 0 ? "+" : ""}${pnlEquityPct.toFixed(3)}%*\n` +
            `💰 Баланс: *${account.balance.toFixed(2)}*`;

        msgs.push(closeMsg);

        const riskAlert = await recordPositionClosed((pnl/(account.balance-pnl+0.001))*100, pnl>0);
        if (riskAlert) msgs.push(riskAlert);

        if (sendNotification) {
          await checkNewPeak(chatId, account.balance, account.peakBalance ?? account.balance, sendNotification);
          await checkMilestone(chatId, account.balance, account.initialBalance, sendNotification);
        }
        if (account.balance > (account.peakBalance ?? 0)) account.peakBalance = account.balance;
      } else {
        remaining.push(pos);
      }
    } catch(err) {
      logger.warn({err,symbol:pos.symbol},"checkPaperPositions: getPrice failed");
      remaining.push(pos);
    }
  }

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
  const totalComm = account.totalCommission ?? 0;
  const totalSlip = account.totalSlippage ?? 0;

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
    `💸 Комиссии: -$${totalComm.toFixed(2)} | Проскальзывание: -$${totalSlip.toFixed(2)}`,
    `Потери на издержках: -$${(totalComm + totalSlip).toFixed(2)} (${account.initialBalance > 0 ? ((totalComm + totalSlip) / account.initialBalance * 100).toFixed(2) : "0"}% депозита)`, "",
    `📂 Открытых позиций (${account.positions.length}/10):`,
    ...posLines,
  ].join("\n");
}
