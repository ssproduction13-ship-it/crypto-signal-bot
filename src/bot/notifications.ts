import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

type NotificationType =
  | "TRADE_OPENED"
  | "TRADE_CLOSED"
  | "STRATEGY_CHANGED"
  | "NEW_CHAMPION"
  | "BALANCE_MILESTONE"
  | "NEW_PEAK"
  | "HIGH_DRAWDOWN"
  | "RISK_STOP";

interface NotificationState {
  lastPeakNotified: number;
  lastDrawdownNotified: number;
  lastMilestoneNotified: number;
}

const state: Map<number, NotificationState> = new Map();

function getState(chatId: number): NotificationState {
  if (!state.has(chatId)) {
    state.set(chatId, { lastPeakNotified: 0, lastDrawdownNotified: 0, lastMilestoneNotified: 0 });
  }
  return state.get(chatId)!;
}

async function logNotification(chatId: number, type: NotificationType, message: string): Promise<void> {
  await pool.query(
    "INSERT INTO notifications_log(chat_id, type, message, sent_at) VALUES($1,$2,$3,$4)",
    [chatId, type, message, new Date().toISOString()]
  ).catch(err => logger.debug({ err }, "notification log failed"));
}

// Check if balance hit a new peak → notify
export async function checkNewPeak(
  chatId: number,
  balance: number,
  peakBalance: number,
  send: (msg: string) => Promise<void>
): Promise<void> {
  if (balance <= peakBalance) return;
  const s = getState(chatId);
  if (balance <= s.lastPeakNotified * 1.01) return; // avoid spam: only notify on >1% new high

  s.lastPeakNotified = balance;
  const msg = `🏆 *Новый максимум капитала!*\n\nБаланс: *$${balance.toFixed(2)}*\nПредыдущий пик: $${peakBalance.toFixed(2)}`;
  await send(msg);
  await logNotification(chatId, "NEW_PEAK", msg);
}

// Check drawdown vs peak → notify if > threshold
export async function checkDrawdown(
  chatId: number,
  balance: number,
  peakBalance: number,
  send: (msg: string) => Promise<void>
): Promise<void> {
  if (peakBalance <= 0) return;
  const dd = ((peakBalance - balance) / peakBalance) * 100;
  if (dd < 5) { getState(chatId).lastDrawdownNotified = 0; return; }

  const s = getState(chatId);
  const threshold = dd >= 15 ? 15 : dd >= 10 ? 10 : 5;
  if (s.lastDrawdownNotified >= threshold) return;

  s.lastDrawdownNotified = threshold;
  const icon = dd >= 15 ? "🚨" : dd >= 10 ? "⚠️" : "📉";
  const msg = `${icon} *Просадка ${dd.toFixed(1)}%!*\n\nБаланс: $${balance.toFixed(2)}\nПик: $${peakBalance.toFixed(2)}\n\n${dd >= 15 ? "❗ Рекомендую приостановить торговлю" : "Контролируй риски"}`;
  await send(msg);
  await logNotification(chatId, "HIGH_DRAWDOWN", msg);
}

// Check balance milestones (every 10% growth from initial)
export async function checkMilestone(
  chatId: number,
  balance: number,
  initialBalance: number,
  send: (msg: string) => Promise<void>
): Promise<void> {
  if (balance <= initialBalance) return;
  const growthPct = ((balance - initialBalance) / initialBalance) * 100;
  const milestone = Math.floor(growthPct / 10) * 10;
  if (milestone <= 0) return;

  const s = getState(chatId);
  if (s.lastMilestoneNotified >= milestone) return;

  s.lastMilestoneNotified = milestone;
  const msg = `🎉 *Депозит вырос на ${milestone}%!*\n\nБаланс: *$${balance.toFixed(2)}*\nНачало: $${initialBalance.toFixed(2)}\nРост: +$${(balance - initialBalance).toFixed(2)}`;
  await send(msg);
  await logNotification(chatId, "BALANCE_MILESTONE", msg);
}

export function buildTradeOpenedMsg(
  symbol: string, direction: "LONG" | "SHORT", score: number, confidence: number,
  strategy: string, entryPrice: number, stopLoss: number, tp1: number, tp2: number
): string {
  const dir = direction === "LONG" ? "⬆️ LONG" : "⬇️ SHORT";
  const stratNames: Record<string, string> = {
    TREND: "📈 Тренд", BREAKOUT: "🚀 Пробой",
    VOLUME_IMPULSE: "⚡ Объёмный импульс", MEAN_REVERSION: "↩️ Возврат к среднему",
  };
  return (
    `🤖 *Новая позиция открыта*\n\n` +
    `${dir} *${symbol}*\n` +
    `Стратегия: ${stratNames[strategy] ?? strategy}\n` +
    `Score: ${score}/100 | Confidence: ${confidence}%\n` +
    `Вход: \`${entryPrice.toPrecision(6)}\`\n` +
    `Стоп: \`${stopLoss.toPrecision(6)}\`\n` +
    `TP1: \`${tp1.toPrecision(6)}\` | TP2: \`${tp2.toPrecision(6)}\``
  );
}
