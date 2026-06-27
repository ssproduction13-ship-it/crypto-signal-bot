/**
 * Multi-Timeframe Filter — блокирует сделки против 4H тренда.
 * LONG разрешён только при восходящем 4H тренде (или нейтральном).
 * SHORT разрешён только при нисходящем 4H тренде (или нейтральном).
 */
import { getCandles } from "./binance.js";
import { calcIndicators } from "./indicators.js";
import { logger } from "../lib/logger.js";

export type Trend4H = "UP" | "DOWN" | "NEUTRAL";

export interface MTFResult {
  allowed: boolean;
  trend4h: Trend4H;
  reason: string;
  ema20_4h: number | null;
  ema50_4h: number | null;
}

export async function checkMTFAlignment(
  symbol: string,
  direction: "LONG" | "SHORT"
): Promise<MTFResult> {
  try {
    const candles4h = await getCandles(symbol, "4h", 60);

    if (candles4h.length < 30) {
      return { allowed: true, trend4h: "NEUTRAL", reason: "Мало 4H свечей — фильтр пропущен", ema20_4h: null, ema50_4h: null };
    }

    const ind = calcIndicators(candles4h);
    const ema20 = ind.ema20;
    const ema50 = ind.ema50;
    const macd  = ind.macdSignal;

    // Определяем тренд: EMA20 vs EMA50 — главный критерий, MACD — подтверждение
    let trend4h: Trend4H = "NEUTRAL";
    if (ema20 != null && ema50 != null) {
      const emaDiff = (ema20 - ema50) / ema50 * 100; // разница в %
      if (emaDiff > 0.3) {
        // EMA20 выше EMA50 на >0.3% — восходящий тренд
        trend4h = "UP";
      } else if (emaDiff < -0.3) {
        // EMA20 ниже EMA50 на >0.3% — нисходящий тренд
        trend4h = "DOWN";
      }
      // Если EMA близко (±0.3%) — нейтральный, не блокируем
    }

    // Нейтральный рынок — не блокируем сделки
    if (trend4h === "NEUTRAL") {
      return {
        allowed: true, trend4h: "NEUTRAL",
        reason: `4H нейтральный (EMA20≈EMA50) — пропускаем`,
        ema20_4h: ema20, ema50_4h: ema50,
      };
    }

    // Проверяем согласованность сигнала с 4H трендом
    if (direction === "LONG" && trend4h === "DOWN") {
      return {
        allowed: false, trend4h,
        reason: `4H нисходящий тренд — LONG заблокирован (EMA20<EMA50, MACD: ${macd})`,
        ema20_4h: ema20, ema50_4h: ema50,
      };
    }
    if (direction === "SHORT" && trend4h === "UP") {
      return {
        allowed: false, trend4h,
        reason: `4H восходящий тренд — SHORT заблокирован (EMA20>EMA50, MACD: ${macd})`,
        ema20_4h: ema20, ema50_4h: ema50,
      };
    }

    return {
      allowed: true, trend4h,
      reason: `4H ${trend4h} подтверждает ${direction}`,
      ema20_4h: ema20, ema50_4h: ema50,
    };
  } catch (err) {
    logger.warn({ err, symbol }, "MTF filter: failed to fetch 4H candles, allowing trade");
    return { allowed: true, trend4h: "NEUTRAL", reason: "Ошибка 4H данных — фильтр пропущен", ema20_4h: null, ema50_4h: null };
  }
}
