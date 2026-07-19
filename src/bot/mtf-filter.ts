/**
   * Multi-Timeframe Filter — проверяет согласованность сигнала с 4H трендом.
   * Counter-trend сделки НЕ блокируются — размер позиции снижается вдвое.
   * Только нейтральный и согласованный тренд → полный размер.
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
    /** 1.0 = full size, 0.5 = counter-trend (reduced), 0 = blocked */
    sizeMultiplier: number;
  }

  
// ── Cache: 4H candles update every 4 hours; checking every 5 min is wasteful
// fix: 60 pairs × every 5 min = 60 KuCoin requests/5min → rate-limit risk
const mtfCache = new Map<string, { result: MTFResult; expiresAt: number }>();
const MTF_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function checkMTFAlignment(
    symbol: string,
    direction: "LONG" | "SHORT"
  ): Promise<MTFResult> {
    // fix: cacheKey was used in mtfCache.set() below but never declared → ReferenceError on every call
    const cacheKey = `mtf_${symbol}_${direction}`;
    const cached = mtfCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    try {
      const candles4h = await getCandles(symbol, "4h", 60);

      if (candles4h.length < 30) {
        return { allowed: true, trend4h: "NEUTRAL", sizeMultiplier: 1.0,
                 reason: "Мало 4H свечей — фильтр пропущен", ema20_4h: null, ema50_4h: null };
      }

      const ind   = calcIndicators(candles4h);
      const ema20 = ind.ema20;
      const ema50 = ind.ema50;
      const macd  = ind.macdSignal;

      let trend4h: Trend4H = "NEUTRAL";
      if (ema20 != null && ema50 != null) {
        const emaDiff = (ema20 - ema50) / ema50 * 100;
        if (emaDiff > 0.3)       trend4h = "UP";
        else if (emaDiff < -0.3) trend4h = "DOWN";
      }

      if (trend4h === "NEUTRAL") {
        return { allowed: true, trend4h: "NEUTRAL", sizeMultiplier: 1.0,
                 reason: `4H нейтральный (EMA20≈EMA50) — полный размер`,
                 ema20_4h: ema20, ema50_4h: ema50 };
      }

      const isCounterTrend =
        (direction === "LONG"  && trend4h === "DOWN") ||
        (direction === "SHORT" && trend4h === "UP");

      if (isCounterTrend) {
        // Не блокируем — снижаем размер вдвое для управления риском
        // fix: counter-trend result теперь тоже кэшируется — без кэша каждый вызов
        // делал свежий API-запрос к KuCoin (60 пар × 5 мин = до 60 req/5min → rate-limit)
        const counterResult: MTFResult = {
          allowed: true, trend4h, sizeMultiplier: 0.5,
          reason: `4H ${trend4h === "DOWN" ? "нисходящий" : "восходящий"} — контртренд, размер ×0.5 (MACD: ${macd})`,
          ema20_4h: ema20, ema50_4h: ema50,
        };
        mtfCache.set(cacheKey, { result: counterResult, expiresAt: Date.now() + MTF_CACHE_TTL_MS });
        return counterResult;
      }

      const finalResult: MTFResult = {
        allowed: true, trend4h, sizeMultiplier: 1.0,
        reason: `4H ${trend4h} подтверждает ${direction} — полный размер`,
        ema20_4h: ema20, ema50_4h: ema50,
      };
      mtfCache.set(cacheKey, { result: finalResult, expiresAt: Date.now() + MTF_CACHE_TTL_MS });
      return finalResult;
    } catch (err) {
      logger.warn({ err, symbol }, "MTF filter: failed to fetch 4H candles, allowing trade");
      return { allowed: true, trend4h: "NEUTRAL", sizeMultiplier: 1.0,
               reason: "Ошибка 4H данных — фильтр пропущен", ema20_4h: null, ema50_4h: null };
    }
  }
  