import type { BigCommerceClient } from "../bc-client";
import type { RouteHandler } from "./types";

export function buildHealthRoute(bc: BigCommerceClient, version: string): RouteHandler {
  return async () => {
    let bcReachable = false;
    let bcError: string | undefined;
    try {
      // Cheap reachability probe — list one product via v3 catalog API.
      await bc.fetchJson("/v3/catalog/products?limit=1");
      bcReachable = true;
    } catch (err) {
      bcError = err instanceof Error ? err.message : String(err);
    }
    return {
      status: bcReachable ? 200 : 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: JSON.stringify({
        ok: bcReachable,
        bigcommerce_reachable: bcReachable,
        bigcommerce_error: bcError,
        version,
        ts: new Date().toISOString(),
      }),
    };
  };
}
