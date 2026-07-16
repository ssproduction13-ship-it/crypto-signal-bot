import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { formatPrice } from "./risk.js";

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

// fix: was in-memory Map — lost on every Railway redeploy → duplicate notifications
// Now backed by notification_state table; in-memory Map used as write-through cache for speed.
const memCache: Map<number, NotificationState> = new Map();

async function loadState(chatId: number): Promise<NotificationState> {
  if (memCache.has(chatId)) return memCache.get(chatId)!;
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM notification_state WHERE chat_id=$1`,
      [chatId]
    );
    const s: NotificationState = { lastPeakNotified: 0, lastDrawdownNotified: 0, lastMilestoneNotified: 0 };
    for (const r of rows as Record<string, unknown>[]) {
      const k = r['key'] as keyof NotificationState;
      if (k in s) (s as Record<string, number>)[k] = Number(r['value']);
    }
    memCache.set(chatId, s);
    return s;
  } catch {
    const s: NotificationState = { lastPeakNotified: 0, lastDrawdownNotified: 0, lastMilestoneNotified: 0 };
    memCache.set(chatId, s);
    return s;
  }
}

async function saveStateKey(chatId: number, key: keyof NotificationState, value: number): Promise<void> {
  const s = memCache.get(chatId);
  if (s) (s as Record<string, number>)[key] = value;
  await pool.query(
    `INSERT INTO notification_state(chat_id, key, value) VALUES($1,$2,$3)
     ON CONFLICT(chat_id, key) DO UPDATE SET value=EXCLUDED.value`,
    [chatId, key, value]
  ).catch(err => logger.debug({ err }, 'notification_state save failed'));
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
  const s = await loadState(chatId);
  if (balance <= s.lastPeakNotified * 1.01) return; // avoid spam: only notify on >1% new high

  await saveStateKey(chatId, 'lastPeakNotified', balance);
  const msg = `🏆 *Новый максимум капитала!*\n\nБаланс: *${balance.toFixed(2)}*\nПредыдущий пик: ${peakBalance.toFixed(2)}`;
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
  if (dd < 5) { await saveStateKey(chatId, 'lastDrawdownNotified', 0); return; }

  const s = await loadState(chatId);
  const threshold = dd >= 15 ? 15 : dd >= 10 ? 10 : 5;
  if (s.lastDrawdownNotified >= threshold) return;

  await saveStateKey(chatId, 'lastDrawdownNotified', threshold);
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

  const s = await loadState(chatId);
  if (s.lastMilestoneNotified >= milestone) return;

  await saveStateKey(chatId, 'lastMilestoneNotified', milestone);
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
    `Вход: \`${formatPrice(entryPrice)}\`\n` +
    `Стоп: \`${formatPrice(stopLoss)}\`\n` +
    `TP1: \`${formatPrice(tp1)}\` | TP2: \`${formatPrice(tp2)}\``
  );
}
