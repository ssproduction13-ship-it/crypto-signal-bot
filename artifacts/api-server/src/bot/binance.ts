import axios from "axios";

const BASE_URL = "https://api.binance.com";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type Interval = "15m" | "1h" | "4h" | "1d";

export async function getCandles(
  symbol: string,
  interval: Interval = "1h",
  limit = 200
): Promise<Candle[]> {
  const url = `${BASE_URL}/api/v3/klines`;
  const res = await axios.get(url, {
    params: { symbol: symbol.toUpperCase(), interval, limit },
    timeout: 10000,
  });

  return (res.data as unknown[][]).map((k) => ({
    openTime: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    closeTime: k[6] as number,
  }));
}

export async function getPrice(symbol: string): Promise<number> {
  const res = await axios.get(`${BASE_URL}/api/v3/ticker/price`, {
    params: { symbol: symbol.toUpperCase() },
    timeout: 5000,
  });
  return parseFloat((res.data as { price: string }).price);
}

export async function validateSymbol(symbol: string): Promise<boolean> {
  try {
    await getPrice(symbol);
    return true;
  } catch {
    return false;
  }
}
