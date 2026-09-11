import assert from "node:assert/strict";
import test from "node:test";
import { signKucoinRequest } from "../../lib/kucoin-signing.ts";

test("signs a GET request with the exact endpoint", () => {
  const headers = signKucoinRequest(
    "GET",
    "/api/v1/accounts",
    "",
    "public-key",
    "secret-key",
    "passphrase",
    1547015186000,
  );

  assert.deepEqual(headers, {
    "KC-API-KEY": "public-key",
    "KC-API-SIGN": "S+hEjCjD3fjlKPtfKPivZcrhfFnSUXNAnDd4y7hSr/s=",
    "KC-API-TIMESTAMP": "1547015186000",
    "KC-API-PASSPHRASE": "OdjN1x4cRK2QtY6gdC18Yvn3xaNgJwkE55EC1lWXMDE=",
    "KC-API-KEY-VERSION": "2",
  });
});

test("includes the query string and exact JSON body in the signature", () => {
  const headers = signKucoinRequest(
    "POST",
    "/api/v1/orders?dryRun=false",
    '{"clientOid":"abc","symbol":"XBTUSDTM","side":"buy"}',
    "public-key",
    "secret-key",
    "passphrase",
    "1547015186000",
  );

  assert.equal(
    headers["KC-API-SIGN"],
    "6+lV6PllTetj6xesPpU1TiNzqKeQJKwL9vVTDX1OuR4=",
  );
});

test("rejects endpoints without a leading slash", () => {
  assert.throws(
    () =>
      signKucoinRequest(
        "GET",
        "api/v1/accounts",
        "",
        "public-key",
        "secret-key",
        "passphrase",
        1547015186000,
      ),
    /endpoint must start/,
  );
});