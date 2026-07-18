import { pool } from "../lib/db.js";
import type { IndicatorResult } from "./indicators.js";
import type { SupportResistance } from "./levels.js";
import type { PatternResult } from "./patterns.js";
import type { Candle } from "./binance.js";
import { logger } from "../lib/logger.js";

export type StrategyName = "TREND" | "BREAKOUT" | "VOLUME_IMPULSE" | "MEAN_REVERSION" | "UNKNOWN";

export interface StrategySignal {
  strategy: StrategyName;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  score: number;
  reasons: string[];
  confidence: number;
}

export interface StrategyStats {
  strategy: StrategyName;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  totalPnl: number;
}

// ── Strategy: TREND ─────────────────────────────────────────────────────────
// Based on EMA crossover + ADX trend strength + price above/below EMA200
function evalTrend(ind: IndicatorResult, candles: Candle[]): StrategySignal {
  const reasons: string[] = [];
  let score = 50;
  let longVotes = 0, shortVotes = 0;

  if (ind.emaCrossSignal === "buy")  { score += 20; longVotes++;  reasons.push("EMA20 > EMA50 (бычий кросс)"); }
  if (ind.emaCrossSignal === "sell") { score -= 20; shortVotes++; reasons.push("EMA20 < EMA50 (медвежий кросс)"); }

  const price = candles[candles.length - 1]!.close;
  if (ind.ema200) {
    if (price > ind.ema200) { score += 15; longVotes++;  reasons.push("Выше EMA200 — глобальный бычий"); }
    else                    { score -= 15; shortVotes++; reasons.push("Ниже EMA200 — глобальный медвежий"); }
  }

  if (ind.trendStrength === "strong")   { score += 15; reasons.push(`ADX ${ind.adxValue?.toFixed(1)} — сильный тренд`); }
  else if (ind.trendStrength === "weak") { score -= 15; reasons.push("ADX низкий — боковик"); }

  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  const direction = longVotes > shortVotes ? "LONG" : shortVotes > longVotes ? "SHORT" : "NEUTRAL";
  return { strategy: "TREND", direction, score: clamp(score), reasons, confidence: clamp(score * 0.9) };
}

// ── Strategy: BREAKOUT ────────────────────────────────────────────────────
// Based on price breaking resistance/support levels with volume confirmation
function evalBreakout(ind: IndicatorResult, levels: SupportResistance, pattern: PatternResult, candles: Candle[]): StrategySignal {
  const reasons: string[] = [];
  let score = 40;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  const price = candles[candles.length - 1]!.close;
  const volumes = candles.map(c => c.volume);
  const volSlice = volumes.slice(-20);
  const avgVol = volSlice.length > 0 ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  const lastVol = volumes[volumes.length - 1]!;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 0;

  if (pattern.name === "BREAKOUT") {
    // Pattern already confirmed the breakout — add its score and direction
    score += 30;
    reasons.push(pattern.description);
    if (pattern.description.toLowerCase().includes("бычий") || pattern.description.toLowerCase().includes("сопротивления")) {
      direction = "LONG";
    } else {
      direction = "SHORT";
    }
    // fix: skip level checks when pattern already fired — same price event, prevents double-counting
    // (was: pattern +30 AND level +20 for the same breakout = score 90 before volume check)
  } else {
    // Only apply level-based breakout score when pattern module did NOT detect it
    if (levels.nearestResistance && price > levels.nearestResistance * 1.001) {
      score += 20; direction = "LONG";
      reasons.push(`Пробой сопротивления ${levels.nearestResistance.toFixed(4)}`);
    }
    if (levels.nearestSupport && price < levels.nearestSupport * 0.999) {
      score += 20; direction = "SHORT";
      reasons.push(`Пробой поддержки ${levels.nearestSupport.toFixed(4)}`);
    }
  }

  if (volRatio > 1.5) { score += 15; reasons.push(`Объём ${(volRatio * 100).toFixed(0)}% — подтверждение`); }
  else if (volRatio < 0.8) { score -= 15; reasons.push("Слабый объём — сомнительный пробой"); }

  if (pattern.name === "TRIANGLE" || pattern.name === "CONSOLIDATION") {
    score += 10; reasons.push("Паттерн сжатия — возможен пробой");
  }

  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  return { strategy: "BREAKOUT", direction, score: clamp(score), reasons, confidence: clamp(score * 0.85) };
}

