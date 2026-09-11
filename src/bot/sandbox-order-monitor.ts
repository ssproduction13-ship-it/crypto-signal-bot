import WS from "ws";
import { logger } from "../lib/logger.js";
import {
  getActiveSandboxOrders,
  getSandboxOrder,
  getSandboxPrivateToken,
  type KucoinOrder,
} from "./kucoin-futures-client.js";
import {
  listPendingSandboxOrders,
  markSandboxOrderCancelled,
  markSandboxOrderFilled,
  markSandboxOrderSubmitted,
} from "./sandbox-orders.js";
import {
  normalizeSandboxOrderUpdate,
  type SandboxOrderUpdate,
} from "./sandbox-order-status.js";

async function applyOrderUpdate(update: SandboxOrderUpdate): Promise<void> {
  if (!update.clientOid && !update.orderId) return;

  const pending = await listPendingSandboxOrders(1000);
  const local = pending.find(
    (item) =>
      (update.clientOid && item.clientOid === update.clientOid) ||
      (update.orderId && item.orderId === update.orderId),
  );
  if (!local) return;

  if (update.status === "filled") {
    await markSandboxOrderFilled(local.clientOid, update.raw);
  } else if (update.status === "cancelled") {
    await markSandboxOrderCancelled(local.clientOid, update.raw);
  } else if (
    update.status === "submitted" &&
    update.orderId
  ) {
    await markSandboxOrderSubmitted(local.clientOid, update.orderId, update.raw);
  }
}

export async function pollSandboxOrdersOnce(): Promise<number> {
  const pending = await listPendingSandboxOrders(1000);
  let processed = 0;
  const symbols = [...new Set(pending.map((item) => item.futuresSymbol))];
  const activeByClientOid = new Map<string, KucoinOrder>();

  for (const symbol of symbols) {
    const page = await getActiveSandboxOrders(symbol);
    for (const order of page.items ?? []) {
      if (order.clientOid) activeByClientOid.set(order.clientOid, order);
    }
  }

  for (const local of pending) {
    try {
      if (local.orderId) {
        const order = await getSandboxOrder(local.orderId);
        await applyOrderUpdate(normalizeSandboxOrderUpdate(order));
        processed++;
        continue;
      }

      const active = activeByClientOid.get(local.clientOid);
      if (active) {
        await applyOrderUpdate(normalizeSandboxOrderUpdate(active));
        processed++;
      }
      // A pending row with no exchange order ID is intentionally left pending:
      // the next startup reconciliation can investigate it without submitting
      // a duplicate order.
    } catch (err) {
      logger.warn(
        { err, clientOid: local.clientOid, orderId: local.orderId },
        "Sandbox order polling failed",
      );
    }
  }
  return processed;
}

export interface SandboxOrderMonitorOptions {
  pollIntervalMs?: number;
  topic?: string;
}

export class SandboxOrderMonitor {
  private ws: WS | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly topic: string;

  constructor(options: SandboxOrderMonitorOptions = {}) {
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 10_000);
    this.topic = options.topic ?? "/contractMarket/tradeOrders";
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => {
      void pollSandboxOrdersOnce();
    }, this.pollIntervalMs);
    await this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch (err) {
      logger.debug({ err }, "Sandbox private WS close error");
    }
    this.ws = null;
  }

  private async connect(): Promise<void> {
    try {
      const privateToken = await getSandboxPrivateToken();
      const server = privateToken.instanceServers[0];
      if (!server) throw new Error("KuCoin returned no private WS server");
      const url =
        `${server.endpoint}?token=${encodeURIComponent(privateToken.token)}` +
        `&connectId=${Date.now()}`;
      const ws = new WS(url);
      this.ws = ws;

      ws.on("open", () => {
        ws.send(JSON.stringify({
          id: Date.now().toString(),
          type: "subscribe",
          topic: this.topic,
          privateChannel: true,
          response: true,
        }));
        const pingEvery = Math.max(1_000, server.pingInterval - 3_000);
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WS.OPEN) {
            ws.send(JSON.stringify({ id: Date.now().toString(), type: "ping" }));
          }
        }, pingEvery);
        logger.info({ topic: this.topic }, "KuCoin sandbox private WS connected");
      });

      ws.on("message", (raw: Buffer) => {
        try {
          const message = JSON.parse(raw.toString()) as {
            type?: string;
            topic?: string;
            data?: Record<string, unknown>;
          };
          if (message.type !== "message" || !message.data) return;
          void applyOrderUpdate(normalizeSandboxOrderUpdate(message.data)).catch(
            (err: unknown) =>
              logger.error({ err }, "Sandbox order WS update failed"),
          );
        } catch (err) {
          logger.debug({ err }, "Sandbox private WS message parse error");
        }
      });

      ws.on("close", () => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (!this.running) return;
        logger.warn("KuCoin sandbox private WS closed — reconnecting in 5s");
        this.reconnectTimer = setTimeout(() => void this.connect(), 5_000);
      });

      ws.on("error", (err: Error) => {
        logger.error({ err }, "KuCoin sandbox private WS error");
      });
    } catch (err) {
      if (!this.running) return;
      logger.error({ err }, "KuCoin sandbox private WS connect failed");
      this.reconnectTimer = setTimeout(() => void this.connect(), 15_000);
    }
  }
}