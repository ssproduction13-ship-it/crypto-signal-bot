import axios from "axios";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { calculateOrderBookImbalance, type OrderFlowSignal } from "./order-flow-math.js";

const SPOT_API = "https://api.kucoin.com";
const FUTURES_API = "https://api-futures.kucoin.com";

export interface OrderFlowSnapshot {
  symbol: string;
  bidVolume: number;
  askVolume: number;
  imbalance: number;
  openInterest: number | null;
  capturedAt: string;
}

export { calculateOrderBookImbalance } from "./order-flow-math.js";
export type { OrderFlowSignal } from "./order-flow-math.js";

function futuresSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase();
  return normalized === "BTCUSDT"
    ? "XBTUSDTM"
    : normalized.endsWith("USDT")
      ? `${normalized.slice(0, -4)}USDTM`
      : `${normalized}M`;
}

function kucoinSpotSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase();
  return normalized.endsWith("USDT")
    ? `${normalized.slice(0, -4)}-USDT`
    : normalized;
}

export async function fetchOrderFlowSnapshot(symbol: string): Promise<OrderFlowSnapshot> {
  const capturedAt = new Date().toISOString();
  const [bookResponse, oiResponse] = await Promise.all([
    axios.get(`${SPOT_API}/api/v1/market/orderbook/level2_20`, {
      params: { symbol: kucoinSpotSymbol(symbol) },
      timeout: 8_000,
    }),
    axios.get(`${FUTURES_API}/api/v1/openInterest`, {
      params: { symbol: futuresSymbol(symbol) },
      timeout: 8_000,
    }).catch((err) => {
      logger.debug({ err, symbol }, "KuCoin open interest unavailable");
      return null;
    }),
  ]);

  const data = bookResponse.data?.data ?? {};
  const bids = toLevels(data.bids);
  const asks = toLevels(data.asks);
  const bidVolume = bids.reduce((sum, [, size]) => sum + Math.max(0, size), 0);
  const askVolume = asks.reduce((sum, [, size]) => sum + Math.max(0, size), 0);
  const total = bidVolume + askVolume;
  const imbalance = total > 0 ? (bidVolume - askVolume) / total : 0;
  const rawOi = oiResponse?.data?.data?.value ?? oiResponse?.data?.data?.openInterest;

  return {
    symbol: symbol.toUpperCase(),
    bidVolume,
    askVolume,
    imbalance,
    openInterest: rawOi == null ? null : Number(rawOi),
    capturedAt,
  };
}

export async function recordOrderFlowSnapshot(snapshot: OrderFlowSnapshot): Promise<void> {
  await pool.query(
    `INSERT INTO order_flow_snapshots
       (symbol, bid_volume, ask_volume, imbalance, open_interest, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      snapshot.symbol,
      snapshot.bidVolume,
      snapshot.askVolume,
      snapshot.imbalance,
      snapshot.openInterest,
      snapshot.capturedAt,
    ],
  );
}

export async function captureOrderFlowSnapshots(symbols: readonly string[]): Promise<number> {
  const uniqueSymbols = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
  let recorded = 0;
  for (const symbol of uniqueSymbols) {
    try {
      const snapshot = await fetchOrderFlowSnapshot(symbol);
      await recordOrderFlowSnapshot(snapshot);
      recorded++;
    } catch (err) {
      logger.warn({ err, symbol }, "Order-flow snapshot failed");
    }
  }
  return recorded;
}

function toLevels(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((level) => {
      if (!Array.isArray(level) || level.length < 2) return [];
      const price = Number(level[0]);
      const size = Number(level[1]);
      return Number.isFinite(price) && Number.isFinite(size) ? [[price, size] as [number, number]] : [];
    });
}
