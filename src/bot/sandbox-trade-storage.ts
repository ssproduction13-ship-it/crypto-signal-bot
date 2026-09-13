import { pool } from "../lib/db.js";

export interface SandboxClosedTrade {
  positionId: string;
  chatId: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  exitPrice: number;
  multiplier: number;
  realizedPnl: number;
  exitReason: "stop_loss" | "tp1" | "tp2";
  openedAt?: string;
  closedAt?: string;
}

export interface SandboxReport {
  trades: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  winRate: number;
}

export async function recordSandboxTradeClose(
  trade: SandboxClosedTrade,
): Promise<void> {
  await pool.query(
    `INSERT INTO sandbox_closed_trades(
       position_id, chat_id, symbol, direction, size,
       entry_price, exit_price, multiplier, realized_pnl,
       exit_reason, opened_at, closed_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             COALESCE($11::timestamptz, NOW()), COALESCE($12::timestamptz, NOW()))`,
    [
      trade.positionId,
      trade.chatId,
      trade.symbol.toUpperCase(),
      trade.direction,
      trade.size,
      trade.entryPrice,
      trade.exitPrice,
      trade.multiplier,
      trade.realizedPnl,
      trade.exitReason,
      trade.openedAt ?? null,
      trade.closedAt ?? null,
    ],
  );
}

export async function getSandboxReport(chatId?: number): Promise<SandboxReport> {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS trades,
       COUNT(*) FILTER (WHERE realized_pnl > 0)::int AS wins,
       COUNT(*) FILTER (WHERE realized_pnl < 0)::int AS losses,
       COALESCE(SUM(realized_pnl), 0)::float8 AS realized_pnl
       FROM sandbox_closed_trades
      WHERE ($1::bigint IS NULL OR chat_id = $1)`,
    [chatId ?? null],
  );
  const row = result.rows[0] as Record<string, unknown>;
  const trades = Number(row["trades"] ?? 0);
  const wins = Number(row["wins"] ?? 0);
  const losses = Number(row["losses"] ?? 0);
  const realizedPnl = Number(row["realized_pnl"] ?? 0);
  return {
    trades,
    wins,
    losses,
    realizedPnl,
    winRate: trades ? (wins / trades) * 100 : 0,
  };
}