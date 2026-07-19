/**
 * Automatic Cooldown — автоматическое снижение активности при плохой статистике.
 * Если за 30 сделок PF резко падает или просадка превышает лимит —
 * уменьшает размер позиции, повышает минимальный Confidence, снижает число сделок.
 * После восстановления статистики ограничения снимаются автоматически.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export type CooldownLevel = "none" | "mild" | "moderate" | "severe";

export interface CooldownState {
  level: CooldownLevel;
  sizeMultiplier: number;
  minConfidenceBoost: number;
  skipProbability: number;
  reason: string;
  activeSince: string | null;
  lastChecked: string;
  recentPF: number;
  recentDrawdown: number;
}

const COOLDOWN_THRESHOLDS = {
  pfCritical: 0.7,
  pfWarning: 0.9,
  ddCritical: 25,
  ddWarning: 15,
};

export async function evaluateCooldown(chatId?: number): Promise<CooldownState> {
  const query = chatId != null
    ? `SELECT pnl_percent FROM paper_closed_trades WHERE chat_id = $1 AND outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 30`
    : `SELECT pnl_percent FROM paper_closed_trades WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 30`;
  const params = chatId != null ? [chatId] : [];

  const { rows } = await pool.query(query, params);
  const pnls = (rows as Record<string, unknown>[]).map(r => Number(r["pnl_percent"]));

  if (pnls.length < 15) {
    return {
      level: "none", sizeMultiplier: 1.0, minConfidenceBoost: 0,
      skipProbability: 0, reason: "Недостаточно данных",
      activeSince: null, lastChecked: new Date().toISOString(),
      recentPF: 0, recentDrawdown: 0,
    };
  }

  const wins = pnls.filter(v => v > 0);
  const losses = pnls.filter(v => v <= 0);
  const gW = wins.reduce((s, v) => s + v, 0);
  const gL = Math.abs(losses.reduce((s, v) => s + v, 0));
  const recentPF = gL > 0 ? gW / gL : gW > 0 ? 99 : 0;

  // Calculate drawdown via equity curve (compound), so DD is always 0–100%
  // pnl_percent = e.g. +2.5 means +2.5% on that trade
  let eqPeak = 1.0, eqCur = 1.0, recentDrawdown = 0;
  for (const r of [...pnls].reverse()) {
    eqCur *= (1 + r / 100);
    if (eqCur > eqPeak) eqPeak = eqCur;
    const dd = eqPeak > 0 ? (eqPeak - eqCur) / eqPeak * 100 : 0;
    if (dd > recentDrawdown) recentDrawdown = dd;
  }

  let level: CooldownLevel = "none";
  const reasons: string[] = [];

  if (recentPF < COOLDOWN_THRESHOLDS.pfCritical || recentDrawdown > COOLDOWN_THRESHOLDS.ddCritical) {
    level = "severe";
    if (recentPF < COOLDOWN_THRESHOLDS.pfCritical) reasons.push(`PF ${recentPF.toFixed(2)} < ${COOLDOWN_THRESHOLDS.pfCritical}`);
    if (recentDrawdown > COOLDOWN_THRESHOLDS.ddCritical) reasons.push(`Просадка ${recentDrawdown.toFixed(1)}% > ${COOLDOWN_THRESHOLDS.ddCritical}%`);
  } else if (recentPF < COOLDOWN_THRESHOLDS.pfWarning || recentDrawdown > COOLDOWN_THRESHOLDS.ddWarning) {
    level = "moderate";
    if (recentPF < COOLDOWN_THRESHOLDS.pfWarning) reasons.push(`PF ${recentPF.toFixed(2)} < ${COOLDOWN_THRESHOLDS.pfWarning}`);
    if (recentDrawdown > COOLDOWN_THRESHOLDS.ddWarning) reasons.push(`Просадка ${recentDrawdown.toFixed(1)}% > ${COOLDOWN_THRESHOLDS.ddWarning}%`);
  } else if (recentPF < 1.1) {
    level = "mild";
    reasons.push(`PF слабый: ${recentPF.toFixed(2)}`);
  }

  // fix: params2 была объявлена но никогда не использовалась — удалена. pool.query
  // получает параметры напрямую через inline-выражение (поведение не изменилось).
  const query2 = chatId != null
    ? `SELECT active_since FROM cooldown_state WHERE chat_id = $1 ORDER BY checked_at DESC LIMIT 1`
    : `SELECT active_since FROM cooldown_state ORDER BY checked_at DESC LIMIT 1`;

  const { rows: prevRows } = await pool.query(query2, chatId != null ? [chatId] : []).catch(() => ({ rows: [] }));
  const prevState = prevRows[0] as Record<string, unknown> | undefined;
  const activeSince = level !== "none"
    ? (prevState?.["active_since"] as string ?? new Date().toISOString())
    : null;

  const state: CooldownState = {
    level,
    sizeMultiplier: level === "severe" ? 0.3 : level === "moderate" ? 0.6 : level === "mild" ? 0.8 : 1.0,
    minConfidenceBoost: level === "severe" ? 15 : level === "moderate" ? 10 : level === "mild" ? 5 : 0,
    skipProbability: level === "severe" ? 0.5 : level === "moderate" ? 0.3 : level === "mild" ? 0.1 : 0,
    reason: reasons.join(" | ") || "Статистика в норме",
    activeSince,
    lastChecked: new Date().toISOString(),
    recentPF,
    recentDrawdown,
  };

  const chatIdParam = chatId ?? 0;
  await pool.query(
    `INSERT INTO cooldown_state(chat_id, level, size_multiplier, min_confidence_boost,
       skip_probability, reason, active_since, recent_pf, recent_drawdown, checked_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [chatIdParam, level, state.sizeMultiplier, state.minConfidenceBoost,
      state.skipProbability, state.reason, activeSince, recentPF, recentDrawdown, state.lastChecked]
  ).catch(err => logger.warn({ err }, "cooldown_state save failed"));

  return state;
}

export function formatCooldownStatus(state: CooldownState): string {
  const icon = state.level === "none" ? "✅" : state.level === "mild" ? "🟡" : state.level === "moderate" ? "⚠️" : "🚨";
  const levelLabel = { none: "Норма", mild: "Лёгкий", moderate: "Умеренный", severe: "Критический" }[state.level];

  let text = `${icon} *Auto Cooldown*\n\n`;
  text += `Режим: *${levelLabel}*\n`;
  text += `PF (30 сделок): ${state.recentPF.toFixed(2)} | Просадка: ${state.recentDrawdown.toFixed(1)}%\n`;

  if (state.level !== "none") {
    text += `\n*Ограничения активны:*\n`;
    text += `Размер позиции: ${(state.sizeMultiplier * 100).toFixed(0)}% от нормы\n`;
    text += `Мин. Confidence +${state.minConfidenceBoost}%\n`;
    text += `Пропуск сделок: ${(state.skipProbability * 100).toFixed(0)}% вероятность\n`;
    if (state.activeSince) {
      text += `Активно с: ${new Date(state.activeSince).toLocaleDateString("ru-RU")}\n`;
    }
    text += `\nПричина: ${state.reason}`;
  } else {
    text += `\nВсе ограничения сняты — торговля в полном режиме.`;
  }

  return text;
}

export async function getCooldownForChat(chatId: number): Promise<CooldownState> {
  return evaluateCooldown(chatId);
}
