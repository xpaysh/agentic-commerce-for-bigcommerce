/**
 * Map BigCommerce native shapes → @xpaysh/adapter-contract value types.
 *
 * BigCommerce's money is decimal strings (e.g. `"19.99"`); the contract uses
 * integer minor units. We convert at the seam. Currency is single-store
 * (set at the storefront level); we read it from `BIGCOMMERCE_DEFAULT_CURRENCY`
 * or per-cart `cart.currency.code`.
 *
 * BigCommerce splits API versions: catalog + carts on v3 (rich objects with
 * `meta` / `data` envelope), orders on v2 (flat objects). Mappers below
 * handle both — `mapV3Product` for catalog, `mapV3Cart` for carts,
 * `mapV2Order` for orders.
 */

import type {
  Product,
  ProductVariant,
  Money,
  Image,
  Cart,
  LineItem,
  Order,
  OrderStatus,
  Address,
} from "@xpaysh/adapter-contract";

// ---------------------------------------------------------------------------
// BigCommerce v3 product shape (subset)
// ---------------------------------------------------------------------------

export interface BcV3Product {
  id: number;
  name: string;
  description?: string;
  sku?: string;
  price?: number;
  retail_price?: number;
  sale_price?: number;
  inventory_level?: number;
  inventory_tracking?: "none" | "product" | "variant";
  is_visible: boolean;
  brand_name?: string;
  custom_url?: { url: string; is_customized: boolean };
  images?: Array<{ url_standard?: string; url_zoom?: string; description?: string }>;
  variants?: BcV3Variant[];
  categories?: number[];
}

export interface BcV3Variant {
  id: number;
  product_id: number;
  sku: string;
  price?: number;
  sale_price?: number;
  inventory_level?: number;
  image_url?: string;
  option_values?: Array<{ option_display_name: string; label: string }>;
}

// ---------------------------------------------------------------------------
// BigCommerce v3 cart shape (subset)
// ---------------------------------------------------------------------------

export interface BcV3Cart {
  id: string;
  customer_id: number;
  channel_id: number;
  email?: string;
  currency: { code: string };
  base_amount: number;
  discount_amount?: number;
  cart_amount: number;
  coupons?: Array<{ code: string; amount: number }>;
  line_items?: {
    physical_items?: BcV3LineItem[];
    digital_items?: BcV3LineItem[];
    gift_certificates?: unknown[];
    custom_items?: unknown[];
  };
  created_time: string;
  updated_time: string;
  redirect_urls?: { cart_url?: string; checkout_url?: string; embedded_checkout_url?: string };
}

