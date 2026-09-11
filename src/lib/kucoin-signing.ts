import crypto from "node:crypto";

export type KucoinRequestMethod = "GET" | "POST" | "DELETE";

export interface KucoinAuthHeaders {
  "KC-API-KEY": string;
  "KC-API-SIGN": string;
  "KC-API-TIMESTAMP": string;
  "KC-API-PASSPHRASE": string;
  "KC-API-KEY-VERSION": "2";
}

/**
 * Build the authentication headers for a KuCoin Classic API v2 request.
 *
 * The caller must pass the exact endpoint used on the wire. For GET and
 * DELETE requests this includes the query string, while the body must be an
 * empty string when there is no request body.
 *
 * `timestamp` is injectable so the signing algorithm can be tested against
 * fixed vectors. Production callers should omit it.
 */
export function signKucoinRequest(
  method: KucoinRequestMethod,
  endpoint: string,
  body: string,
  apiKey: string,
  apiSecret: string,
  apiPassphrase: string,
  timestamp: number | string = Date.now(),
): KucoinAuthHeaders {
  if (!endpoint.startsWith("/")) {
    throw new Error("KuCoin endpoint must start with '/'");
  }

  const timestampString = String(timestamp);
  const prehash = timestampString + method + endpoint + body;
  const sign = crypto
    .createHmac("sha256", apiSecret)
    .update(prehash)
    .digest("base64");
  const signedPassphrase = crypto
    .createHmac("sha256", apiSecret)
    .update(apiPassphrase)
    .digest("base64");

  return {
    "KC-API-KEY": apiKey,
    "KC-API-SIGN": sign,
    "KC-API-TIMESTAMP": timestampString,
    "KC-API-PASSPHRASE": signedPassphrase,
    "KC-API-KEY-VERSION": "2",
  };
}