// ── Strategy: VOLUME_IMPULSE ─────────────────────────────────────────────
// Based on anomalous volume spike + momentum (MACD, RSI)
function evalVolumeImpulse(ind: IndicatorResult, candles: Candle[]): StrategySignal {
  const reasons: string[] = [];
  let score = 30;
  let longVotes = 0, shortVotes = 0;

  const volumes = candles.map(c => c.volume);
  const volSlice2 = volumes.slice(-20);
  const avgVol = volSlice2.length > 0 ? volSlice2.reduce((a, b) => a + b, 0) / volSlice2.length : 0;
  const lastVol = volumes[volumes.length - 1]!;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 0;

  if (volRatio > 2.5)      { score += 40; reasons.push(`🔥 Аномальный объём: ${(volRatio * 100).toFixed(0)}%`); }
  else if (volRatio > 1.5) { score += 25; reasons.push(`Высокий объём: ${(volRatio * 100).toFixed(0)}%`); }
  else { return { strategy: "VOLUME_IMPULSE", direction: "NEUTRAL", score: 0, reasons: ["Объём в норме — нет импульса"], confidence: 0 }; }

  // FIX: MACD теперь только голосует за направление, но НЕ добавляет к score немедленно.
  // Бонус/штраф применяется ПОСЛЕ определения direction: +20 если совпадает, -10 если противоречит.
  // Старый код давал +20 к quality score даже когда MACD противоречил импульсу.
  const macdDir = ind.macdSignal === "buy" ? "buy" : ind.macdSignal === "sell" ? "sell" : null;
  if (macdDir === "buy")  longVotes++;
  if (macdDir === "sell") shortVotes++;

  const price = candles[candles.length - 1]!.close;
  const prevClose = candles[candles.length - 2]?.close ?? price;
  const priceChange = ((price - prevClose) / prevClose) * 100;

  if (priceChange > 0.5)  { longVotes++;  reasons.push(`Свеча +${priceChange.toFixed(2)}%`); }
  if (priceChange < -0.5) { shortVotes++; reasons.push(`Свеча ${priceChange.toFixed(2)}%`); }

  if (ind.rsi != null) {
    if (ind.rsi < 40) { longVotes++;  reasons.push(`RSI ${ind.rsi.toFixed(1)} — импульс на выкуп`); }
    if (ind.rsi > 60) { shortVotes++; reasons.push(`RSI ${ind.rsi.toFixed(1)} — импульс на продажу`); }
  }

  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  const direction = longVotes > shortVotes ? "LONG" : shortVotes > longVotes ? "SHORT" : "NEUTRAL";

  // MACD score: +20 если подтверждает финальное направление, -10 если противоречит
  if (macdDir === "buy"  && direction === "LONG")  { score += 20; reasons.push("MACD бычье — подтверждает LONG"); }
  else if (macdDir === "sell" && direction === "SHORT") { score += 20; reasons.push("MACD медвежье — подтверждает SHORT"); }
  else if (macdDir === "buy"  && direction === "SHORT") { score -= 10; reasons.push("⚠️ MACD бычье — противоречит SHORT"); }
  else if (macdDir === "sell" && direction === "LONG")  { score -= 10; reasons.push("⚠️ MACD медвежье — противоречит LONG"); }

  return { strategy: "VOLUME_IMPULSE", direction, score: clamp(score), reasons, confidence: clamp(score * 0.88) };
}

// ── Strategy: MEAN_REVERSION ─────────────────────────────────────────────
// Based on RSI extremes + Bollinger Bands + StochRSI
function evalMeanReversion(ind: IndicatorResult): StrategySignal {
  const reasons: string[] = [];
  let score = 30;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let longVotes = 0, shortVotes = 0;

  if (ind.rsi != null) {
    if (ind.rsi < 25)      { score += 35; direction = "LONG";  longVotes  += 2; reasons.push(`RSI ${ind.rsi.toFixed(1)} — экстремальная перепроданность`); }
    else if (ind.rsi < 35) { score += 20; direction = "LONG";  longVotes++;     reasons.push(`RSI ${ind.rsi.toFixed(1)} — перепродан`); }
    else if (ind.rsi > 75) { score += 35; direction = "SHORT"; shortVotes += 2; reasons.push(`RSI ${ind.rsi.toFixed(1)} — экстремальная перекупленность`); }
    else if (ind.rsi > 65) { score += 20; direction = "SHORT"; shortVotes++;    reasons.push(`RSI ${ind.rsi.toFixed(1)} — перекуплен`); }
    else {
      // FIX: раньше был ранний return со score=0, игнорировавший BB и StochRSI.
      // RSI нейтральный (35–65) — само по себе слабо, но BB + Stoch могут дать валидный разворот.
      // Без RSI-бонуса score не превысит 30+20+15=65, и только при ДВУХ подтверждениях пройдёт порог 45.
      reasons.push(`RSI ${ind.rsi.toFixed(1)} — нейтральный (BB/Stoch решают)`);
    }
  }

  if (ind.bbSignal === "buy")  { score += 20; longVotes++;  reasons.push("BB: цена у нижней полосы — отскок"); }
  if (ind.bbSignal === "sell") { score += 20; shortVotes++; reasons.push("BB: цена у верхней полосы — откат"); }

  if (ind.stochSignal === "buy")  { score += 15; longVotes++;  reasons.push(`StochRSI ${ind.stochRsi?.toFixed(1)} — перепродан`); }
  if (ind.stochSignal === "sell") { score += 15; shortVotes++; reasons.push(`StochRSI ${ind.stochRsi?.toFixed(1)} — перекуплен`); }

  const finalDir = longVotes > shortVotes ? "LONG" : shortVotes > longVotes ? "SHORT" : direction;
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  return { strategy: "MEAN_REVERSION", direction: finalDir, score: clamp(score), reasons, confidence: clamp(score * 0.82) };
}

