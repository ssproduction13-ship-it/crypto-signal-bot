/**
 * Correlation Risk Engine — контролирует общий риск портфеля.
 * При высокой корреляции открытых позиций (BTC+ETH+SOL LONG)
 * уменьшает размер позиции или отказывает в новой сделке.
 *
 * v2: Исправлена формула — используется средняя корреляция (не сумма),
 * portfolioRisk = (N+1) × riskPercent × avgCorr.
 * maxPortfolioRisk = 8% (соответствует 10 позициям по 1% при avgCorr≈0.8).
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// Коэффициенты корреляции криптоактивов (примерные, на основе исторических данных)
const CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  BTCUSDT: { ETHUSDT: 0.90, SOLUSDT: 0.82, BNBUSDT: 0.78, XRPUSDT: 0.72, ADAUSDT: 0.70, AVAXUSDT: 0.79, LINKUSDT: 0.68, NEARUSDT: 0.75, APTUSDT: 0.73, SUIUSDT: 0.70, OPUSDT: 0.76, ARBUSDT: 0.77, ATOMUSDT: 0.71, DOTUSDT: 0.74, LTCUSDT: 0.69, TRXUSDT: 0.60, DOGEUSDT: 0.65, PEPEUSDT: 0.55, WIFUSDT: 0.52, SHIBUSDT: 0.58 },
  ETHUSDT: { BTCUSDT: 0.90, SOLUSDT: 0.85, BNBUSDT: 0.80, XRPUSDT: 0.73, ADAUSDT: 0.74, AVAXUSDT: 0.82, LINKUSDT: 0.75, NEARUSDT: 0.78, APTUSDT: 0.77, SUIUSDT: 0.74, OPUSDT: 0.85, ARBUSDT: 0.83, ATOMUSDT: 0.76, DOTUSDT: 0.78, LTCUSDT: 0.70, TRXUSDT: 0.62, DOGEUSDT: 0.67, PEPEUSDT: 0.57, WIFUSDT: 0.54, SHIBUSDT: 0.60 },
  SOLUSDT: { BTCUSDT: 0.82, ETHUSDT: 0.85, BNBUSDT: 0.76, XRPUSDT: 0.70, ADAUSDT: 0.71, AVAXUSDT: 0.79, LINKUSDT: 0.72, NEARUSDT: 0.80, APTUSDT: 0.78, SUIUSDT: 0.77, OPUSDT: 0.80, ARBUSDT: 0.78, ATOMUSDT: 0.73, DOTUSDT: 0.76, LTCUSDT: 0.65, TRXUSDT: 0.58, DOGEUSDT: 0.62, PEPEUSDT: 0.52, WIFUSDT: 0.55, SHIBUSDT: 0.55 },
  // ── Tier 2 & 3 ─────────────────────────────────────────────────────────
  INJUSDT:    { BTCUSDT: 0.78, ETHUSDT: 0.80, SOLUSDT: 0.82 },
    TONUSDT:    { BTCUSDT: 0.70, ETHUSDT: 0.72, SOLUSDT: 0.68 },
    RENDERUSDT: { BTCUSDT: 0.75, ETHUSDT: 0.78, SOLUSDT: 0.76 },
    RUNEUSDT:   { BTCUSDT: 0.73, ETHUSDT: 0.75, SOLUSDT: 0.72 },
    HBARUSDT:   { BTCUSDT: 0.68, ETHUSDT: 0.70, SOLUSDT: 0.67 },
    STXUSDT:    { BTCUSDT: 0.76, ETHUSDT: 0.74, SOLUSDT: 0.73 },
    FETUSDT:    { BTCUSDT: 0.77, ETHUSDT: 0.79, SOLUSDT: 0.76 },
    TIAUSDT:    { BTCUSDT: 0.74, ETHUSDT: 0.76, SOLUSDT: 0.78 },
    SEIUSDT:    { BTCUSDT: 0.75, ETHUSDT: 0.77, SOLUSDT: 0.80 },
    JUPUSDT:    { BTCUSDT: 0.72, ETHUSDT: 0.73, SOLUSDT: 0.85 },
    AAVEUSDT:   { BTCUSDT: 0.74, ETHUSDT: 0.82, SOLUSDT: 0.73 },
    UNIUSDT:    { BTCUSDT: 0.73, ETHUSDT: 0.83, SOLUSDT: 0.72 },
    BONKUSDT:   { BTCUSDT: 0.62, ETHUSDT: 0.60, SOLUSDT: 0.75 },
    FLOKIUSDT:  { BTCUSDT: 0.60, ETHUSDT: 0.58, SOLUSDT: 0.62 },
    LDOUSDT:    { BTCUSDT: 0.75, ETHUSDT: 0.84, SOLUSDT: 0.74 },
    ICPUSDT:    { BTCUSDT: 0.71, ETHUSDT: 0.73, SOLUSDT: 0.75 },
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
  maxPortfolioRisk = 8.0,  // v2: raised from 5% → 8% (10 позиций × 1% × avgCorr 0.8)
): Promise<CorrelationRiskResult> {
  // FIX Critical#8: query each position's actual risk_percent from DB
  // Using the new trade's riskPercent for all existing positions was wrong — each has its own risk
  const { rows } = await pool.query(
    `SELECT symbol, direction, COALESCE(risk_percent, $2) AS risk_percent FROM paper_positions WHERE chat_id = $1`,
    [chatId, riskPercent]
  );

  const openPositions: PositionRiskInfo[] = (rows as Record<string, unknown>[]).map(r => ({
    symbol: r["symbol"] as string,
    direction: r["direction"] as "LONG" | "SHORT",
    riskPercent: r["risk_percent"] != null ? Number(r["risk_percent"]) : riskPercent,
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

  const sameDirPositions = openPositions.filter(p => p.direction === newDirection);

  // v2: используем СРЕДНЮЮ корреляцию, а не сумму.
  // Это исключает линейный рост блокировок с числом позиций.
  let totalCorr = 0;
  for (const pos of sameDirPositions) {
    totalCorr += getCorrelation(newSymbol, pos.symbol);
  }
  const avgCorr = sameDirPositions.length > 0 ? totalCorr / sameDirPositions.length : 0;
  const correlatedRisk = avgCorr * riskPercent;

  // portfolioRisk = суммарный направленный риск после открытия новой позиции,
  // взвешенный на среднюю корреляцию внутри портфеля.
  // Формула: (N+1) × riskPercent × avgCorr
  const portfolioRisk = sameDirPositions.length > 0
    ? (sameDirPositions.length + 1) * riskPercent * avgCorr
    : riskPercent;

  logger.debug({
    symbol: newSymbol, direction: newDirection,
    sameDirCount: sameDirPositions.length, avgCorr: avgCorr.toFixed(2),
    correlatedRisk: correlatedRisk.toFixed(2), portfolioRisk: portfolioRisk.toFixed(2),
    maxPortfolioRisk,
  }, "Correlation Guard check");

  // Жёсткая блокировка: portfolioRisk > maxPortfolioRisk (без лишнего множителя)
  if (portfolioRisk > maxPortfolioRisk) {
    return {
      allowed: false, sizeMultiplier: 0,
      reason: `Общий риск портфеля ${portfolioRisk.toFixed(1)}% превышает максимум ${maxPortfolioRisk}%`,
      portfolioRisk, correlatedRisk, maxAllowedRisk: maxPortfolioRisk,
      message: `🚫 *Сделка заблокирована*\nОбщий риск ${portfolioRisk.toFixed(1)}% > макс ${maxPortfolioRisk}%\nПозиций в том же направлении: ${sameDirPositions.length} | avgCorr: ${(avgCorr * 100).toFixed(0)}%`,
    };
  }

  // Умеренное снижение размера: portfolioRisk > 70% от максимума
  if (portfolioRisk > maxPortfolioRisk * 0.70) {
    const allowedRisk = maxPortfolioRisk - (portfolioRisk - riskPercent);
    const sizeMultiplier = Math.max(0.25, allowedRisk / riskPercent);
    return {
      allowed: true, sizeMultiplier,
      reason: `Высокая корреляция — размер снижен до ${(sizeMultiplier * 100).toFixed(0)}%`,
      portfolioRisk, correlatedRisk, maxAllowedRisk: maxPortfolioRisk,
      message: `⚠️ Размер позиции снижен до ${(sizeMultiplier * 100).toFixed(0)}%\nКорреляционный риск портфеля: ${portfolioRisk.toFixed(1)}%`,
    };
  }

  // Лёгкое снижение: средняя корреляция высокая (> 70%)
  if (avgCorr > 0.70 && sameDirPositions.length >= 3) {
    return {
      allowed: true, sizeMultiplier: 0.75,
      reason: `Умеренная корреляция (${(avgCorr * 100).toFixed(0)}%) — размер снижен до 75%`,
      portfolioRisk, correlatedRisk, maxAllowedRisk: maxPortfolioRisk,
      message: `⚠️ Размер снижен до 75% — открытые позиции коррелируют (avgCorr ${(avgCorr * 100).toFixed(0)}%)`,
    };
  }

  return {
    allowed: true, sizeMultiplier: 1.0,
    reason: "Корреляционный риск в норме",
    portfolioRisk, correlatedRisk, maxAllowedRisk: maxPortfolioRisk,
    message: `✅ Открытие разрешено\nРиск портфеля: ${portfolioRisk.toFixed(1)}% / ${maxPortfolioRisk}%`,
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
