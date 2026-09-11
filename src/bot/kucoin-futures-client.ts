import axios, { type AxiosRequestConfig, type Method } from "axios";
import { signKucoinRequest } from "../lib/kucoin-signing.ts";

const DEFAULT_SANDBOX_BASE_URL = "https://api-sandbox-futures.kucoin.com";

export interface KucoinSandboxConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

export interface KucoinApiResponse<T> {
  code: string;
  data: T;
  msg?: string;
}

export interface PlaceOrderParams {
  clientOid: string;
  symbol: string;
  side: "buy" | "sell";
  leverage: number | string;
  type: "market" | "limit";
  size: number;
  price?: string;
  marginMode?: "ISOLATED" | "CROSS";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  timeInForce?: "GTC" | "IOC";
  reduceOnly?: boolean;
  closeOrder?: boolean;
  stop?: "down" | "up";
  stopPrice?: string;
  stopPriceType?: "TP" | "MP" | "IP";
}

export interface ActiveContract {
  symbol: string;
  displaySymbol?: string;
  baseCurrency: string;
  quoteCurrency: string;
  settleCurrency?: string;
  lotSize: number;
  tickSize: number;
  multiplier: number;
  status?: string;
  maxLeverage?: number;
}

export interface KucoinOrderResponse {
  orderId: string;
  clientOid?: string;
}

export interface KucoinPosition {
  symbol: string;
  currentQty: number;
  currentCost?: number;
  markPrice?: number;
  avgEntryPrice?: number;
  unrealisedPnl?: number;
  realisedPnl?: number;
  liquidationPrice?: number;
  leverage?: number;
  side?: "long" | "short";
}

export interface KucoinAccountOverview {
  accountEquity?: number;
  marginBalance?: number;
  availableBalance?: number;
  unrealisedPnl?: number;
  currency?: string;
}

function getRequiredEnv(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required KuCoin sandbox secret: ${key}`);
  return value;
}

export function getKucoinSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): KucoinSandboxConfig {
  const baseUrl = (
    env["KUCOIN_SANDBOX_BASE_URL"] ?? DEFAULT_SANDBOX_BASE_URL
  ).trim().replace(/\/+$/, "");

  if (!baseUrl.startsWith("https://")) {
    throw new Error("KUCOIN_SANDBOX_BASE_URL must use HTTPS");
  }

  return {
    baseUrl,
    apiKey: getRequiredEnv(env, "KUCOIN_SANDBOX_API_KEY"),
    apiSecret: getRequiredEnv(env, "KUCOIN_SANDBOX_API_SECRET"),
    apiPassphrase: getRequiredEnv(env, "KUCOIN_SANDBOX_API_PASSPHRASE"),
  };
}

function kucoinError(
  endpoint: string,
  response: KucoinApiResponse<unknown>,
): Error {
  const suffix = response.msg ? `: ${response.msg}` : "";
  return new Error(
    `KuCoin request failed (${response.code}) ${endpoint}${suffix}`,
  );
}

async function authedRequest<T>(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  body?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const config = getKucoinSandboxConfig(env);
  const bodyString = body === undefined ? "" : JSON.stringify(body);
  const headers = signKucoinRequest(
    method,
    endpoint,
    bodyString,
    config.apiKey,
    config.apiSecret,
    config.apiPassphrase,
  );

  const request: AxiosRequestConfig = {
    method: method as Method,
    url: `${config.baseUrl}${endpoint}`,
    headers: { ...headers, "Content-Type": "application/json" },
    timeout: 10_000,
  };
  if (body !== undefined) request.data = bodyString;

  const response = await axios.request<KucoinApiResponse<T>>(request);
  if (response.data.code !== "200000") {
    throw kucoinError(endpoint, response.data as KucoinApiResponse<unknown>);
  }
  return response.data.data;
}

export async function placeSandboxOrder(
  params: PlaceOrderParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KucoinOrderResponse> {
  return authedRequest<KucoinOrderResponse>(
    "POST",
    "/api/v1/orders",
    params as unknown as Record<string, unknown>,
    env,
  );
}

export async function cancelSandboxOrder(
  orderId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  return authedRequest("DELETE", `/api/v1/orders/${encodeURIComponent(orderId)}`, undefined, env);
}

export async function getSandboxOrder(
  orderId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  return authedRequest("GET", `/api/v1/orders/${encodeURIComponent(orderId)}`, undefined, env);
}

export async function getSandboxPositions(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KucoinPosition[]> {
  return authedRequest<KucoinPosition[]>("GET", "/api/v1/positions", undefined, env);
}

export async function getSandboxAccountOverview(
  currency = "USDT",
  env: NodeJS.ProcessEnv = process.env,
): Promise<KucoinAccountOverview> {
  return authedRequest<KucoinAccountOverview>(
    "GET",
    `/api/v1/account-overview?currency=${encodeURIComponent(currency)}`,
    undefined,
    env,
  );
}

/**
 * Public endpoint used to discover the exchange's current contract metadata.
 * It intentionally does not require sandbox credentials.
 */
export async function getActiveFuturesContracts(
  baseUrl = DEFAULT_SANDBOX_BASE_URL,
): Promise<ActiveContract[]> {
  const response = await axios.get<KucoinApiResponse<ActiveContract[]>>(
    `${baseUrl.replace(/\/+$/, "")}/api/v1/contracts/active`,
    { timeout: 10_000 },
  );
  if (response.data.code !== "200000") {
    throw kucoinError("/api/v1/contracts/active", response.data as KucoinApiResponse<unknown>);
  }
  return response.data.data;
}