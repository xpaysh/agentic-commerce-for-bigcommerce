/**
 * BigCommerce Webhooks → normalized OrderStateChanged events.
 *
 * Spec:
 *   https://developer.bigcommerce.com/docs/integrations/webhooks
 *
 * BigCommerce signs webhooks with an HMAC-SHA256 in `X-Hub-Signature-256`
 * when a `headers.client_secret` is set at subscription-create time
 * (v3 webhooks API). For v0.2.3 we use the shared-secret header
 * `X-Xpay-Webhook-Secret` provided as a custom header at subscription-create
 * time; v0.3 will switch to native HMAC verification.
 *
 * Scopes covered:
 *   store/order/created     → order.created
 *   store/order/updated     → order.updated
 *   store/order/refund/created → order.refunded
 *
 * Payload (typical):
 *   {
 *     scope: "store/order/created",
 *     store_id: "123",
 *     data: { type: "order", id: 1042 },
 *     hash, created_at, producer
 *   }
 */

import { RouteTable } from "./match";
import type { RouteHandler, RouteResponse } from "./types";
import { getOrderEventEmitter, type OrderEventTopic, type OrderStateChanged } from "../events";

const SCOPE_TO_TOPIC: Record<string, OrderEventTopic | undefined> = {
  "store/order/created": "order.created",
  "store/order/updated": "order.updated",
  "store/order/fulfilled": "order.fulfilled",
  "store/order/cancelled": "order.cancelled",
  "store/order/refund/created": "order.refunded",
};

export function buildWebhookRouteTable(): RouteTable<RouteHandler> {
  const table = new RouteTable<RouteHandler>();
  table.add("POST", "/webhooks/bigcommerce", buildBigCommerceWebhookRoute());
  return table;
}

export function buildBigCommerceWebhookRoute(): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const secret = process.env.XPAY_WEBHOOK_SHARED_SECRET || "";
    if (!secret) {
      return jsonError(503, "webhook_secret_unconfigured", "XPAY_WEBHOOK_SHARED_SECRET env required");
    }
    if (headerOf(req.headers, "x-xpay-webhook-secret") !== secret) {
      return jsonError(401, "invalid_signature", "shared-secret mismatch");
    }

    let payload: { scope?: string; store_id?: string; data?: { id?: number | string; type?: string } } & Record<string, unknown>;
    try {
      payload = JSON.parse(req.body || "{}");
    } catch {
      return jsonError(400, "invalid_json", "webhook body is not valid JSON");
    }

    const mapped = payload.scope ? SCOPE_TO_TOPIC[payload.scope] : undefined;
    if (!mapped) return { status: 204, headers: {}, body: "" };
    if (payload.data?.type !== "order") return { status: 204, headers: {}, body: "" };

    const id = payload.data?.id;
    const orderId = typeof id === "number" ? String(id) : id;
    if (!orderId) return jsonError(400, "missing_order_id", "data.id required");

    const event: OrderStateChanged = {
      source: "bigcommerce",
      topic: mapped,
      orderId,
      platformShop: payload.store_id ? `store-${payload.store_id}` : undefined,
      occurredAt: new Date().toISOString(),
      payload,
    };
    await getOrderEventEmitter().emit(event);
    return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ ok: true }) };
  };
}

function headerOf(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function jsonError(status: number, code: string, message: string): RouteResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: { code, message } }),
  };
}
