import type { KucoinOrder } from "./kucoin-futures-client.js";

export type SandboxOrderUpdateStatus =
  | "submitted"
  | "filled"
  | "cancelled"
  | "unknown";

export interface SandboxOrderUpdate {
  clientOid: string | null;
  orderId: string | null;
  status: SandboxOrderUpdateStatus;
  raw: Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

export function normalizeSandboxOrderUpdate(
  order: KucoinOrder | Record<string, unknown>,
): SandboxOrderUpdate {
  const raw = order as Record<string, unknown>;
  const status = String(raw["status"] ?? "").toLowerCase();
  const cancelled =
    status === "cancelled" ||
    status === "canceled" ||
    raw["cancelExist"] === true;
  const done = status === "done" || status === "filled";
  const filledSize = Number(raw["dealSize"] ?? raw["filledSize"] ?? 0);

  let normalized: SandboxOrderUpdateStatus = "unknown";
  if (cancelled) normalized = "cancelled";
  else if (done && filledSize > 0) normalized = "filled";
  else if (status === "open" || status === "active" || raw["isActive"] === true) {
    normalized = "submitted";
  }

  return {
    clientOid: asString(raw["clientOid"]),
    orderId: asString(raw["orderId"] ?? raw["id"]),
    status: normalized,
    raw,
  };
}