export interface BcV3LineItem {
  id: string;
  product_id: number;
  variant_id?: number;
  sku: string;
  name: string;
  quantity: number;
  list_price?: number;
  sale_price?: number;
  extended_list_price?: number;
  extended_sale_price?: number;
  image_url?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// BigCommerce v2 order shape (subset)
// ---------------------------------------------------------------------------

export interface BcV2Order {
  id: number;
  status: string;
  status_id: number;
  date_created: string;
  date_modified?: string;
  customer_id?: number;
  base_handling_cost?: string;
  base_shipping_cost?: string;
  total_inc_tax: string;
  subtotal_inc_tax?: string;
  total_tax?: string;
  currency_code: string;
  payment_status?: string;
  payment_method?: string;
  shipping_addresses?: { url?: string; resource?: string };
  products?: { url?: string; resource?: string };
  // billing_address arrives in the order shape directly:
  billing_address?: BcV2Address;
}

export interface BcV2Address {
  first_name?: string;
  last_name?: string;
  company?: string;
  street_1?: string;
  street_2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  country_iso2?: string;
  email?: string;
  phone?: string;
}

export interface BcV2OrderProduct {
  id: number;
  product_id: number;
  variant_id?: number;
  sku: string;
  name: string;
  quantity: number;
  base_price: string;
  total_inc_tax: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** BigCommerce uses decimal-string money in many places, decimal-number in others. Normalise to minor-unit integers (cents). */
function toMoney(amount: string | number | undefined, currency: string): Money {
  if (amount === undefined || amount === null || amount === "") {
    return { amount: 0, currency };
  }
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return { amount: 0, currency };
  return { amount: Math.round(n * 100), currency };
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

interface BcV3Image { url_standard?: string; url_zoom?: string; description?: string }

export function mapV3Image(im: BcV3Image): Image {
  return {
    url: im.url_standard || im.url_zoom || "",
    alt: im.description,
  };
}

function mapV3Variant(v: BcV3Variant, defaultCurrency: string): ProductVariant {
  const inventory = typeof v.inventory_level === "number" ? v.inventory_level : null;
  const price = v.sale_price || v.price;
  return {
    id: String(v.id),
    sku: v.sku,
    price: price !== undefined ? toMoney(price, defaultCurrency) : undefined,
    images: v.image_url ? [{ url: v.image_url }] : undefined,
    attributes: v.option_values
      ? Object.fromEntries(v.option_values.map((o) => [o.option_display_name, o.label]))
      : undefined,
    inventory,
    inStock: inventory === null || inventory > 0,
  };
}

export function mapV3Product(p: BcV3Product, siteUrl: string, defaultCurrency: string): Product {
  const masterPrice = p.sale_price || p.price;
  const masterVariant: ProductVariant = {
    id: `${p.id}-master`,
    sku: p.sku || `bc-product-${p.id}`,
    price: masterPrice !== undefined ? toMoney(masterPrice, defaultCurrency) : undefined,
    images: p.images?.[0]?.url_standard ? [{ url: p.images[0].url_standard! }] : undefined,
    inventory: p.inventory_level ?? null,
    inStock: p.inventory_level === undefined || p.inventory_level === null || p.inventory_level > 0,
  };
  const variants = Array.isArray(p.variants) && p.variants.length > 0
    ? p.variants.map((v) => mapV3Variant(v, defaultCurrency))
    : [masterVariant];

  const productUrl = p.custom_url?.url
    ? siteUrl.replace(/\/$/, "") + p.custom_url.url
    : undefined;

  return {
    id: String(p.id),
    sku: p.sku || masterVariant.sku,
    name: p.name,
    description: p.description ? stripHtml(p.description) : undefined,
    price: masterVariant.price,
    images: p.images?.map((im) => ({ url: im.url_standard || im.url_zoom || "", alt: im.description })).filter((i) => i.url),
    url: productUrl,
    brand: p.brand_name,
    variants,
  };
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

export function mapV2Address(a?: BcV2Address): Address | undefined {
  if (!a) return undefined;
  return {
    name: [a.first_name, a.last_name].filter(Boolean).join(" ") || undefined,
    company: a.company,
    line1: a.street_1 || "",
    line2: a.street_2,
    city: a.city || "",
    region: a.state,
    postalCode: a.zip || "",
    country: a.country_iso2 || a.country || "",
    phone: a.phone,
    email: a.email,
  };
}

/** Contract-Address → BigCommerce v2 order address. */
export function contractAddressToBc(a: Address): BcV2Address {
  const [firstName, ...rest] = (a.name || "").split(" ");
  return {
    first_name: firstName || undefined,
    last_name: rest.join(" ") || undefined,
    company: a.company,
    street_1: a.line1,
    street_2: a.line2,
    city: a.city,
    state: a.region,
    zip: a.postalCode,
    country_iso2: a.country,
    email: a.email,
    phone: a.phone,
  };
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export function mapV3CartLineItem(li: BcV3LineItem, currency: string): LineItem {
  const unitPrice = toMoney(li.sale_price ?? li.list_price ?? 0, currency);
  const lineTotal = toMoney(li.extended_sale_price ?? li.extended_list_price ?? (unitPrice.amount / 100) * li.quantity, currency);
  return {
    id: li.id,
    productId: String(li.product_id),
    variantId: li.variant_id ? String(li.variant_id) : undefined,
    sku: li.sku,
    name: li.name,
    quantity: li.quantity,
    unitPrice,
    lineTotal,
  };
}

export function mapV3Cart(c: BcV3Cart): Cart {
  const currency = c.currency.code;
  const physicalItems = c.line_items?.physical_items || [];
  const digitalItems = c.line_items?.digital_items || [];
  const items = [...physicalItems, ...digitalItems].map((li) => mapV3CartLineItem(li, currency));
  const subtotal = items.reduce(
    (acc, it) => ({ amount: acc.amount + it.lineTotal.amount, currency }),
    { amount: 0, currency },
  );
  return {
    id: c.id,
    items,
    subtotal,
    discount: c.discount_amount ? toMoney(c.discount_amount, currency) : undefined,
    total: toMoney(c.cart_amount, currency),
    updatedAt: c.updated_time,
    meta: {
      bcChannelId: c.channel_id,
      bcCheckoutUrl: c.redirect_urls?.checkout_url,
    },
  };
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/**
 * Map BigCommerce v2 order `status` string to our OrderStatus enum.
 * BC has ~14 status values; we collapse to the contract's smaller enum.
 * Reference: https://developer.bigcommerce.com/docs/rest-management/orders#order-statuses
 */
export function mapV2OrderStatus(s: string): OrderStatus {
  const lower = (s || "").toLowerCase();
  if (lower === "cancelled" || lower === "declined" || lower === "refunded") {
    return lower === "refunded" ? "refunded" : "cancelled";
  }
  if (lower === "shipped") return "shipped";
  if (lower === "completed") return "delivered";
  if (lower === "awaiting fulfillment" || lower === "awaiting shipment") return "confirmed";
  if (lower === "awaiting payment" || lower === "pending" || lower === "incomplete") return "created";
  if (lower === "partially shipped" || lower === "partially refunded") return "fulfilled";
  return "created";
}

export function mapV2Order(o: BcV2Order, items: LineItem[]): Order {
  const currency = o.currency_code;
  const subtotal = items.reduce(
    (acc, it) => ({ amount: acc.amount + it.lineTotal.amount, currency }),
    { amount: 0, currency },
  );
  return {
    id: String(o.id),
    status: mapV2OrderStatus(o.status),
    items,
    subtotal,
    tax: o.total_tax ? toMoney(o.total_tax, currency) : null,
    total: toMoney(o.total_inc_tax, currency),
    billingAddress: mapV2Address(o.billing_address),
    createdAt: o.date_created,
    updatedAt: o.date_modified,
    paymentStatus: o.payment_status,
    meta: { bcStatusId: o.status_id, bcStatus: o.status, bcPaymentMethod: o.payment_method },
  };
}

export function mapV2OrderProduct(p: BcV2OrderProduct, currency: string): LineItem {
  return {
    id: String(p.id),
    productId: String(p.product_id),
    variantId: p.variant_id ? String(p.variant_id) : undefined,
    sku: p.sku,
    name: p.name,
    quantity: p.quantity,
    unitPrice: toMoney(p.base_price, currency),
    lineTotal: toMoney(p.total_inc_tax, currency),
  };
}
