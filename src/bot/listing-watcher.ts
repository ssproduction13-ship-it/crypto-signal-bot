/**
 * Listing Watcher — автоматически отслеживает новые листинги на KuCoin.
 * Каждые 6 часов проверяет все USDT-пары:
 *   - Листинг 8–90 дней назад (достаточно исторических данных для индикаторов)
 *   - 24h объём > $500 000 (значимая ликвидность)
 *   - Не отмечена как scam-токен (st: false)
 *   - Ещё не добавлена в бот
 * Подходящие пары автоматически добавляются для всех активных пользователей.
 */
import axios from "axios";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { getCandles, validateSymbol } from "./binance.js";

const KC_BASE = "https://api.kucoin.com";

/** Минимальный возраст листинга: 8 дней → ~200 свечей на 1h */
const MIN_AGE_DAYS = 8;
/** Максимальный возраст: только свежие пары */
const MAX_AGE_DAYS = 90;
/** Минимальный 24h объём в USDT */
const MIN_VOLUME_USDT = 500_000;

interface KcSymbol {
  symbol:          string;  // "INJ-USDT"
  baseCurrency:    string;  // "INJ"
  enableTrading:   boolean;
  st:              boolean; // scam-token flag
  tradingStartTime: number | null; // ms timestamp
}

interface KcStats {
  vol:      string; // base volume
  volValue: string; // quote (USDT) volume
}

/** Конвертирует KuCoin символ "INJ-USDT" → "INJUSDT" */
function toStdSymbol(s: string): string { return s.replace(/-/g, ""); }

