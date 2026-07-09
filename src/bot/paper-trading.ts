import { getPrice } from "./binance.js";
import {
  loadPaperAccount, saveBalance, insertPosition, deletePosition, updatePosition, insertClosedTrade, loadSettings, genId, addAccountCosts,
  tryClaimPosition, tryMarkTP1, updateJournalClose, closePositionAndInsertTrade,
  type PaperPosition, type ClosedPaperTrade,
} from "./storage.js";
import { recordPositionClosed, recordPositionOpened } from "./risk-manager.js";
import { formatPrice } from "./risk.js";
import { recordStrategyTrade, type StrategyName } from "./strategies.js";
import { checkNewPeak, checkMilestone } from "./notifications.js";
import { logger } from "../lib/logger.js";
import { pool } from "../lib/db.js";
import { getActiveVariantId, recordABTrade } from "./ab-testing.js";
import { recordRegimeTrade, recordDirectionTrade, recordLossReason, classifyLossReason, type MarketRegime } from "./learning-engine.js";
import { recordTimeTrade } from "./time-analytics.js";
import { recordInstrumentTrade } from "./instrument-analytics.js";
import { updateTradeResult } from "./similar-trades.js";
import { recordInstrumentRegimeTrade } from "./instrument-regime-stats.js";
import { recordEntitySymbolResult } from "./entity-cooldown.js";


// ── Per-signal PnL accumulator for combined win rate (Variant B) ─────────────
// Stores TP1 PnL per posId so the final close records ONE stat entry (signal = 1 trade).

// ── Realistic execution constants ──────────────────────────────────────────
/** Commission per side (0.1% — KuCoin taker fee) */
const COMMISSION_RATE = 0.001;
/** Slippage range: min 0.02%, max 0.10% */
const SLIPPAGE_MIN_PCT = 0.0002;
const SLIPPAGE_MAX_PCT = 0.001;
const MAX_POSITION_NOTIONAL_PCT = 0.25;

function randomSlippagePct(): number {
  return SLIPPAGE_MIN_PCT + Math.random() * (SLIPPAGE_MAX_PCT - SLIPPAGE_MIN_PCT);
}

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
    strategy: pos.strategy ?? "UNKNOWN",
    openedAt: pos.openedAt, closedAt: new Date().toISOString(),
    commission, slippage, pnlEquityPct,
    entity: `${pos.strategy ?? "UNKNOWN"}_${pos.direction}`,
  };
  return { trade, pnl, pnlPct, pnlEquityPct, realisticPrice, commission, slippage };
}

