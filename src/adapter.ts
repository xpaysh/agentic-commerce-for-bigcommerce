/**
 * BigCommerceAdapter — implements @xpaysh/adapter-contract's PlatformAdapter
 * against the BigCommerce Stores API.
 *
 * BigCommerce API quirks worth knowing:
 *   - Catalog + carts use v3 (envelope: `{data, meta}`).
 *   - Orders use v2 (flat objects, separate `products` sub-resource).
 *   - Auth is X-Auth-Token header — no OAuth.
 *   - Money is decimal strings ("19.99") in most places; integer in v3 cart.
 *   - Carts don't have "version" optimistic-concurrency control (unlike CT).
 *   - Cart-to-order is a two-step flow: convert cart via /v2/orders (status_id 11
 *     = Awaiting Payment), then storefront completes payment via existing PSP.
 */

import type {
  PlatformAdapter,
  AdapterCapabilities,
  Product,
  ProductQuery,
  Paginated,
  ProductId,
  CartId,
  Cart,
  CreateCartInput,
  CartMutation,
  CompleteCheckoutInput,
  Order,
  OrderId,
  OrderQuery,
  RefundResult,
  DisputeHandle,
  Money,
  LineItem,
} from "@xpaysh/adapter-contract";

import { BigCommerceClient } from "./bc-client";
import {
  mapV3Product,
  mapV3Cart,
  mapV2Order,
  mapV2OrderProduct,
  contractAddressToBc,
  type BcV3Product,
  type BcV3Cart,
  type BcV2Order,
  type BcV2OrderProduct,
} from "./mappers";

export interface BigCommerceAdapterOptions {
  bc: BigCommerceClient;
  siteUrl: string;
  /** Currency for cart/order pricing when not surfaced by BC. Default 'USD'. */
  defaultCurrency?: string;
}

export class BigCommerceAdapter implements PlatformAdapter {
  readonly platformName = "bigcommerce";

  readonly capabilities: AdapterCapabilities = {
    cart: true,
    checkout: true,
    catalogSearch: true,
    catalogLookup: true,
    order: true,
    refunds: false,    // v0.3
    disputes: false,   // v0.3
    inventoryRealtime: true,
    webhooks: false,   // v0.3 — BC webhooks subscription
    extras: {},
  };

  private bc: BigCommerceClient;
  private siteUrl: string;
  private defaultCurrency: string;

  constructor(opts: BigCommerceAdapterOptions) {
    this.bc = opts.bc;
    this.siteUrl = opts.siteUrl.endsWith("/") ? opts.siteUrl : opts.siteUrl + "/";
    this.defaultCurrency = opts.defaultCurrency || "USD";
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async listProducts(query: ProductQuery): Promise<Paginated<Product>> {
    const params = new URLSearchParams();
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 50) : 20;
    params.set("limit", String(limit));
    params.set("include", "images,variants");
    params.set("is_visible", "true");
    if (query.cursor) {
      const page = parseInt(query.cursor, 10);
      if (Number.isFinite(page) && page > 0) params.set("page", String(page));
    } else {
      params.set("page", "1");
    }
    if (query.q) params.set("keyword", query.q);
    if (query.sku) params.set("sku", query.sku);
    if (query.category && /^\d+$/.test(query.category)) params.set("categories:in", query.category);
    if (query.sort === "price_asc") params.set("sort", "price");
    else if (query.sort === "price_desc") params.set("sort", "-price");
    else if (query.sort === "newest") params.set("sort", "-date_created");

    const res = await this.bc.fetchJson<{
      data: BcV3Product[];
      meta: { pagination: { total: number; count: number; current_page: number; total_pages: number } };
    }>(`/v3/catalog/products?${params.toString()}`);

    const items = res.data.map((p) => mapV3Product(p, this.siteUrl, this.defaultCurrency));
    const { current_page, total_pages, total } = res.meta.pagination;
    const nextCursor = current_page < total_pages ? String(current_page + 1) : null;
    return { items, nextCursor, total };
  }

