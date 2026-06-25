import { createRequire } from "node:module";
  import axios from "axios";
  import { logger } from "../lib/logger.js";

  const _require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WS: any = (_require("ws") as any).default ?? _require("ws");

  const INTERVAL_TO_KC: Record<string, string> = {
    "5m": "5min", "15m": "15min", "1h": "1hour", "4h": "4hour", "1d": "1day",
  };
  const KC_TO_INTERVAL: Record<string, string> = {
    "5min": "5m", "15min": "15m", "1hour": "1h", "4hour": "4h", "1day": "1d",
  };

  function toKcSym(s: string) {
    if (s.endsWith("USDT")) return s.slice(0, -4) + "-USDT";
    if (s.endsWith("BTC"))  return s.slice(0, -3) + "-BTC";
    return s;
  }
  function fromKcSym(s: string) { return s.replace(/-/g, ""); }

  type CandleCb = (symbol: string, interval: string) => void;

  class KuCoinWebSocket {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private ws: any = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private cbs: CandleCb[] = [];
    private subs = new Map<string, string>();
    private running = false;

    onNewCandle(cb: CandleCb) { this.cbs.push(cb); }

    addSubscription(symbol: string, interval: string) {
      const key = `${symbol}:${interval}`;
      if (this.subs.has(key)) return;
      const topic = `/market/candles:${toKcSym(symbol)}_${INTERVAL_TO_KC[interval] ?? interval}`;
      this.subs.set(key, topic);
      this.doSubscribe(topic);
    }

    removeSubscription(symbol: string, interval: string) {
      const key = `${symbol}:${interval}`;
      const topic = this.subs.get(key);
      if (!topic) return;
      this.subs.delete(key);
      if (this.ws?.readyState === 1)
        this.ws.send(JSON.stringify({ id: Date.now().toString(), type: "unsubscribe", topic, response: true }));
    }

    async start() { this.running = true; await this.connect(); }
    stop() {
      this.running = false;
      if (this.pingTimer)      clearInterval(this.pingTimer);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      try { this.ws?.close(); } catch {}
    }

    private doSubscribe(topic: string) {
      if (this.ws?.readyState === 1)
        this.ws.send(JSON.stringify({ id: Date.now().toString(), type: "subscribe", topic, response: true }));
    }

    private async connect() {
      try {
        const res = await axios.post("https://api.kucoin.com/api/v1/bullet-public", {}, { timeout: 10000 });
        const data = res.data.data as { token: string; instanceServers: { endpoint: string; pingInterval: number }[] };
        const srv = data.instanceServers[0]!;
        const url = `${srv.endpoint}?token=${data.token}&connectId=${Date.now()}`;

        this.ws = new WS(url);

        this.ws.on("open", () => {
          logger.info("KuCoin WebSocket connected");
          for (const t of this.subs.values()) this.doSubscribe(t);
          this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === 1)
              this.ws.send(JSON.stringify({ id: Date.now().toString(), type: "ping" }));
          }, srv.pingInterval - 3000);
        });

        this.ws.on("message", (raw: Buffer) => {
          try {
            const msg = JSON.parse(raw.toString()) as { type: string; topic?: string; subject?: string };
            if (msg.type === "message" && msg.subject === "trade.candles.add" && msg.topic) {
              const part = msg.topic.replace("/market/candles:", "");
              const idx = part.lastIndexOf("_");
              if (idx < 0) return;
              const symbol   = fromKcSym(part.slice(0, idx));
              const interval = KC_TO_INTERVAL[part.slice(idx + 1)] ?? part.slice(idx + 1);
              if (this.subs.has(`${symbol}:${interval}`))
                for (const cb of this.cbs) cb(symbol, interval);
            }
          } catch {}
        });

        this.ws.on("close", () => {
          if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
          if (!this.running) return;
          logger.warn("KuCoin WS closed — reconnecting in 5s");
          this.reconnectTimer = setTimeout(() => this.connect(), 5000);
        });

        this.ws.on("error", (err: Error) => logger.error({ err }, "KuCoin WS error"));

      } catch (err) {
        if (!this.running) return;
        logger.error({ err }, "KuCoin WS connect failed — retry 15s");
        this.reconnectTimer = setTimeout(() => this.connect(), 15000);
      }
    }
  }

  export const kuCoinWs = new KuCoinWebSocket();
  