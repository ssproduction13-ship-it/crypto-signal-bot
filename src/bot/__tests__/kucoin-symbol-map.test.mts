import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSpotToFuturesSymbolMap,
  requireFuturesSymbol,
} from "../kucoin-symbol-map.ts";

test("builds a spot-to-futures map from active contract metadata", () => {
  const map = buildSpotToFuturesSymbolMap(
    [
      {
        symbol: "XBTUSDTM",
        baseCurrency: "XBT",
        quoteCurrency: "USDT",
        lotSize: 1,
        tickSize: 0.1,
        multiplier: 0.001,
        status: "Open",
      },
      {
        symbol: "ETHUSDTM",
        baseCurrency: "ETH",
        quoteCurrency: "USDT",
        lotSize: 1,
        tickSize: 0.01,
        multiplier: 0.01,
        status: "Open",
      },
      {
        symbol: "OLDUSDTM",
        baseCurrency: "OLD",
        quoteCurrency: "USDT",
        lotSize: 1,
        tickSize: 0.01,
        multiplier: 1,
        status: "Close",
      },
    ],
    ["BTCUSDT", "ETHUSDT", "OLDUSDT", "SOLUSDT"],
  );

  assert.deepEqual(map, {
    BTCUSDT: "XBTUSDTM",
    ETHUSDT: "ETHUSDTM",
  });
});

test("fails closed when a contract is missing", () => {
  assert.throws(
    () => requireFuturesSymbol({ BTCUSDT: "XBTUSDTM" }, "SOLUSDT"),
    /No active KuCoin Futures contract found/,
  );
});