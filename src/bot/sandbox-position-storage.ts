import { pool } from "../lib/db.js";

export interface LocalSandboxPosition {
  id: string;
  chatId: number;
  symbol: string;
  futuresSymbol: string;
  direction: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  orderId: string | null;
  updatedAt: string;
}

function toPosition(row: Record<string, unknown>): LocalSandboxPosition {
  return {
    id: String(row["id"]),
    chatId: Number(row["chat_id"]),
    symbol: String(row["symbol"]),
    futuresSymbol: String(row["futures_symbol"]),
    direction: String(row["direction"]) as "LONG" | "SHORT",
    size: Number(row["size"]),
    entryPrice: Number(row["entry_price"]),
    orderId: row["order_id"] == null ? null : String(row["order_id"]),
    updatedAt: new Date(String(row["updated_at"])).toISOString(),
  };
}

export async function loadLocalSandboxPositions(): Promise<LocalSandboxPosition[]> {
  const result = await pool.query(
    `SELECT *
       FROM sandbox_positions
      WHERE status = 'open'
      ORDER BY updated_at ASC`,
  );
  return result.rows.map((row) => toPosition(row as Record<string, unknown>));
}

export async function upsertLocalSandboxPosition(
  position: Omit<LocalSandboxPosition, "updatedAt">,
): Promise<void> {
  await pool.query(
    `INSERT INTO sandbox_positions(
       id, chat_id, symbol, futures_symbol, direction, size,
       entry_price, order_id, status, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',NOW())
     ON CONFLICT (id) DO UPDATE SET
       size = EXCLUDED.size,
       entry_price = EXCLUDED.entry_price,
       order_id = EXCLUDED.order_id,
       status = 'open',
       updated_at = NOW()`,
    [
      position.id,
      position.chatId,
      position.symbol.toUpperCase(),
      position.futuresSymbol.toUpperCase(),
      position.direction,
      position.size,
      position.entryPrice,
      position.orderId,
    ],
  );
}

export async function closeLocalSandboxPosition(id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sandbox_positions
        SET status = 'closed', updated_at = NOW()
      WHERE id = $1
        AND status = 'open'`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}