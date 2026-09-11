import type { ActiveContract } from "./kucoin-futures-client.js";

export type SpotSymbol = `${string}USDT`;

function normalizeBaseCurrency(value: string): string {
  return value.toUpperCase() === "XBT" ? "BTC" : value.toUpperCase();
}

export function buildSpotToFuturesSymbolMap(
  contracts: ActiveContract[],
  spotSymbols: readonly string[],
): Record<string, string> {
  const bySpotSymbol = new Map<string, ActiveContract>();

  for (const contract of contracts) {
    const spotSymbol =
      `${normalizeBaseCurrency(contract.baseCurrency)}${contract.quoteCurrency.toUpperCase()}`;
    if (!bySpotSymbol.has(spotSymbol) && contract.status !== "Close") {
      bySpotSymbol.set(spotSymbol, contract);
    }
  }

  const result: Record<string, string> = {};
  for (const rawSymbol of spotSymbols) {
    const symbol = rawSymbol.toUpperCase();
    const contract = bySpotSymbol.get(symbol);
    if (contract) result[symbol] = contract.symbol;
  }
  return result;
}

export function requireFuturesSymbol(
  map: Readonly<Record<string, string>>,
  spotSymbol: string,
): string {
  const normalized = spotSymbol.toUpperCase();
  const futuresSymbol = map[normalized];
  if (!futuresSymbol) {
    throw new Error(`No active KuCoin Futures contract found for ${normalized}`);
  }
  return futuresSymbol;
}