export async function openPaperPosition(
  chatId: number, symbol: string, direction: "LONG"|"SHORT",
  entryPrice: number, stopLoss: number, tp1: number, tp2: number,
  riskPercent?: number, atr?: number,
  strategy: StrategyName = "UNKNOWN",
  marketRegime: MarketRegime = "sideways",
  interval: string = "1h"
): Promise<{success:boolean;message:string;position?:PaperPosition}> {
  const account  = await loadPaperAccount(chatId);
  const settings = await loadSettings(chatId);
  const rp = riskPercent ?? settings.riskPercent;
  const maxLoss  = account.balance * (rp / 100);
  const stopDist = Math.abs(entryPrice - stopLoss);
  let size       = stopDist > 0 ? maxLoss / stopDist : 0;
  if (size <= 0) return {success:false,message:"❌ Ошибка расчёта размера позиции"};

  const maxNotional = account.balance * MAX_POSITION_NOTIONAL_PCT;
  const rawNotional = size * entryPrice;
  if (rawNotional > maxNotional) {
    size = maxNotional / entryPrice;
  }

  let pendingEntrySize: number | undefined;
  let pendingEntryTrigger: number | undefined;
  if (atr != null && atr > 0) {
    const initialSize   = size * 0.6;
    pendingEntrySize    = size * 0.4;
    pendingEntryTrigger = direction === "LONG"
      ? entryPrice - atr * 0.3
      : entryPrice + atr * 0.3;
    size = initialSize;
  }

  const notional = size * entryPrice;

  const existing = account.positions.find(p=>p.symbol===symbol&&p.direction===direction);
  if (existing) return {success:false,message:`⚠️ Позиция ${symbol} ${direction} уже открыта`};

  const openCommission = entryPrice * size * COMMISSION_RATE;
  // L3: floor at 0 — accumulated commissions must never push balance negative
  account.balance = Math.max(0, account.balance - openCommission);
  addAccountCosts(chatId, openCommission, 0).catch(() => {});

  const pos: PaperPosition = {
    id:genId(), symbol, direction, entryPrice, size,
    stopLoss, tp1, tp2, openedAt:new Date().toISOString(),
    chatId, strategy, breakevenMoved:false, trailAtr:atr??null,
    equityAtOpen: account.balance,
    pendingEntrySize, pendingEntryTrigger, marketRegime, interval,
    riskPercent: rp,
  };
  account.positions.push(pos);
  await insertPosition(chatId, pos);
  await saveBalance(chatId, account.balance, account.initialBalance, account.peakBalance);
  await recordPositionOpened();

  const stratNames: Record<string, string> = {
    TREND:"📈 Тренд", BREAKOUT:"🚀 Пробой",
    VOLUME_IMPULSE:"⚡ Объёмный импульс", MEAN_REVERSION:"↩️ Возврат к среднему",
    UNKNOWN:"❓ Нет стратегии",
  };

  return {
    success:true, position:pos,
    message:
      `✅ *Виртуальная позиция открыта*\n\n` +
      `${direction==="LONG"?"⬆️ LONG":"⬇️ SHORT"} ${symbol}\n` +
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
  // FIX Critical#7: fetch active A/B variant once per checkPaperPositions cycle
  const abVariantId = await getActiveVariantId().catch(() => 1);

  const stratNames: Record<string, string> = {
    TREND:"Тренд", BREAKOUT:"Пробой",
    VOLUME_IMPULSE:"Импульс", MEAN_REVERSION:"Возврат к ср.",
  };

  for (const pos of account.positions) {
    try {
      const price = await getPrice(pos.symbol);
      const equityAtOpen = pos.equityAtOpen ?? account.initialBalance;
      const stratLabel = stratNames[pos.strategy ?? "UNKNOWN"] ?? pos.strategy ?? "UNKNOWN";
      const dirLabel   = pos.direction === "LONG" ? "⬆️ LONG" : "⬇️ SHORT";

        // ── Position Timeout ─────────────────────────────────────────────────────
        if (!pos.breakevenMoved) {
          const hoursOpen = (Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000;
          const iv = pos.interval ?? "1h";
          const maxHours = iv === "15m" ? 48 : iv === "4h" ? 120 : 72;
          if (hoursOpen > maxHours) {
            const { trade: _toTrade, pnl: _toPnl, pnlPct, pnlEquityPct, realisticPrice, commission, slippage } =
              buildCloseRecord(pos, price, pos.size, "TIMEOUT", equityAtOpen);
            // FIX Critical#5: atomic delete+insert in one transaction
            const claimed = await closePositionAndInsertTrade(chatId, pos.id, _toTrade);
            if (claimed) {
              const trade = _toTrade; const pnl = _toPnl;
              account.balance += pnl;
              account.closedTrades.unshift(trade);
              addAccountCosts(chatId, commission, slippage).catch(() => {});
              recordStrategyTrade(pos.strategy ?? "UNKNOWN", pnlEquityPct, pnl > 0).catch(() => {});
              // FIX Critical#7: record in active A/B variant
              recordABTrade(abVariantId, pnlEquityPct, pnl > 0).catch(() => {});
              const regime = pos.marketRegime ?? "sideways";
              recordRegimeTrade((pos.strategy ?? "UNKNOWN") as StrategyName, regime as MarketRegime, pnlEquityPct, pnl > 0, pos.interval ?? "ALL").catch(() => {});
              recordTimeTrade(pos.openedAt, pnlEquityPct, pnl > 0).catch(() => {});
              recordInstrumentTrade(pos.symbol, (pos.strategy ?? "UNKNOWN") as StrategyName, pnlEquityPct, pnl > 0).catch(() => {});
              recordInstrumentRegimeTrade(pos.symbol, pos.direction, regime as MarketRegime, pnlEquityPct, pnl > 0).catch(() => {});
              updateTradeResult(pos.id, pnlEquityPct, pnl > 0, "TIMEOUT").catch(() => {});
              updateJournalClose(chatId, pos.symbol, pos.direction, realisticPrice, "TIMEOUT", pnlPct, pos.id).catch(() => {});
              if (account.balance > (account.peakBalance ?? 0)) account.peakBalance = account.balance;
              const timeoutMsg =
                `⏱ *Позиция закрыта по таймауту — ${pos.symbol} ${pos.direction}*\n` +
                `${dirLabel} | Открыта ${Math.floor(hoursOpen)}ч. назад\n` +
                `Вход: \`${formatPrice(pos.entryPrice)}\` → Закрыто: \`${formatPrice(realisticPrice)}\`\n` +
                `P&L: *${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}* (${pnlPct.toFixed(2)}%)\n` +
                `💰 Баланс: *${account.balance.toFixed(2)}*`;
              msgs.push(timeoutMsg);
              if (sendNotification) await sendNotification(timeoutMsg).catch(() => {});
              continue;
            }
          }
        }

        // ── Stale Position Early Timeout ─────────────────────────────────────────────────────────────
        {
          const hoursOpenStale = (Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000;
          const ivStale = pos.interval ?? "1h";
          const pnlSign = pos.direction === "LONG" ? 1 : -1;
          const rawPnlPct = pnlSign * (price - pos.entryPrice) / pos.entryPrice * 100;
          const isStale = Math.abs(rawPnlPct) < 0.1;
          const staleThreshold1h  = hoursOpenStale > 24 && ivStale === "1h";
          const staleThreshold15m = hoursOpenStale > 12 && ivStale === "15m";

          if (isStale && (staleThreshold1h || staleThreshold15m)) {
            const { trade: _stTrade, pnl: _stPnl, pnlPct, pnlEquityPct, realisticPrice, commission, slippage } =
              buildCloseRecord(pos, price, pos.size, "TIMEOUT_STALE", equityAtOpen);
            // FIX Critical#5: atomic delete+insert in one transaction
            const claimed = await closePositionAndInsertTrade(chatId, pos.id, _stTrade);
            if (claimed) {
              const trade = _stTrade; const pnl = _stPnl;
              account.balance += pnl;
              account.closedTrades.unshift(trade);
              addAccountCosts(chatId, commission, slippage).catch(() => {});
              recordStrategyTrade(pos.strategy ?? "UNKNOWN", pnlEquityPct, pnl > 0).catch(() => {});
              // FIX Critical#7: record in active A/B variant
              recordABTrade(abVariantId, pnlEquityPct, pnl > 0).catch(() => {});
              const regimeStale = pos.marketRegime ?? "sideways";
              recordRegimeTrade((pos.strategy ?? "UNKNOWN") as StrategyName, regimeStale as MarketRegime, pnlEquityPct, pnl > 0, pos.interval ?? "ALL").catch(() => {});
              recordTimeTrade(pos.openedAt, pnlEquityPct, pnl > 0).catch(() => {});
              recordInstrumentTrade(pos.symbol, (pos.strategy ?? "UNKNOWN") as StrategyName, pnlEquityPct, pnl > 0).catch(() => {});
              recordInstrumentRegimeTrade(pos.symbol, pos.direction, regimeStale as MarketRegime, pnlEquityPct, pnl > 0).catch(() => {});
              updateTradeResult(pos.id, pnlEquityPct, pnl > 0, "TIMEOUT_STALE").catch(() => {});
              updateJournalClose(chatId, pos.symbol, pos.direction, realisticPrice, "TIMEOUT_STALE", pnlPct, pos.id).catch(() => {});
              if (account.balance > (account.peakBalance ?? 0)) account.peakBalance = account.balance;
              const staleMsg =
                `⏱ *Позиция закрыта — нет движения ${pos.symbol} ${pos.direction} (${Math.floor(hoursOpenStale)}ч)*\n`
                + `Вход: \`${formatPrice(pos.entryPrice)}\` → Закрыто: \`${formatPrice(realisticPrice)}\`\n`
                + `P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)\n`
                + `💰 Баланс: *${account.balance.toFixed(2)}*`;
              msgs.push(staleMsg);
              if (sendNotification) await sendNotification(staleMsg).catch(() => {});
              continue;
            }
          }
        }

      // ── Pending Second Entry: fill remaining 40% on pullback ──────────────
      if (pos.pendingEntrySize != null && pos.pendingEntrySize > 0 && pos.pendingEntryTrigger != null) {
        const filled = (pos.direction === "LONG"  && price <= pos.pendingEntryTrigger) ||
                       (pos.direction === "SHORT" && price >= pos.pendingEntryTrigger);
        if (filled) {
          const addSize = pos.pendingEntrySize;
          const addCommission = price * addSize * COMMISSION_RATE;
          account.balance = Math.max(0, account.balance - addCommission); // L3
          addAccountCosts(chatId, addCommission, 0).catch(() => {});
          const blended = (pos.entryPrice * pos.size + price * addSize) / (pos.size + addSize);
          pos.entryPrice = blended;
          pos.size += addSize;
          pos.pendingEntrySize = undefined;
          pos.pendingEntryTrigger = undefined;
          const secondEntryMsg =
            `📥 *Второй вход — ${pos.symbol}*\n` +
            `${dirLabel} | +${addSize.toFixed(4)} ед. по \`${formatPrice(price)}\`\n` +
            `Средний вход: \`${formatPrice(blended)}\` | Комиссия: -${addCommission.toFixed(2)}\n` +
            `_Полная позиция набрана_`;
          msgs.push(secondEntryMsg);
          if (sendNotification) await sendNotification(secondEntryMsg).catch(() => {});
        }
      }

      // ── Trailing stop ──────────────────────────────────────────────────────
      if (pos.breakevenMoved && pos.trailAtr != null && pos.trailAtr > 0) {
        const trail = pos.direction === "LONG"
          ? price - pos.trailAtr * 1.0
          : price + pos.trailAtr * 1.0;
        if (pos.direction === "LONG"  && trail > pos.stopLoss) pos.stopLoss = trail;
        if (pos.direction === "SHORT" && trail < pos.stopLoss) pos.stopLoss = trail;
      }

      // ── Early Breakeven ────────────────────────────────────────────────────
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
          const beMsg =
            `📌 *Стоп → безубыток — ${pos.symbol}*\n` +
            `${dirLabel} | Прибыль достигла 2× риска\n` +
            `Стоп перенесён в точку входа: \`${formatPrice(pos.entryPrice)}\`\n` +
            `_Позиция теперь без риска убытка_`;
          msgs.push(beMsg);
          if (sendNotification) await sendNotification(beMsg).catch(() => {});
        }
      }

      // ── TP1 Partial Close ──────────────────────────────────────────────────
      // Guard: breakevenMoved=false ensures this fires only once per position.
      // Additional atomic guard: tryMarkTP1 prevents double-fire in concurrent cycles.
      const tp1Hit = !pos.breakevenMoved && (
        (pos.direction === "LONG"  && price >= pos.tp1) ||
        (pos.direction === "SHORT" && price <= pos.tp1)
      );

      if (tp1Hit) {
        // Atomically claim TP1 processing — if another concurrent cycle beat us, skip
        const tp1Claimed = await tryMarkTP1(chatId, pos.id);
        if (!tp1Claimed) {
          // Another cycle already processed TP1 for this position — keep it in remaining
          remaining.push(pos);
          continue;
        }

        const partialSize = pos.size * 0.5;
        const { trade, pnl, pnlPct, pnlEquityPct, realisticPrice, commission, slippage } =
          buildCloseRecord(pos, pos.tp1, partialSize, "TP1", equityAtOpen);

        account.balance += pnl;
        account.closedTrades.unshift(trade);
        await insertClosedTrade(chatId, trade);
        addAccountCosts(chatId, commission, slippage).catch(() => {});
        // TP1 partial close: accounting only — stats recorded at final close (1 trade per signal)
        updateTradeResult(pos.id, pnlEquityPct, true, "TP1").catch(() => {});
        updateJournalClose(chatId, pos.symbol, pos.direction, realisticPrice, "TP1", pnlPct, pos.id).catch(() => {});
        recordPositionClosed((pnl / (account.balance - pnl + 0.001)) * 100, true).catch(() => {});

        pos.size              = pos.size * 0.5;
        pos.stopLoss          = pos.entryPrice;
        pos.breakevenMoved    = true;
        pos.pendingEntrySize  = undefined;
        pos.pendingEntryTrigger = undefined;

        // ── Pyramiding ────────────────────────────────────────────────────────
        const pyramidUnits      = pos.size * 0.5;
        const pyramidCommission = realisticPrice * pyramidUnits * COMMISSION_RATE;
        const entityForPyramid = `${pos.strategy ?? "UNKNOWN"}_${pos.direction}`;
        const { rows: pyramidEntityRows } = await pool.query(
          "SELECT quarantine, weight FROM strategy_entity_weights WHERE entity=$1",
          [entityForPyramid]
        ).catch(() => ({ rows: [] as Record<string, unknown>[] }));

        // Текущий час UTC
        const pyramidHour = new Date().getUTCHours();
        const FORCED_BLOCKED_HOURS = new Set([0, 1, 2, 3]);

        // ATR процент от цены
        const atrPercent = pos.trailAtr != null && realisticPrice > 0
          ? (pos.trailAtr / realisticPrice) * 100
          : 0;

        // Мягкий карантин — weight < 0.40
        const pyramidWeight = pyramidEntityRows.length > 0
          ? Number((pyramidEntityRows[0] as Record<string,unknown>)["weight"] ?? 1)
          : 1;
        const softQuarantine = pyramidWeight < 0.40;

        const pyramidAllowed =
          (pyramidEntityRows.length === 0 || !Boolean((pyramidEntityRows[0] as Record<string,unknown>)["quarantine"])) &&
          !FORCED_BLOCKED_HOURS.has(pyramidHour) &&   // не в ночные часы
          atrPercent < 3.0 &&                          // не при высокой волатильности
          !softQuarantine;                             // не при слабой сущности

        let pyramidNote = "";
        if (account.balance > pyramidCommission * 2 && pyramidAllowed) {
          account.balance = Math.max(0, account.balance - pyramidCommission); // L3
          // Update blended entry price to accurately reflect pyramid cost
          const blendedEntry = (pos.entryPrice * pos.size + realisticPrice * pyramidUnits) / (pos.size + pyramidUnits);
          pos.entryPrice = blendedEntry;
          pos.size       += pyramidUnits;
          addAccountCosts(chatId, pyramidCommission, 0).catch(() => {});
          pyramidNote = `\n📈 *Пирамидинг*: +${pyramidUnits.toFixed(4)} ед. добавлено по TP1 (риска нет — стоп в BE)\n` +
                        `Средний вход скорректирован: \`${formatPrice(blendedEntry)}\` | TP2: \`${formatPrice(pos.tp2)}\``;
        } else {
          const reasons: string[] = [];
          if (FORCED_BLOCKED_HOURS.has(pyramidHour)) reasons.push("ночной час");
          if (atrPercent >= 3.0) reasons.push(`ATR ${atrPercent.toFixed(1)}%`);
          if (softQuarantine) reasons.push(`вес ${(pyramidWeight * 100).toFixed(0)}%`);
          if (!pyramidAllowed && reasons.length > 0) {
            pyramidNote = `\n⛔ Пирамидинг пропущен: ${reasons.join(", ")}`;
          }
        }

        const tp1Msg =
          `🎯 *ЧАСТИЧНОЕ ЗАКРЫТИЕ — ${pos.symbol}*\n` +
          `${dirLabel} | TP1 зафиксировано 50% | ${stratLabel}\n` +
          `Вход: \`${formatPrice(pos.entryPrice)}\` → TP1: \`${formatPrice(realisticPrice)}\`\n` +
          `P&L (50%): *+${pnl.toFixed(2)}* (+${pnlPct.toFixed(2)}%)\n` +
          `💸 комиссия -${commission.toFixed(2)} | слипп -${slippage.toFixed(2)}\n` +
          `📌 Стоп → безубыток` +
          pyramidNote + `\n` +
          `💰 Баланс: *${account.balance.toFixed(2)}*`;
        msgs.push(tp1Msg);
        if (sendNotification) await sendNotification(tp1Msg).catch(() => {});

        remaining.push(pos);
        continue;
      }

      // ── Full Close: SL / BE / TP2 ──────────────────────────────────────────
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
        // FIX Critical#5: atomic delete+insert prevents orphaned closes (position deleted but no trade recorded)
        const claimed = await closePositionAndInsertTrade(chatId, pos.id, trade);
        if (!claimed) {
          logger.debug({ posId: pos.id, symbol: pos.symbol }, "Position already claimed by concurrent close cycle — skipping");
          // Position is gone from DB — don't add to remaining
          continue;
        }

        account.balance += pnl;
        account.closedTrades.unshift(trade);
        addAccountCosts(chatId, commission, slippage).catch(() => {});
        // Final close: 1 stat entry per signal (TP1 partial excluded by design)
        recordStrategyTrade(pos.strategy ?? "UNKNOWN", pnlEquityPct, pnl > 0).catch(() => {});
        // FIX Critical#7: record this final close in the active A/B variant (was defined but never called)
        recordABTrade(abVariantId, pnlEquityPct, pnl > 0).catch(() => {});
        const regime = pos.marketRegime ?? "sideways";
        recordRegimeTrade((pos.strategy ?? "UNKNOWN") as StrategyName, regime as MarketRegime, pnlEquityPct, pnl > 0, pos.interval ?? "ALL").catch(() => {});
        recordDirectionTrade((pos.strategy ?? "UNKNOWN") as StrategyName, pos.direction, pnlEquityPct, pnl > 0).catch(() => {});
        recordTimeTrade(pos.openedAt, pnlEquityPct, pnl > 0).catch(() => {});
        recordInstrumentTrade(pos.symbol, (pos.strategy ?? "UNKNOWN") as StrategyName, pnlEquityPct, pnl > 0).catch(() => {});
        recordInstrumentRegimeTrade(pos.symbol, pos.direction, regime as MarketRegime, pnlEquityPct, pnl > 0).catch(() => {});
        recordEntitySymbolResult(`${pos.strategy ?? "UNKNOWN"}_${pos.direction}`, pos.symbol, pnl > 0).catch(() => {});
        updateJournalClose(chatId, pos.symbol, pos.direction, realisticPrice, closeReason, pnlPct, pos.id).catch(() => {});
        if (pnl <= 0 && (closeReason === "SL" || closeReason === "BE")) {
          const lossReason = classifyLossReason((pos.strategy ?? "UNKNOWN") as StrategyName, regime as MarketRegime, closeReason);
          recordLossReason((pos.strategy ?? "UNKNOWN") as StrategyName, lossReason).catch(() => {});
        }
        updateTradeResult(pos.id, pnlEquityPct, pnl > 0, closeReason).catch(() => {});

        const isProfit    = pnl > 0;
        // True BE only when close price ≈ entry (within 0.01%).
        // After trailing stop, stopLoss can sit above/below entry → real P&L, not zero.
        const epsilon     = pos.entryPrice * 0.0001;
        const isBreakeven = closeReason === "BE" && Math.abs(closePrice - pos.entryPrice) <= epsilon;
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
        if (sendNotification) await sendNotification(closeMsg).catch(() => {});

        const riskAlert = await recordPositionClosed((pnl/(account.balance-pnl+0.001))*100, pnl>0);
        if (riskAlert) {
          msgs.push(riskAlert);
          if (sendNotification) await sendNotification(riskAlert).catch(() => {});
        }

        if (sendNotification) {
          await checkNewPeak(chatId, account.balance, account.peakBalance ?? account.balance, sendNotification);
          await checkMilestone(chatId, account.balance, account.initialBalance, sendNotification);
        }
        if (account.balance > (account.peakBalance ?? 0)) account.peakBalance = account.balance;

        // Position already deleted from DB via tryClaimPosition — do NOT add to remaining
      } else {
        remaining.push(pos);
      }
    } catch(err) {
      logger.warn({err,symbol:pos.symbol},"checkPaperPositions: getPrice failed");
      remaining.push(pos);
    }
  }

  // Update only the positions that are still open (remaining).
  // Closed positions were already deleted atomically via tryClaimPosition.
  for (const p of remaining) {
    await updatePosition(chatId, p);
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
  const expectancy = trades.length
    ? (wins.length / trades.length) * avgW - (losses.length / trades.length) * avgL
    : 0;
  const ret     = ((account.balance-account.initialBalance)/account.initialBalance)*100;
  const totalComm = account.totalCommission ?? 0;
  const totalSlip = account.totalSlippage ?? 0;

  const posLines = account.positions.length===0
    ? ["  нет открытых позиций"]
    : account.positions.map(p=>{
        const dir = p.direction==="LONG"?"⬆️":"⬇️";
        const be  = p.breakevenMoved?" [BE✓]":"";
        return `  ${dir} ${p.symbol} @ ${formatPrice(p.entryPrice)}${be} | SL: ${formatPrice(p.stopLoss)}`;
      });

  return [
    `💼 *Виртуальный счёт*`, "",
    `Баланс: *$${account.balance.toFixed(2)}*`,
    `${ret>=0?"📈":"📉"} P&L: ${ret>=0?"+":""}${ret.toFixed(2)}%`, "",
    `📊 Сделок: ${trades.length} | WR: ${trades.length?(wins.length/trades.length*100).toFixed(1):0}%`,
    `Win avg: +${avgW.toFixed(2)}% | Loss avg: -${avgL.toFixed(2)}%`,
    `Profit Factor: ${pf===999?"∞":pf.toFixed(2)}`,
    `Expectancy: ${expectancy>=0?"+":""}${expectancy.toFixed(2)}%`, "",
    `💸 Комиссии: -$${totalComm.toFixed(2)} | Проскальзывание: -$${totalSlip.toFixed(2)}`,
    `Потери на издержках: -$${(totalComm + totalSlip).toFixed(2)} (${account.initialBalance > 0 ? ((totalComm + totalSlip) / account.initialBalance * 100).toFixed(2) : "0"}% депозита)`, "",
    `📂 Открытых позиций (${account.positions.length}/10):`,
    ...posLines,
  ].join("\n");
}