// ── Main: evaluate all strategies ─────────────────────────────────────────
export function evalAllStrategies(
  ind: IndicatorResult,
  levels: SupportResistance,
  pattern: PatternResult,
  candles: Candle[]
): StrategySignal[] {
  return [
    evalTrend(ind, candles),
    evalBreakout(ind, levels, pattern, candles),
    evalVolumeImpulse(ind, candles),
    evalMeanReversion(ind),
  ].filter(s => s.direction !== "NEUTRAL" && s.score > 0);
}

export function getBestStrategy(signals: StrategySignal[]): StrategySignal | null {
  if (!signals.length) return null;
  return signals.reduce((best, s) => s.score > best.score ? s : best);
}

// ── Strategy stats (DB) ────────────────────────────────────────────────────
export async function recordStrategyTrade(
  strategy: StrategyName, pnlPercent: number, isWin: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO strategy_stats(strategy, trades, wins, total_pnl, win_pnl, loss_pnl)
     VALUES($1, 1, $2, $3, $4, $5)
     ON CONFLICT(strategy) DO UPDATE SET
       trades   = strategy_stats.trades + 1,
       wins     = strategy_stats.wins + $2,
       total_pnl = strategy_stats.total_pnl + $3,
       win_pnl  = strategy_stats.win_pnl + $4,
       loss_pnl = strategy_stats.loss_pnl + $5`,
    [strategy, isWin ? 1 : 0, pnlPercent,
     isWin ? pnlPercent : 0, isWin ? 0 : Math.abs(pnlPercent)]
  );
}

export async function loadStrategyStats(): Promise<StrategyStats[]> {
  const { rows } = await pool.query("SELECT * FROM strategy_stats ORDER BY strategy");
  return rows.map(r => {
    const row = r as Record<string, unknown>;
    const trades = Number(row["trades"]);
    const wins = Number(row["wins"]);
    const losses = trades - wins;
    const winPnl = Number(row["win_pnl"]);
    const lossPnl = Number(row["loss_pnl"]);
    return {
      strategy: row["strategy"] as StrategyName,
      trades, wins, losses,
      winRate: trades > 0 ? (wins / trades) * 100 : 0,
      profitFactor: lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 999 : 0,
      avgWin: wins > 0 ? winPnl / wins : 0,
      avgLoss: losses > 0 ? lossPnl / losses : 0,
      maxDrawdown: 0,
      totalPnl: Number(row["total_pnl"]),
    };
  });
}

export function formatStrategyStats(stats: StrategyStats[]): string {
  if (!stats.length) return "📊 Статистика стратегий пока недоступна.";
  // Show all strategies from DB dynamically — not just hardcoded 4
  const all = stats.filter(s => (s.strategy as string) !== "UNKNOWN");

  const names: Record<string, string> = {
    TREND: "📈 Тренд",
    BREAKOUT: "🚀 Пробой",
    VOLUME_IMPULSE: "⚡ Объёмный импульс",
    MEAN_REVERSION: "↩️ Возврат к среднему",
    UNKNOWN: "❓ Нет стратегии",
  };
  const getLabel = (key: string) => names[key] ?? `📊 ${key.replace(/_/g, " ")}`;

  const lines = all.map(s => {
    const label = getLabel(s.strategy as string);
    if (s.trades === 0) return `${label}: нет сделок`;
    const pf = s.profitFactor === 999 ? "∞" : s.profitFactor.toFixed(2);
    const icon = s.profitFactor >= 1.3 ? "✅" : s.profitFactor >= 1 ? "⚠️" : "❌";
    return `${icon} ${label}\n   ${s.trades} сд | WR ${s.winRate.toFixed(1)}% | PF ${pf} | P&L ${s.totalPnl >= 0 ? "+" : ""}${s.totalPnl.toFixed(2)}%`;
  });

  return [`🏆 *Конкуренция стратегий*`, "", ...lines].join("\n");
}

logger.info("Strategies module loaded: TREND, BREAKOUT, VOLUME_IMPULSE, MEAN_REVERSION");
