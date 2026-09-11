import { logger } from "../lib/logger.js";
import {
  getActiveFuturesContracts,
  getKucoinSandboxConfig,
  getSandboxAccountOverview,
  placeSandboxOrder,
  KucoinApiError,
  type ActiveContract,
} from "./kucoin-futures-client.js";
import { buildSandboxClientOid } from "../lib/sandbox-order-identity.js";
import {
  markSandboxOrderRejected,
  markSandboxOrderSubmitted,
  reserveSandboxOrder,
} from "./sandbox-orders.js";
import {
  buildSpotToFuturesSymbolMap,
  requireFuturesSymbol,
} from "./kucoin-symbol-map.js";
import { calculateSandboxContractSize } from "./sandbox-sizing.js";

export interface OpenSandboxPositionInput {
  internalSignalId: string;
  chatId: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  riskPercent: number;
  strategy: string;
  interval: string;
}

export interface OpenSandboxPositionResult {
  success: boolean;
  status: "submitted" | "already_reserved" | "pending" | "rejected";
  clientOid: string;
  orderId?: string;
  futuresSymbol?: string;
  size?: number;
  message: string;
}

async function loadContract(
  symbol: string,
  env: NodeJS.ProcessEnv,
): Promise<ActiveContract> {
  const config = getKucoinSandboxConfig(env);
  const contracts = await getActiveFuturesContracts(config.baseUrl);
  const map = buildSpotToFuturesSymbolMap(contracts, [symbol]);
  const futuresSymbol = requireFuturesSymbol(map, symbol);
  const contract = contracts.find((item) => item.symbol === futuresSymbol);
  if (!contract) {
    throw new Error(`Contract metadata missing for ${futuresSymbol}`);
  }
  if (contract.isInverse) {
    throw new Error(`Inverse contract ${futuresSymbol} is not supported safely yet`);
  }
  return contract;
}

export async function openSandboxPosition(
  input: OpenSandboxPositionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenSandboxPositionResult> {
  const clientOid = buildSandboxClientOid(input.internalSignalId);
  let contract: ActiveContract;

  try {
    contract = await loadContract(input.symbol, env);
    const account = await getSandboxAccountOverview("USDT", env);
    const accountBalance = Number(
      account.availableBalance ?? account.marginBalance ?? account.accountEquity ?? 0,
    );
    const size = calculateSandboxContractSize({
      accountBalance,
      riskPercent: input.riskPercent,
      entryPrice: input.entryPrice,
      stopLoss: input.stopLoss,
      multiplier: Number(contract.multiplier),
      lotSize: Number(contract.lotSize),
      maxOrderQty: Number(contract.maxOrderQty),
    });

    if (!size) {
      return {
        success: false,
        status: "rejected",
        clientOid,
        futuresSymbol: contract.symbol,
        message: "Sandbox contract size rounded to zero; order was not sent",
      };
    }

    const reservation = await reserveSandboxOrder({
      internalSignalId: input.internalSignalId,
      chatId: input.chatId,
      symbol: input.symbol,
      futuresSymbol: contract.symbol,
      direction: input.direction,
      side: input.direction === "LONG" ? "buy" : "sell",
      orderType: "market",
      size,
      entryPrice: input.entryPrice,
      payload: {
        strategy: input.strategy,
        interval: input.interval,
        stopLoss: input.stopLoss,
        riskPercent: input.riskPercent,
      },
    });

    if (reservation.status !== "pending") {
      return {
        success: reservation.status === "submitted" || reservation.status === "filled",
        status: "already_reserved",
        clientOid: reservation.clientOid,
        orderId: reservation.orderId ?? undefined,
        futuresSymbol: contract.symbol,
        size: reservation.size,
        message: `Sandbox order already has status ${reservation.status}; no duplicate was sent`,
      };
    }

    try {
      const response = await placeSandboxOrder(
        {
          clientOid,
          symbol: contract.symbol,
          side: input.direction === "LONG" ? "buy" : "sell",
          leverage: 1,
          type: "market",
          size,
          marginMode: "ISOLATED",
          positionSide: "BOTH",
          reduceOnly: false,
        },
        env,
      );
      await markSandboxOrderSubmitted(
        clientOid,
        response.orderId,
        response as unknown as Record<string, unknown>,
      );
      return {
        success: true,
        status: "submitted",
        clientOid,
        orderId: response.orderId,
        futuresSymbol: contract.symbol,
        size,
        message: `Sandbox ${input.direction} order submitted for ${size} contracts`,
      };
    } catch (err) {
      if (err instanceof KucoinApiError) {
        const reason = `${err.code}: ${err.message}`;
        await markSandboxOrderRejected(
          clientOid,
          reason,
          err.responseBody as unknown as Record<string, unknown>,
        );
        return {
          success: false,
          status: "rejected",
          clientOid,
          futuresSymbol: contract.symbol,
          size,
          message: `KuCoin rejected the sandbox order (${err.code})`,
        };
      }
      // Do not mark an uncertain network failure as rejected. The reservation
      // remains pending and polling/reconciliation can safely investigate it
      // without creating a duplicate order.
      logger.error(
        { err, clientOid, symbol: input.symbol },
        "Sandbox order request failed after reservation",
      );
      return {
        success: false,
        status: "pending",
        clientOid,
        futuresSymbol: contract.symbol,
        size,
        message: "Sandbox order outcome is uncertain; left pending for reconciliation",
      };
    }
  } catch (err) {
    logger.error(
      { err, clientOid, symbol: input.symbol },
      "Sandbox position preparation failed",
    );
    return {
      success: false,
      status: "rejected",
      clientOid,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}