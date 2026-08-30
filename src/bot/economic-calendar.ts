import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export type EconomicImpact = "low" | "medium" | "high";

export interface EconomicEvent {
  id: number;
  title: string;
  currency: string;
  impact: EconomicImpact;
  eventAt: string;
  blackoutBeforeMinutes: number;
  blackoutAfterMinutes: number;
}

export interface AddEconomicEventInput {
  title: string;
  currency?: string;
  impact: EconomicImpact;
  eventAt: Date;
  blackoutBeforeMinutes?: number;
  blackoutAfterMinutes?: number;
  createdBy: number;
}

const DEFAULT_BLACKOUT_MINUTES: Record<EconomicImpact, number> = {
  low: 5,
  medium: 15,
  high: 30,
};

export function defaultBlackoutMinutes(impact: EconomicImpact): number {
  return DEFAULT_BLACKOUT_MINUTES[impact];
}

export async function addEconomicEvent(input: AddEconomicEventInput): Promise<EconomicEvent> {
  const before = input.blackoutBeforeMinutes ?? defaultBlackoutMinutes(input.impact);
  const after = input.blackoutAfterMinutes ?? defaultBlackoutMinutes(input.impact);
  const { rows } = await pool.query(
    `INSERT INTO economic_events
       (title, currency, impact, event_at, blackout_before_minutes, blackout_after_minutes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, title, currency, impact, event_at, blackout_before_minutes, blackout_after_minutes`,
    [
      input.title.trim(),
      (input.currency ?? "GLOBAL").trim().toUpperCase(),
      input.impact,
      input.eventAt.toISOString(),
      before,
      after,
      input.createdBy,
    ],
  );
  return toEconomicEvent(rows[0] as Record<string, unknown>);
}

export async function getActiveEconomicBlackout(
  now = new Date(),
): Promise<EconomicEvent | null> {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, currency, impact, event_at,
              blackout_before_minutes, blackout_after_minutes
         FROM economic_events
        WHERE $1::timestamptz BETWEEN
              event_at - blackout_before_minutes * INTERVAL '1 minute'
          AND event_at + blackout_after_minutes * INTERVAL '1 minute'
        ORDER BY event_at ASC
        LIMIT 1`,
      [now.toISOString()],
    );
    return rows.length ? toEconomicEvent(rows[0] as Record<string, unknown>) : null;
  } catch (err) {
    logger.error({ err }, "Economic calendar lookup failed");
    return null;
  }
}

export async function listUpcomingEconomicEvents(limit = 10): Promise<EconomicEvent[]> {
  const { rows } = await pool.query(
    `SELECT id, title, currency, impact, event_at,
            blackout_before_minutes, blackout_after_minutes
       FROM economic_events
      WHERE event_at >= NOW() - INTERVAL '1 day'
      ORDER BY event_at ASC
      LIMIT $1`,
    [limit],
  );
  return (rows as Record<string, unknown>[]).map(toEconomicEvent);
}

function toEconomicEvent(row: Record<string, unknown>): EconomicEvent {
  return {
    id: Number(row["id"]),
    title: String(row["title"]),
    currency: String(row["currency"] ?? "GLOBAL"),
    impact: String(row["impact"]) as EconomicImpact,
    eventAt: new Date(String(row["event_at"])).toISOString(),
    blackoutBeforeMinutes: Number(row["blackout_before_minutes"]),
    blackoutAfterMinutes: Number(row["blackout_after_minutes"]),
  };
}

export function formatEconomicBlackout(event: EconomicEvent): string {
  return `Экономическое событие: ${event.title} (${event.currency}, ${event.impact})`;
}
