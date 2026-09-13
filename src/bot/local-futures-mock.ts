import { buildSandboxClientOid } from "../lib/sandbox-order-identity.ts";
import { calculateSandboxContractSize } from "./sandbox-sizing.ts";

export type MockOrderKind = "entry" | "stop_loss" | "tp1" | "tp2";
export type MockOrderStatus = "submitted" | "filled" | "cancelled" | "rejected";

export interface MockPosition {
  id: string;
  chatId: number;
  symbol: string;
  futuresSymbol: string;
  direction: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
}

export interface MockOrder {
  clientOid: string;
  orderId: string;
  kind: MockOrderKind;
  positionId: string;
  side: "buy" | "sell";
  size: number;
  triggerPrice: number | null;
  status: MockOrderStatus;
}

export interface MockOpenInput {
  internalSignalId: string;
  chatId: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  riskPercent: number;
  accountBalance?: number;
  multiplier?: number;
  lotSize?: number;
  maxOrderQty?: number;
}

export interface MockOpenResult {
  success: boolean;
  status: "filled" | "already_filled" | "rejected";
  clientOid: string;
  orderId?: string;
  position?: MockPosition;
  message: string;
}

export class LocalFuturesMock {
  private readonly orders = new Map<string, MockOrder>();
  private readonly positions = new Map<string, MockPosition>();
  private sequence = 0;

  open(input: MockOpenInput): MockOpenResult {
    const clientOid = buildSandboxClientOid(input.internalSignalId);
    const existing = this.orders.get(clientOid);
    if (existing) {
      return {
        success: existing.status === "filled",
        status: existing.status === "filled" ? "already_filled" : "rejected",
        clientOid,
        orderId: existing.orderId,
        position: this.positions.get(existing.positionId),
        message: "Mock idempotency prevented a duplicate entry",
      };
    }

    const size = calculateSandboxContractSize({
      accountBalance: input.accountBalance ?? 10_000,
      riskPercent: input.riskPercent,
      entryPrice: input.entryPrice,
      stopLoss: input.stopLoss,
      multiplier: input.multiplier ?? 0.001,
      lotSize: input.lotSize ?? 1,
      maxOrderQty: input.maxOrderQty,
    });
    if (!size) {
      return {
        success: false,
        status: "rejected",
        clientOid,
        message: "Mock contract size rounded to zero",
      };
    }

    const position: MockPosition = {
      id: clientOid,
      chatId: input.chatId,
      symbol: input.symbol.toUpperCase(),
      futuresSymbol: `${input.symbol.toUpperCase().replace(/USDT$/, "")}USDT`,
      direction: input.direction,
      size,
      entryPrice: input.entryPrice,
      stopLoss: input.stopLoss,
      tp1: input.tp1,
      tp2: input.tp2,
    };
    const entryOrder = this.addOrder({
      clientOid,
      kind: "entry",
      positionId: position.id,
      side: input.direction === "LONG" ? "buy" : "sell",
      size,
      triggerPrice: null,
      status: "filled",
    });
    this.positions.set(position.id, position);

    const tp1Size = size <= 1 ? size : Math.floor(size / 2);
    const tp2Size = size - tp1Size;
    this.addProtectionOrder(position, "stop_loss", size, input.stopLoss);
    this.addProtectionOrder(position, "tp1", tp1Size, input.tp1);
    if (tp2Size > 0) this.addProtectionOrder(position, "tp2", tp2Size, input.tp2);

    return {
      success: true,
      status: "filled",
      clientOid,
      orderId: entryOrder.orderId,
      position,
      message: "Mock market entry filled and protection orders created",
    };
  }

  trigger(
    positionId: string,
    kind: Exclude<MockOrderKind, "entry">,
  ): MockPosition | null {
    const order = [...this.orders.values()].find(
      (item) =>
        item.positionId === positionId &&
        item.kind === kind &&
        item.status === "submitted",
    );
    if (!order) return this.positions.get(positionId) ?? null;

    order.status = "filled";
    const position = this.positions.get(positionId);
    if (!position) return null;

    if (kind === "tp1" && order.size < position.size) {
      position.size -= order.size;
      return position;
    }

    this.positions.delete(positionId);
    for (const sibling of this.orders.values()) {
      if (
        sibling.positionId === positionId &&
        sibling.clientOid !== order.clientOid &&
        sibling.status === "submitted"
      ) {
        sibling.status = "cancelled";
      }
    }
    return null;
  }

  getPosition(positionId: string): MockPosition | null {
    return this.positions.get(positionId) ?? null;
  }

  listOrders(positionId?: string): MockOrder[] {
    return [...this.orders.values()].filter(
      (order) => !positionId || order.positionId === positionId,
    );
  }

  private addProtectionOrder(
    position: MockPosition,
    kind: Exclude<MockOrderKind, "entry">,
    size: number,
    triggerPrice: number,
  ): void {
    this.addOrder({
      clientOid: buildSandboxClientOid(`${position.id}:${kind}`),
      kind,
      positionId: position.id,
      side: position.direction === "LONG" ? "sell" : "buy",
      size,
      triggerPrice,
      status: "submitted",
    });
  }

  private addOrder(input: Omit<MockOrder, "orderId">): MockOrder {
    const order = {
      ...input,
      orderId: `mock-order-${++this.sequence}`,
    };
    this.orders.set(order.clientOid, order);
    return order;
  }
}