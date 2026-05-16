/**
 * Thin BigCommerce REST client. Uses raw `fetch` (Node 18+) with the
 * X-Auth-Token header (BigCommerce's token-based auth — simpler than
 * commercetools' OAuth client_credentials).
 *
 * BigCommerce splits its API across two versions: catalog + carts live on v3
 * (`/v3/...`), orders on v2 (`/v2/...`). This client exposes a single
 * `fetchJson(path, init)` that takes a path WITHOUT the version prefix and
 * routes based on the caller — pass `/v3/catalog/products` or
 * `/v2/orders` as appropriate.
 */

import type { BigCommerceCredentials } from "./config";

export class BigCommerceClient {
  private creds: BigCommerceCredentials;

  constructor(creds: BigCommerceCredentials) {
    this.creds = creds;
  }

  /**
   * Fetch a store-scoped API path. Adds X-Auth-Token + content-type. Does
   * NOT retry on 401 (BC tokens don't expire — a 401 means the token is
   * wrong / revoked).
   */
  async fetchJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const url = this.storeUrl(path);
    const headers = new Headers(init.headers || {});
    headers.set("x-auth-token", this.creds.apiToken);
    headers.set("accept", "application/json");
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const resp = await fetch(url, { ...init, headers });

    if (!resp.ok) {
      const body = await safeRead(resp);
      throw new BigCommerceError(`bigcommerce ${resp.status} ${resp.statusText} for ${url}`, resp.status, body);
    }

    if (resp.status === 204) return undefined as unknown as T;
    return (await resp.json()) as T;
  }

  private storeUrl(path: string): string {
    const base = this.creds.apiBase.replace(/\/$/, "");
    const p = path.startsWith("/") ? path : "/" + path;
    return `${base}/stores/${this.creds.storeHash}${p}`;
  }
}

export class BigCommerceError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "BigCommerceError";
    this.status = status;
    this.body = body;
  }
}

async function safeRead(resp: Response): Promise<unknown> {
  try {
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await resp.json();
    return await resp.text();
  } catch {
    return null;
  }
}
