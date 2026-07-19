import axios from "axios";

const BASE_URL = "https://api.kucoin.com";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type Interval = "5m" | "15m" | "1h" | "4h" | "1d";

const INTERVAL_MAP: Record<Interval, string> = {
  "5m": "5min",
  "15m": "15min",
  "1h": "1hour",
  "4h": "4hour",
  "1d": "1day",
};

function toKucoinSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.endsWith("USDT")) return s.slice(0, -4) + "-USDT";
  if (s.endsWith("BTC")) return s.slice(0, -3) + "-BTC";
  return s;
}

export async function getCandles(
  symbol: string,
  interval: Interval = "1h",
  limit = 200
): Promise<Candle[]> {
  const kucoinSymbol = toKucoinSymbol(symbol);
  const kucoinInterval = INTERVAL_MAP[interval];

  const endAt = Math.floor(Date.now() / 1000);
  const secondsPerCandle: Record<Interval, number> = {
    "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
  };
  const startAt = endAt - secondsPerCandle[interval] * limit;

  const res = await axios.get(`${BASE_URL}/api/v1/market/candles`, {
    params: { symbol: kucoinSymbol, type: kucoinInterval, startAt, endAt },
    timeout: 10000,
  });

  const list: string[][] = res.data?.data ?? [];

  return list
    .reverse()
    .map((k) => ({
      openTime: parseInt(k[0]!) * 1000,
      open: parseFloat(k[1]!),
      close: parseFloat(k[2]!),
      high: parseFloat(k[3]!),
      low: parseFloat(k[4]!),
      volume: parseFloat(k[5]!),
      closeTime: (parseInt(k[0]!) + secondsPerCandle[interval]) * 1000,
    }));
}

export async function getPrice(symbol: string): Promise<number> {
  const kucoinSymbol = toKucoinSymbol(symbol);
  const res = await axios.get(`${BASE_URL}/api/v1/market/orderbook/level1`, {
    params: { symbol: kucoinSymbol },
    timeout: 5000,
  });
  const price = res.data?.data?.price;
  if (!price) throw new Error(`No price data for ${symbol}`);
  return parseFloat(price);
}

export async function validateSymbol(symbol: string): Promise<boolean> {
  try {
    await getPrice(symbol);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the current perpetual funding rate from KuCoin Futures.
 * Returns the raw decimal rate (e.g. 0.001 = 0.1%) or null on any error.
 * BTC special-case: BTCUSDT → XBTUSDTM; others → {BASE}USDTM.
 */
export async function getFundingRate(symbol: string): Promise<number | null> {
  try {
    const s = symbol.toUpperCase();
    let futuresSymbol: string;
    if (s === "BTCUSDT") {
      futuresSymbol = "XBTUSDTM";
    } else if (s.endsWith("USDT")) {
      futuresSymbol = s.slice(0, -4) + "USDTM";
    } else {
      futuresSymbol = s + "M";
    }
    const res = await axios.get(
      `https://api-futures.kucoin.com/api/v1/funding-rate/${futuresSymbol}/current`,
      { timeout: 5000 },
    );
    const rate = res.data?.data?.value;
    if (rate == null) return null;
    return parseFloat(rate);
  } catch {
    return null;
  }
}