/** Инициализация таблицы при первом запуске */
async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watched_listings (
      symbol        TEXT PRIMARY KEY,
      listed_at     TIMESTAMPTZ,
      subscribed_at TIMESTAMPTZ,
      volume_24h    NUMERIC,
      candles_count INTEGER,
      status        TEXT DEFAULT 'pending'
    )
  `);
}

/** Получает все активные USDT-пары с KuCoin */
async function fetchKcSymbols(): Promise<KcSymbol[]> {
  const res = await axios.get(`${KC_BASE}/api/v1/symbols`, { timeout: 15_000 });
  const all = res.data.data as KcSymbol[];
  return all.filter(s =>
    s.symbol.endsWith("-USDT") &&
    s.enableTrading &&
    !s.st
  );
}

/** Получает 24h объём в USDT для пары */
async function fetchVolume(kcSymbol: string): Promise<number> {
  try {
    const res = await axios.get(`${KC_BASE}/api/v1/market/stats`, {
      params: { symbol: kcSymbol },
      timeout: 8_000,
    });
    const stats = res.data.data as KcStats;
    return parseFloat(stats.volValue) || 0;
  } catch {
    return 0;
  }
}

/** Проверяет есть ли достаточно свечей (≥200) для EMA200 */
async function hasEnoughCandles(stdSymbol: string): Promise<{ ok: boolean; count: number }> {
  try {
    const candles = await getCandles(stdSymbol, "1h", 210);
    return { ok: candles.length >= 200, count: candles.length };
  } catch {
    return { ok: false, count: 0 };
  }
}

/** Возвращает список символов которые уже отслеживаются ботом */
async function getWatchedSymbols(): Promise<Set<string>> {
  const { rows } = await pool.query(`SELECT DISTINCT symbol FROM subscriptions`);
  const watched = new Set<string>();
  for (const r of rows as Record<string, unknown>[]) {
    watched.add(String(r["symbol"]));
  }
  return watched;
}

/** Возвращает список уже обработанных листингов */
async function getKnownListings(): Promise<Set<string>> {
  await ensureTable();
  const { rows } = await pool.query(`SELECT symbol FROM watched_listings`);
  const known = new Set<string>();
  for (const r of rows as Record<string, unknown>[]) {
    known.add(String(r["symbol"]));
  }
  return known;
}

/** Сохраняет листинг в таблицу */
async function saveListingRecord(
  symbol: string, listedAt: Date, volume: number, candlesCount: number, status: string
): Promise<void> {
  await pool.query(
    `INSERT INTO watched_listings(symbol, listed_at, subscribed_at, volume_24h, candles_count, status)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT(symbol) DO UPDATE SET
       subscribed_at = $3,
       volume_24h    = $4,
       candles_count = $5,
       status        = $6`,
    [symbol, listedAt, new Date(), volume, candlesCount, status]
  );
}

/**
 * Основная функция — запускается по крону каждые 6 часов.
 * Ищет новые листинги и подписывает активных пользователей.
 */
export async function checkNewListings(
  notify: (chatId: number, msg: string) => Promise<void>
): Promise<void> {
  try {
    await ensureTable();

    const now       = Date.now();
    const minAge    = MIN_AGE_DAYS * 24 * 3600 * 1000;
    const maxAge    = MAX_AGE_DAYS * 24 * 3600 * 1000;

    const [symbols, watched, known] = await Promise.all([
      fetchKcSymbols(),
      getWatchedSymbols(),
      getKnownListings(),
    ]);

    // Кандидаты: листинг в нужном диапазоне, не отслеживается, не известен
    const candidates = symbols.filter(s => {
      if (!s.tradingStartTime) return false;
      const age = now - s.tradingStartTime;
      if (age < minAge || age > maxAge) return false;
      const stdSym = toStdSymbol(s.symbol);
      return !watched.has(stdSym) && !known.has(stdSym);
    });

    if (!candidates.length) {
      logger.debug("ListingWatcher: нет новых кандидатов");
      return;
    }

    logger.info({ candidates: candidates.length }, "ListingWatcher: проверяем кандидатов");

    // Активные пользователи
    const { rows: userRows } = await pool.query(`SELECT DISTINCT chat_id FROM subscriptions`);
    const chatIds = (userRows as Record<string, unknown>[]).map(r => Number(r["chat_id"]));

    let added = 0;

    for (const sym of candidates) {
      const stdSym  = toStdSymbol(sym.symbol);
      const listedAt = new Date(sym.tradingStartTime!);

      // Задержка между запросами — не спамим KuCoin API
      await new Promise(r => setTimeout(r, 400));

      // Проверяем объём
      const volume = await fetchVolume(sym.symbol);
      if (volume < MIN_VOLUME_USDT) {
        await saveListingRecord(stdSym, listedAt, volume, 0, "low_volume");
        logger.debug({ symbol: stdSym, volume }, "ListingWatcher: низкий объём — пропуск");
        continue;
      }

      // Явная проверка: пара существует на бирже (KuCoin — тот же API что использует бот)
      await new Promise(r => setTimeout(r, 300));
      const onExchange = await validateSymbol(stdSym);
      if (!onExchange) {
        await saveListingRecord(stdSym, listedAt, volume, 0, "not_on_exchange");
        logger.warn({ symbol: stdSym }, "ListingWatcher: символ не найден на бирже — пропуск");
        continue;
      }

      // Проверяем количество свечей
      await new Promise(r => setTimeout(r, 300));
      const { ok, count } = await hasEnoughCandles(stdSym);
      if (!ok) {
        await saveListingRecord(stdSym, listedAt, volume, count, "insufficient_candles");
        logger.debug({ symbol: stdSym, count }, "ListingWatcher: мало свечей — пропуск");
        continue;
      }

      // Всё OK — подписываем всех активных пользователей
      for (const chatId of chatIds) {
        await pool.query(
          `INSERT INTO subscriptions(chat_id, symbol, interval)
           VALUES($1, $2, $3)
           ON CONFLICT(chat_id, symbol) DO NOTHING`,
          [chatId, stdSym, "15m"]
        );
        // Уведомление пользователю
        const agedays = Math.round((now - sym.tradingStartTime!) / (24 * 3600 * 1000));
        const msg =
          `🆕 *Новый листинг добавлен*\n\n` +
          `*${stdSym}* — ${agedays} дней с листинга на KuCoin\n` +
          `24h объём: $${(volume / 1_000_000).toFixed(2)}M\n` +
          `Интервал: 15m | Стратегия: Пробой/Импульс\n\n` +
          `_Бот начнёт анализировать при следующем закрытии свечи_`;
        await notify(chatId, msg).catch(() => {});
      }

      await saveListingRecord(stdSym, listedAt, volume, count, "subscribed");
      added++;
      logger.info({ symbol: stdSym, volume, count, users: chatIds.length }, "ListingWatcher: добавлена новая пара");
    }

    if (added > 0) {
      logger.info({ added }, "ListingWatcher: добавлено новых пар");
    }
  } catch (err) {
    logger.error({ err }, "ListingWatcher: ошибка проверки");
  }
}

/** Отчёт о найденных листингах для команды /listings */
export async function getListingsReport(): Promise<string> {
  try {
    await ensureTable();
    const { rows } = await pool.query(`
      SELECT symbol, listed_at, subscribed_at, volume_24h, candles_count, status
      FROM watched_listings
      ORDER BY listed_at DESC
      LIMIT 20
    `);

    if (!rows.length) return "📋 *Листинги*\n\nЕщё не было проверок.";

    const lines = ["📋 *Найденные листинги (последние 20)*\n"];
    for (const r of rows as Record<string, unknown>[]) {
      const status = String(r["status"]);
      const icon = status === "subscribed" ? "✅" : status === "low_volume" ? "📉" : status === "not_on_exchange" ? "🚫" : "⏳";
      const vol = r["volume_24h"] ? `$${(Number(r["volume_24h"]) / 1_000_000).toFixed(2)}M` : "—";
      const dt = r["listed_at"] ? new Date(String(r["listed_at"])).toLocaleDateString("ru") : "—";
      lines.push(`${icon} *${r["symbol"]}* | ${dt} | Vol: ${vol} | ${status}`);
    }
    return lines.join("\n");
  } catch (err) {
    return "❌ Ошибка загрузки листингов";
  }
}
