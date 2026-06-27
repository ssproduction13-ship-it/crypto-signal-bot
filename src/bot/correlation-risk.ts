/**
 * Correlation Risk Engine — контролирует общий риск портфеля.
 * При высокой корреляции открытых позиций (BTC+ETH+SOL LONG)
 * уменьшает размер позиции или отказывает в новой сделке.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// Коэффициенты корреляции криптоактивов (примерные, на основе исторических данных)
const CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  BTCUSDT: { ETHUSDT: 0.90, SOLUSDT: 0.82, BNBUSDT: 0.78, XRPUSDT: 0.72, ADAUSDT: 0.70, AVAXUSDT: 0.79, LINKUSDT: 0.68, NEARUSDT: 0.75, APTUSDT: 0.73, SUIUSDT: 0.70, OPUSDT: 0.76, ARBUSDT: 0.77, ATOMUSDT: 0.71, DOTUSDT: 0.74, LTCUSDT: 0.69, TRXUSDT: 0.60, DOGEUSDT: 0.65, PEPEUSDT: 0.55, WIFUSDT: 0.52, SHIBUSDT: 0.58 },
  ETHUSDT: { BTCUSDT: 0.90, SOLUSDT: 0.85, BNBUSDT: 0.80, XRPUSDT: 0.73, ADAUSDT: 0.74, AVAXUSDT: 0.82, LINKUSDT: 0.75, NEARUSDT: 0.78, APTUSDT: 0.77, SUIUSDT: 0.74, OPUSDT: 0.85, ARBUSDT: 0.83, ATOMUSDT: 0.76, DOTUSDT: 0.78, LTCUSDT: 0.70, TRXUSDT: 0.62, DOGEUSDT: 0.67, PEPEUSDT: 0.57, WIFUSDT: 0.54, SHIBUSDT: 0.60 },
  SOLUSDT: { BTCUSDT: 0.82, ETHUSDT: 0.85, BNBUSDT: 0.76, XRPUSDT: 0.70, ADAUSDT: 0.71, AVAXUSDT: 0.79, LINKUSDT: 0.72, NEARUSDT: 0.80, APTUSDT: 0.78, SUIUSDT: 0.77, OPUSDT: 0.80, ARBUSDT: 0.78, ATOMUSDT: 0.73, DOTUSDT: 0.76, LTCUSDT: 0.65, TRXUSDT: 0.58, DOGEUSDT: 0.62, PEPEUSDT: 0.52, WIFUSDT: 0.55, SHIBUSDT: 0.55 },
};

const DEFAULT_CORRELATION = 0.65;

export interface PositionRiskInfo {
  symbol: string;
  direction: "LONG" | "SHORT";
  riskPercent: number;
}

export interface CorrelationRiskResult {
  allowed: boolean;
  sizeMultiplier: number;
  reason: string;
  portfolioRisk: number;
  correlatedRisk: number;
  maxAllowedRisk: number;
  message: string;
}

function getCorrelation(a: string, b: string): number {
  return CORRELATION_MATRIX[a]?.[b] ?? CORRELATION_MATRIX[b]?.[a] ?? DEFAULT_CORRELATION;
}

export async function checkCorrelationRisk(
  chatId: number,
  newSymbol: string,
  newDirection: "LONG" | "SHORT",
  riskPercent: number,
  maxPortfolioRisk = 5.0
): Promise<CorrelationRiskResult> {
  const { rows } = await pool.query(
    `SELECT symbol, direction FROM paper_positions WHERE chat_id = $1`,
    [chatId]
  );

  const openPositions: PositionRiskInfo[] = (rows as Record<string, unknown>[]).map(r => ({
    symbol: r["symbol"] as string,
    direction: r["direction"] as "LONG" | "SHORT",
    riskPercent, // use actual risk setting, not hardcoded 1.0
  }));

  if (!openPositions.length) {
    return {
      allowed: true, sizeMultiplier: 1.0,
      reason: "Нет открытых позиций",
      portfolioRisk: riskPercent, correlatedRisk: 0,
      maxAllowedRisk: maxPortfolioRisk,
      message: "✅ Открытие разрешено — портфель пуст",
    };
  }

  // Считаем скорректированный риск с учётом корреляций
  let correlatedRisk = 0;
  const sameDirPositions = openPositions.filter(p => p.direction === newDirection);

  for (const pos of sameDirPositions) {
    const corr = getCorrelation(newSymbol, pos.symbol);
    correlatedRisk += corr * pos.riskPercent;
  }

  // portfolioRisk = только скоррелированный риск в том же направлении.
  // Суммарный лимит позиций контролирует canOpenTrade() в risk-manager.ts.
  // Противоположные направления хеджируют друг друга — не считаем их как риск.
  const portfolioRisk = correlatedRisk;

  if (portfolioRisk > maxPortfolioRisk * 1.5) {
    return {
      allowed: false, sizeMultiplier: 0,
      reason: `Общий риск портфеля ${portfolioRisk.toFixed(1)}% превышает максимум ${maxPortfolioRisk}%`,
      portfolioRisk, correlatedRisk, maxAllowedRisk: maxPortfolioRisk,
      message: `🚫 *Сделка заблокирована*\nОбщий риск ${portfolioRisk.toFixed(1)}% > макс ${maxPortfolioRisk}%\nКорреляционный риск: ${correlatedRisk.toFixed(2)}%`,
    };
  }

  if (portfolioRisk > maxPortfolioRisk) {
    const allowedRisk = maxPortfolioRisk - (portfolioRisk - riskPercent);
    const sizeMultiplier = Math.max(0.25, allowedRisk / riskPercent);
    return {
      allowed: true, sizeMultiplier,
      reason: `Высокая корреляция — размер снижен до ${(sizeMultiplier * 100).toFixed(0)}%`,
      portfolioRisk, correlatedRisk, maxAllowedRisk: maxPortfolioRisk,
      message: `⚠️ Размер позиции снижен до ${(sizeMultiplier * 100).toFixed(0)}%\nКорреляция с портфелем высокая`,
    };
  }

  if (correlatedRisk > riskPercent * 0.7) {
    const sizeMultiplier = 0.75;
    return {
      allowed: true, sizeMultiplier,
      reason: `Умеренная корреляция — размер снижен до 75%`,
      portfolioRisk, correlatedRisk, maxAllowedRisk: maxPortfolioRisk,
      message: `⚠️ Размер снижен до 75% — открытые позиции коррелируют`,
    };
  }

  return {
    allowed: true, sizeMultiplier: 1.0,
    reason: "Корреляционный риск в норме",
    portfolioRisk, correlatedRisk, maxAllowedRisk: maxPortfolioRisk,
    message: `✅ Открытие разрешено\nРиск портфеля: ${portfolioRisk.toFixed(1)}%`,
  };
}

export async function getPortfolioCorrelationReport(chatId: number): Promise<string> {
  const { rows } = await pool.query(
    `SELECT symbol, direction FROM paper_positions WHERE chat_id = $1`,
    [chatId]
  );

  if (!rows.length) return "📊 *Корреляционный риск*\n\nОткрытых позиций нет.";

  const positions = rows as Record<string, unknown>[];
  let text = "📊 *Корреляционный риск портфеля*\n\n";

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i]!;
      const b = positions[j]!;
      const symA = a["symbol"] as string;
      const symB = b["symbol"] as string;
      const corrDir = a["direction"] === b["direction"] ? "⚠️" : "✅";
      const corr = getCorrelation(symA, symB);
      text += `${corrDir} ${symA} ↔ ${symB}: ${(corr * 100).toFixed(0)}%`;
      if (a["direction"] === b["direction"]) text += ` (оба ${a["direction"]})`;
      text += "\n";
    }
  }

  return text.trim();
}
