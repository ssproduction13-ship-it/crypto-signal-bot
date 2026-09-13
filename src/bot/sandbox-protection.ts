import { logger } from "../lib/logger.js";
import {
  KucoinApiError,
  placeSandboxOrder,
  type PlaceOrderParams,
} from "./kucoin-futures-client.js";
import {
  markSandboxOrderRejected,
  markSandboxOrderSubmitted,
  reserveSandboxOrder,
} from "./sandbox-orders.js";
import type { LocalSandboxPosition } from "./sandbox-position-storage.js";

interface ProtectionSpec {
  kind: "stop_loss" | "tp1" | "tp2";
  price: number;
  size: number;
  stop: "down" | "up";
}

function buildProtectionSpecs(position: LocalSandboxPosition): ProtectionSpec[] {
  if (
    !Number.isFinite(position.size) ||
    position.size <= 0 ||
    !Number.isFinite(position.stopLoss) ||
    !Number.isFinite(position.tp1) ||
    !Number.isFinite(position.tp2) ||
    position.stopLoss <= 0 ||
    position.tp1 <= 0 ||
    position.tp2 <= 0
  ) {
    return [];
  }

  const exitStop = position.direction === "LONG" ? "down" : "up";
  const exitTakeProfit = position.direction === "LONG" ? "up" : "down";
  const firstTakeProfitSize =
    position.size <= 1 ? position.size : Math.floor(position.size / 2);
  const secondTakeProfitSize = position.size - firstTakeProfitSize;
  const specs: ProtectionSpec[] = [
    {
      kind: "stop_loss",
      price: position.stopLoss,
      size: position.size,
      stop: exitStop,
    },
    {
      kind: "tp1",
      price: position.tp1,
      size: firstTakeProfitSize,
      stop: exitTakeProfit,
    },
  ];
  if (secondTakeProfitSize > 0) {
    specs.push({
      kind: "tp2",
      price: position.tp2,
      size: secondTakeProfitSize,
      stop: exitTakeProfit,
    });
  }
  return specs.filter((spec) => spec.size > 0);
}

export async function placeSandboxProtectionOrders(
  position: LocalSandboxPosition,
): Promise<void> {
  for (const spec of buildProtectionSpecs(position)) {
    const internalSignalId = `${position.id}:${spec.kind}`;
    const clientOid = (await reserveSandboxOrder({
      internalSignalId,
      chatId: position.chatId,
      symbol: position.symbol,
      futuresSymbol: position.futuresSymbol,
      direction: position.direction,
      side: position.direction === "LONG" ? "sell" : "buy",
      orderType: "market",
      size: spec.size,
      entryPrice: spec.price,
      payload: {
        kind: spec.kind,
        positionId: position.id,
        stopLoss: position.stopLoss,
        tp1: position.tp1,
        tp2: position.tp2,
        positionSize: position.size,
        triggerPrice: spec.price,
      },
    }));

    if (clientOid.status !== "pending") continue;

    const params: PlaceOrderParams = {
      clientOid: clientOid.clientOid,
      symbol: position.futuresSymbol,
      side: position.direction === "LONG" ? "sell" : "buy",
      leverage: 1,
      type: "market",
      size: spec.size,
      marginMode: "ISOLATED",
      positionSide: "BOTH",
      reduceOnly: true,
      stop: spec.stop,
      stopPrice: String(spec.price),
      stopPriceType: "MP",
    };

    try {
      const response = await placeSandboxOrder(params);
      await markSandboxOrderSubmitted(
        clientOid.clientOid,
        response.orderId,
        response as unknown as Record<string, unknown>,
      );
    } catch (err) {
      if (err instanceof KucoinApiError) {
        await markSandboxOrderRejected(
          clientOid.clientOid,
          `${err.code}: ${err.message}`,
          err.responseBody as unknown as Record<string, unknown>,
        );
      } else {
        logger.error(
          { err, clientOid: clientOid.clientOid, kind: spec.kind },
          "Sandbox protection order outcome is uncertain",
        );
      }
    }
  }
}