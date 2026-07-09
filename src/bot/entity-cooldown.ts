/**
 * Entity × Symbol Consecutive-Loss Cooldown
 *
 * Если одна и та же entity (TREND_LONG, BREAKOUT_SHORT …) делает
 * N подряд убыточных сделок по одной монете — ставим мягкий cooldown.
 *
 * Пороги:
 *   3 подряд убытка → cooldown 8 ч
 *   5 подряд убытка → cooldown 24 ч
 *
 * Сбрасывается автоматически при первой прибыльной сделке или по истечению.
 */

import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const COOLDOWN_MS = {
  three: 8  * 60 * 60 * 1000,  // 8 ч
  five:  24 * 60 * 60 * 1000,  // 24 ч
};

export async function recordEntitySymbolResult(
  entity: string,
  symbol: string,
  isWin: boolean,
): Promise<void> {
  try {
    if (isWin) {
      // Прибыльная сделка — сбрасываем счётчик и cooldown
      await pool.query(
        `INSERT INTO entity_symbol_cooldown (entity, symbol, consecutive_losses, last_result_at, cooldown_until)
         VALUES ($1, $2, 0, NOW(), NULL)
         ON CONFLICT (entity, symbol) DO UPDATE SET
           consecutive_losses = 0,
           last_result_at     = NOW(),
           cooldown_until     = NULL`,
        [entity, symbol],
      );
      return;
    }

    // Убыточная сделка — увеличиваем счётчик
    const { rows } = await pool.query(
      `INSERT INTO entity_symbol_cooldown (entity, symbol, consecutive_losses, last_result_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (entity, symbol) DO UPDATE SET
         consecutive_losses = entity_symbol_cooldown.consecutive_losses + 1,
         last_result_at     = NOW()
       RETURNING consecutive_losses`,
      [entity, symbol],
    );

    if (!rows.length) return;
    const consecutive = Number((rows[0] as Record<string, unknown>)["consecutive_losses"]);

    let cooldownMs = 0;
    if (consecutive >= 5)      cooldownMs = COOLDOWN_MS.five;
    else if (consecutive >= 3) cooldownMs = COOLDOWN_MS.three;

    if (cooldownMs > 0) {
      const until = new Date(Date.now() + cooldownMs).toISOString();
      await pool.query(
        `UPDATE entity_symbol_cooldown SET cooldown_until=$3 WHERE entity=$1 AND symbol=$2`,
        [entity, symbol, until],
      );
      logger.info(
        { entity, symbol, consecutive, until },
        `Entity cooldown activated: ${consecutive} consecutive losses`,
      );
    }
  } catch (err) {
    logger.debug({ err }, "recordEntitySymbolResult failed");
  }
}

export interface EntityCooldownResult {
  blocked: boolean;
  until: string | null;
  consecutiveLosses: number;
}

export async function isEntitySymbolOnCooldown(
  entity: string,
  symbol: string,
): Promise<EntityCooldownResult> {
  try {
    const { rows } = await pool.query(
      `SELECT consecutive_losses, cooldown_until
       FROM entity_symbol_cooldown
       WHERE entity=$1 AND symbol=$2`,
      [entity, symbol],
    );
    if (!rows.length) return { blocked: false, until: null, consecutiveLosses: 0 };

    const r            = rows[0] as Record<string, unknown>;
    const consecutive  = Number(r["consecutive_losses"]);
    const until        = r["cooldown_until"] as string | null;

    if (until && new Date(until) > new Date()) {
      return { blocked: true, until, consecutiveLosses: consecutive };
    }
    return { blocked: false, until: null, consecutiveLosses: consecutive };
  } catch (err) {
    logger.debug({ err }, "isEntitySymbolOnCooldown failed");
    return { blocked: false, until: null, consecutiveLosses: 0 };
  }
}

/** Для отображения в /report — топ активных cooldown'ов */
export async function getActiveCooldowns(): Promise<string> {
  try {
    const { rows } = await pool.query(
      `SELECT entity, symbol, consecutive_losses, cooldown_until
       FROM entity_symbol_cooldown
       WHERE cooldown_until > NOW()
       ORDER BY consecutive_losses DESC
       LIMIT 20`,
    );
    if (!rows.length) return "Активных cooldown'ов нет.";
    const lines = (rows as Record<string, unknown>[]).map(r => {
      const until = r["cooldown_until"] as string;
      const h = Math.ceil((new Date(until).getTime() - Date.now()) / 3_600_000);
      return `🚫 ${r["entity"]} / ${r["symbol"]}: ${r["consecutive_losses"]} убытков подряд, ещё ~${h}ч`;
    });
    return `*Активные cooldown'ы (entity×монета):*\n` + lines.join("\n");
  } catch {
    return "Ошибка получения cooldown-статистики.";
  }
}
