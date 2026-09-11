import { pool } from "../lib/db.js";
import { buildSandboxClientOid } from "../lib/sandbox-order-identity.js";

export type SandboxOrderStatus =
  | "pending"
  | "submitted"
  | "filled"
  | "cancelled"
  | "rejected"
  | "unknown";

export interface ReserveSandboxOrderInput {
  internalSignalId: string;
  chatId: number;
  symbol: string;
  futuresSymbol: string;
  direction: "LONG" | "SHORT";
  side: "buy" | "sell";
  orderType: "market" | "limit";
  size: number;
  entryPrice?: number;
  payload: Record<string, unknown>;
}

export interface SandboxOrderRecord {
  id: number;
  internalSignalId: string;
  clientOid: string;
  orderId: string | null;
  chatId: number;
  symbol: string;
  futuresSymbol: string;
  direction: "LONG" | "SHORT";
  side: "buy" | "sell";
  orderType: "market" | "limit";
  size: number;
  entryPrice: number | null;
  status: SandboxOrderStatus;
  rejectReason: string | null;
  response: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  filledAt: string | null;
}

function toRecord(row: Record<string, unknown>): SandboxOrderRecord {
  return {
    id: Number(row["id"]),
    internalSignalId: String(row["internal_signal_id"]),
    clientOid: String(row["client_oid"]),
    orderId: row["order_id"] == null ? null : String(row["order_id"]),
    chatId: Number(row["chat_id"]),
    symbol: String(row["symbol"]),
    futuresSymbol: String(row["futures_symbol"]),
    direction: String(row["direction"]) as "LONG" | "SHORT",
    side: String(row["side"]) as "buy" | "sell",
    orderType: String(row["order_type"]) as "market" | "limit",
    size: Number(row["size"]),
    entryPrice: row["entry_price"] == null ? null : Number(row["entry_price"]),
    status: String(row["status"]) as SandboxOrderStatus,
    rejectReason: row["reject_reason"] == null ? null : String(row["reject_reason"]),
    response: (row["response_json"] as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(row["created_at"])).toISOString(),
    updatedAt: new Date(String(row["updated_at"])).toISOString(),
    filledAt: row["filled_at"] == null ? null : new Date(String(row["filled_at"])).toISOString(),
  };
}

export async function reserveSandboxOrder(
  input: ReserveSandboxOrderInput,
): Promise<SandboxOrderRecord> {
  const clientOid = buildSandboxClientOid(input.internalSignalId);
  const result = await pool.query(
    `INSERT INTO sandbox_orders(
       internal_signal_id, client_oid, chat_id, symbol, futures_symbol,
       direction, side, order_type, size, entry_price, status, payload_json
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
     ON CONFLICT (client_oid) DO NOTHING
     RETURNING *`,
    [
      input.internalSignalId,
      clientOid,
      input.chatId,
      input.symbol.toUpperCase(),
      input.futuresSymbol.toUpperCase(),
      input.direction,
      input.side,
      input.orderType,
      input.size,
      input.entryPrice ?? null,
      JSON.stringify(input.payload),
    ],
  );

  if (result.rows.length) return toRecord(result.rows[0] as Record<string, unknown>);

  const existing = await pool.query(
    "SELECT * FROM sandbox_orders WHERE client_oid = $1",
    [clientOid],
  );
  if (!existing.rows.length) {
    throw new Error(`Sandbox order reservation disappeared for ${clientOid}`);
  }
  return toRecord(existing.rows[0] as Record<string, unknown>);
}

export async function markSandboxOrderSubmitted(
  clientOid: string,
  orderId: string,
  response: Record<string, unknown>,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sandbox_orders
        SET order_id = $2, status = 'submitted', response_json = $3, updated_at = NOW()
      WHERE client_oid = $1
        AND status = 'pending'`,
    [clientOid, orderId, JSON.stringify(response)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markSandboxOrderRejected(
  clientOid: string,
  reason: string,
  response?: Record<string, unknown>,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sandbox_orders
        SET status = 'rejected', reject_reason = $2,
            response_json = $3, updated_at = NOW()
      WHERE client_oid = $1
        AND status IN ('pending', 'submitted')`,
    [clientOid, reason.slice(0, 2000), response ? JSON.stringify(response) : null],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listPendingSandboxOrders(
  limit = 100,
): Promise<SandboxOrderRecord[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  const result = await pool.query(
    `SELECT *
       FROM sandbox_orders
      WHERE status IN ('pending', 'submitted')
      ORDER BY created_at ASC
      LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map((row) => toRecord(row as Record<string, unknown>));
}