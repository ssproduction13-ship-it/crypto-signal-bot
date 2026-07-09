/**
 * Instrument × Direction × Regime stats
 *
 * Гранулярная аналитика: как конкретная монета торгуется
 * по конкретному направлению (LONG/SHORT) в конкретном режиме рынка.
 *
 * Позволяет ботyалу определить:
 *   — BTCUSDT LONG в trend_up: PF 1.8 → OK
 *   — XRPUSDT SHORT в sideways: PF 0.4 → снизить размер или блокировать
 */

import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { MarketRegime } from "./learning-engine.js";

export async function recordInstrumentRegimeTrade(
  symbol: string,
  direction: string,
  regime: MarketRegime,
  pnlPercent: number,
  isWin: boolean,
): Promise<void> {
  try {
    const winPnl  = isWin ? Math.abs(pnlPercent) : 0;
    const lossPnl = isWin ? 0 : Math.abs(pnlPercent);
    await pool.query(
      `INSERT INTO instrument_regime_stats
         (symbol, direction, regime, trades, wins, win_pnl, loss_pnl, total_pnl, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, NOW())
       ON CONFLICT (symbol, direction, regime) DO UPDATE SET
         trades    = instrument_regime_stats.trades    + 1,
         wins      = instrument_regime_stats.wins      + $4,
         win_pnl   = instrument_regime_stats.win_pnl   + $5,
         loss_pnl  = instrument_regime_stats.loss_pnl  + $6,
         total_pnl = instrument_regime_stats.total_pnl + $7,
         updated_at = NOW()`,
      [symbol, direction, regime, isWin ? 1 : 0, winPnl, lossPnl, pnlPercent],
    );
  } catch (err) {
    logger.debug({ err }, "recordInstrumentRegimeTrade failed");
  }
}

export interface IRDModifier {
  blocked: boolean;
  sizeMultiplier: number;
  reason: string;
}

/**
 * Возвращает модификатор размера позиции для комбинации symbol+direction+regime.
 * Срабатывает только при 15+ сделках (избегаем ложных срабатываний на малых выборках).
 *
 * Логика:
 *   PF < 0.6 && WR < 35% → блокировка (gate.fail)
 *   PF < 0.7             → размер × 0.5
 *   PF < 0.85            → размер × 0.75
 *   иначе                → 1.0 (норма)
 */
export async function getInstrumentRegimeModifier(
  symbol: string,
  direction: string,
  regime: MarketRegime,
): Promise<IRDModifier> {
  try {
    const { rows } = await pool.query(
      `SELECT trades, wins, win_pnl, loss_pnl
       FROM instrument_regime_stats
       WHERE symbol=$1 AND direction=$2 AND regime=$3`,
      [symbol, direction, regime],
    );
    if (!rows.length) return { blocked: false, sizeMultiplier: 1.0, reason: "" };

    const r      = rows[0] as Record<string, unknown>;
    const trades = Number(r["trades"]);
    if (trades < 15) return { blocked: false, sizeMultiplier: 1.0, reason: "" };

    const wins    = Number(r["wins"]);
    const winPnl  = Number(r["win_pnl"]);
    const lossPnl = Number(r["loss_pnl"]);
    const pf      = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 99 : 0;
    const wr      = trades > 0 ? wins / trades : 0;

    if (pf < 0.6 && wr < 0.35) {
      return {
        blocked: true,
        sizeMultiplier: 0,
        reason: `${symbol} ${direction}/${regime} заблокирован: PF ${pf.toFixed(2)}, WR ${(wr * 100).toFixed(0)}%, n=${trades}`,
      };
    }
    if (pf < 0.7) {
      return {
        blocked: false,
        sizeMultiplier: 0.5,
        reason: `${symbol} ${direction}/${regime}: размер ×50% (PF ${pf.toFixed(2)}, n=${trades})`,
      };
    }
    if (pf < 0.85) {
      return {
        blocked: false,
        sizeMultiplier: 0.75,
        reason: `${symbol} ${direction}/${regime}: размер ×75% (PF ${pf.toFixed(2)}, n=${trades})`,
      };
    }
    return { blocked: false, sizeMultiplier: 1.0, reason: "" };
  } catch (err) {
    logger.debug({ err }, "getInstrumentRegimeModifier failed");
    return { blocked: false, sizeMultiplier: 1.0, reason: "" };
  }
}

/** Форматированная таблица для /report или /debug команды */
export async function getInstrumentRegimeReport(limit = 20): Promise<string> {
  try {
    const { rows } = await pool.query(
      `SELECT symbol, direction, regime, trades,
              wins,
              CASE WHEN loss_pnl > 0 THEN win_pnl / loss_pnl ELSE win_pnl + 1 END AS pf
       FROM instrument_regime_stats
       WHERE trades >= 10
       ORDER BY pf ASC
       LIMIT $1`,
      [limit],
    );
    if (!rows.length) return "Нет данных (нужно 10+ сделок на комбинацию).";
    const lines = (rows as Record<string, unknown>[]).map(r =>
      `${r["symbol"]} ${r["direction"]} [${r["regime"]}] — PF ${Number(r["pf"]).toFixed(2)}, n=${r["trades"]}`,
    );
    return `*Instrument × Direction × Regime (худшие ${limit}):*\n` + lines.join("\n");
  } catch {
    return "Ошибка получения IRD-статистики.";
  }
}