  async getProduct(id: ProductId): Promise<Product | null> {
    try {
      const res = await this.bc.fetchJson<{ data: BcV3Product }>(
        `/v3/catalog/products/${encodeURIComponent(id)}?include=images,variants`,
      );
      return mapV3Product(res.data, this.siteUrl, this.defaultCurrency);
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Cart
  // -------------------------------------------------------------------------

  async createCart(input: CreateCartInput): Promise<Cart> {
    // BigCommerce requires productId + variantId for cart line items, not SKU
    // alone. Resolve each SKU → (productId, variantId) before creating.
    const resolvedLineItems = await Promise.all(
      input.items.map(async (it) => {
        const resolved = await this.resolveSkuToProductVariant(it.sku);
        if (!resolved) return null;
        return {
          product_id: resolved.productId,
          variant_id: resolved.variantId,
          quantity: it.quantity,
        };
      }),
    );
    const valid = resolvedLineItems.filter((x): x is NonNullable<typeof x> => x !== null);
    if (valid.length === 0) {
      throw new Error("createCart: no items resolved to BigCommerce products (check SKUs)");
    }

    const body = {
      line_items: valid,
      channel_id: 1,
      ...(input.externalId ? { external_id: input.externalId } : {}),
    };

    const res = await this.bc.fetchJson<{ data: BcV3Cart }>("/v3/carts?include=line_items.physical_items,redirect_urls", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mapV3Cart(res.data);
  }

  async getCart(id: CartId): Promise<Cart | null> {
    try {
      const res = await this.bc.fetchJson<{ data: BcV3Cart }>(
        `/v3/carts/${encodeURIComponent(id)}?include=line_items.physical_items,redirect_urls`,
      );
      return mapV3Cart(res.data);
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  async updateCart(id: CartId, mutation: CartMutation): Promise<Cart> {
    // BigCommerce cart mutations are itemised: separate calls for add, remove,
    // and update-quantity per line. We fetch the current cart to know the
    // existing line-item ids, then dispatch the needed ops.
    const current = await this.bc.fetchJson<{ data: BcV3Cart }>(
      `/v3/carts/${encodeURIComponent(id)}?include=line_items.physical_items,redirect_urls`,
    );
    const cart = current.data;
    const existingBySku = new Map<string, { id: string; quantity: number }>();
    for (const li of cart.line_items?.physical_items || []) {
      existingBySku.set(li.sku, { id: li.id, quantity: li.quantity });
    }

    // setItems: upsert semantics (treat input as target quantities).
    if (Array.isArray(mutation.setItems)) {
      const targetBySku = new Map(mutation.setItems.map((it) => [it.sku, it]));

      // Remove items in existing but not in target.
      for (const [sku, ex] of existingBySku.entries()) {
        if (!targetBySku.has(sku)) {
          await this.bc.fetchJson(`/v3/carts/${encodeURIComponent(id)}/items/${ex.id}`, { method: "DELETE" });
        }
      }

      // Add or update items in target.
      const toAdd: Array<{ product_id: string; variant_id: string; quantity: number }> = [];
      for (const it of mutation.setItems) {
        const ex = existingBySku.get(it.sku);
        if (ex) {
          if (ex.quantity !== it.quantity) {
            const resolved = await this.resolveSkuToProductVariant(it.sku);
            if (!resolved) continue;
            await this.bc.fetchJson(`/v3/carts/${encodeURIComponent(id)}/items/${ex.id}`, {
              method: "PUT",
              body: JSON.stringify({
                line_item: { product_id: resolved.productId, variant_id: resolved.variantId, quantity: it.quantity },
              }),
            });
          }
        } else {
          const resolved = await this.resolveSkuToProductVariant(it.sku);
          if (resolved) {
            toAdd.push({ product_id: String(resolved.productId), variant_id: String(resolved.variantId), quantity: it.quantity });
          }
        }
      }

      if (toAdd.length > 0) {
        await this.bc.fetchJson(`/v3/carts/${encodeURIComponent(id)}/items`, {
          method: "POST",
          body: JSON.stringify({ line_items: toAdd.map((it) => ({ ...it, product_id: Number(it.product_id), variant_id: Number(it.variant_id) })) }),
        });
      }
    }

    if (Array.isArray(mutation.removeSkus) && mutation.removeSkus.length > 0) {
      const skuSet = new Set(mutation.removeSkus);
      for (const li of cart.line_items?.physical_items || []) {
        if (skuSet.has(li.sku)) {
          await this.bc.fetchJson(`/v3/carts/${encodeURIComponent(id)}/items/${li.id}`, { method: "DELETE" });
        }
      }
    }

    // BC doesn't store shipping/billing addresses on the cart resource directly
    // — they're applied at checkout creation. Note this as a no-op in v0.1
    // and surface via /v3/checkouts/{cartId}/billing-address etc. in v0.2.
    // For now we silently ignore address mutations on the cart and apply them
    // at completeCheckout.

    if (typeof mutation.discountCode === "string" && mutation.discountCode) {
      await this.bc.fetchJson(`/v3/carts/${encodeURIComponent(id)}/coupons`, {
        method: "POST",
        body: JSON.stringify({ coupon_codes: [mutation.discountCode] }),
      });
    }

    // Re-fetch to return the updated state.
    const refreshed = await this.bc.fetchJson<{ data: BcV3Cart }>(
      `/v3/carts/${encodeURIComponent(id)}?include=line_items.physical_items,redirect_urls`,
    );
    return mapV3Cart(refreshed.data);
  }

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  /**
   * BigCommerce cart-to-order. Creates a v2 order in "Awaiting Payment" state
   * (status_id 11) carrying the cart's items + the supplied addresses. Payment
   * runs through the merchant's existing PSP via the storefront checkout flow;
   * v0.3 will wire delegated-payment capture for the CP role.
   *
   * The `payment` field on CompleteCheckoutInput is accepted but only used to
   * tag order meta — actual capture still happens server-side via the BC
   * payment-method integration.
   */
  async completeCheckout(input: CompleteCheckoutInput): Promise<Order> {
    const cart = await this.bc.fetchJson<{ data: BcV3Cart }>(
      `/v3/carts/${encodeURIComponent(input.cartId)}?include=line_items.physical_items`,
    );
    const physicalItems = cart.data.line_items?.physical_items || [];
    if (physicalItems.length === 0) {
      throw new Error(`completeCheckout: cart ${input.cartId} has no items`);
    }

    if (!input.shippingAddress && !input.billingAddress) {
      throw new Error("completeCheckout: at least one of shippingAddress / billingAddress is required");
    }

    const billing = input.billingAddress || input.shippingAddress!;
    const shipping = input.shippingAddress || input.billingAddress!;

    const orderBody = {
      status_id: 11, // Awaiting Payment
      billing_address: contractAddressToBc(billing),
      shipping_addresses: [contractAddressToBc(shipping)],
      products: physicalItems.map((li) => ({
        product_id: li.product_id,
        variant_id: li.variant_id,
        quantity: li.quantity,
      })),
    };

    const order = await this.bc.fetchJson<BcV2Order>("/v2/orders", {
      method: "POST",
      body: JSON.stringify(orderBody),
    });

    // Pull the order's product line items (v2 splits these into a sub-resource).
    const orderProducts = await this.bc.fetchJson<BcV2OrderProduct[]>(`/v2/orders/${order.id}/products`).catch(() => [] as BcV2OrderProduct[]);
    const items = orderProducts.map((p) => mapV2OrderProduct(p, order.currency_code));

    // Mark the cart as ordered (BC auto-handles this when the order is paid;
    // for clean state we delete the v3 cart here).
    await this.bc.fetchJson(`/v3/carts/${encodeURIComponent(input.cartId)}`, { method: "DELETE" }).catch(() => undefined);

    return mapV2Order(order, items);
  }

  // -------------------------------------------------------------------------
  // Order
  // -------------------------------------------------------------------------

  async getOrder(id: OrderId): Promise<Order | null> {
    try {
      const order = await this.bc.fetchJson<BcV2Order>(`/v2/orders/${encodeURIComponent(id)}`);
      const orderProducts = await this.bc.fetchJson<BcV2OrderProduct[]>(`/v2/orders/${id}/products`).catch(() => [] as BcV2OrderProduct[]);
      const items = orderProducts.map((p) => mapV2OrderProduct(p, order.currency_code));
      return mapV2Order(order, items);
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  async listOrders(query: OrderQuery): Promise<Paginated<Order>> {
    const params = new URLSearchParams();
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 50) : 20;
    params.set("limit", String(limit));
    if (query.cursor) {
      const page = parseInt(query.cursor, 10);
      if (Number.isFinite(page) && page > 0) params.set("page", String(page));
    } else {
      params.set("page", "1");
    }
    if (query.createdAfter) params.set("min_date_created", query.createdAfter);
    if (query.createdBefore) params.set("max_date_created", query.createdBefore);
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      const statusIds = statuses.map((s) => this.contractStatusToBcStatusId(s)).filter((x): x is number => x !== undefined);
      if (statusIds.length === 1) params.set("status_id", String(statusIds[0]));
      // BC v2 doesn't accept multi-status in one query; we'd have to fan out.
    }
    params.set("sort", "id:desc");

    const orders = await this.bc.fetchJson<BcV2Order[]>(`/v2/orders?${params.toString()}`).catch(() => [] as BcV2Order[]);
    const items: Order[] = await Promise.all(
      orders.map(async (o) => {
        const prods = await this.bc.fetchJson<BcV2OrderProduct[]>(`/v2/orders/${o.id}/products`).catch(() => [] as BcV2OrderProduct[]);
        const lineItems = prods.map((p) => mapV2OrderProduct(p, o.currency_code));
        return mapV2Order(o, lineItems);
      }),
    );

    const nextCursor = orders.length === limit ? String(parseInt(params.get("page") || "1", 10) + 1) : null;
    return { items, nextCursor };
  }

  refundOrder?(_id: OrderId, _amount?: Money): Promise<RefundResult> {
    throw new NotImplementedError("refundOrder is not declared in v0.1 capabilities.");
  }
  openDispute?(_id: OrderId, _reason: string): Promise<DisputeHandle> {
    throw new NotImplementedError("openDispute is not declared in v0.1 capabilities.");
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Resolve a SKU to (productId, variantId) for cart line items. */
  private async resolveSkuToProductVariant(sku: string): Promise<{ productId: number; variantId: number } | null> {
    // v3 catalog supports SKU filtering directly on products.
    const params = new URLSearchParams({ sku, include: "variants", limit: "1" });
    const res = await this.bc.fetchJson<{ data: BcV3Product[] }>(`/v3/catalog/products?${params.toString()}`);
    const p = res.data[0];
    if (!p) {
      // Try variant SKU lookup (when the master product SKU differs from variant SKUs)
      const variants = await this.bc.fetchJson<{ data: Array<{ id: number; product_id: number; sku: string }> }>(
        `/v3/catalog/variants?sku=${encodeURIComponent(sku)}&limit=1`,
      ).catch(() => ({ data: [] as Array<{ id: number; product_id: number; sku: string }> }));
      const v = variants.data[0];
      if (v) return { productId: v.product_id, variantId: v.id };
      return null;
    }
    if (p.sku === sku) {
      // Need a variant id even for master SKU — BC's first variant is the default.
      const variantId = p.variants?.[0]?.id ?? p.id;
      return { productId: p.id, variantId };
    }
    const v = p.variants?.find((vv) => vv.sku === sku);
    if (v) return { productId: p.id, variantId: v.id };
    return null;
  }

  private contractStatusToBcStatusId(s: import("@xpaysh/adapter-contract").OrderStatus): number | undefined {
    // BigCommerce order status id mapping (subset). Reference:
    // https://developer.bigcommerce.com/docs/rest-management/orders#order-statuses
    switch (s) {
      case "created":   return 11; // Awaiting Payment
      case "confirmed": return 7;  // Awaiting Fulfillment
      case "processing": return 9; // Awaiting Pickup
      case "fulfilled": return 3;  // Partially Shipped (closest in v2)
      case "shipped":   return 2;  // Shipped
      case "delivered": return 10; // Completed
      case "cancelled": return 5;  // Cancelled
      case "refunded":  return 4;  // Refunded
      default:          return undefined;
    }
  }

  private isNotFound(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const status = (err as { status?: number }).status;
    return status === 404;
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
