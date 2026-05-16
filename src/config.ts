/**
 * Runtime configuration — loaded from environment variables at startup.
 * Validated once; any missing required value crashes early with a clear
 * message rather than failing partway through a request.
 */

export interface BigCommerceCredentials {
  /** BigCommerce store hash (the X in api.bigcommerce.com/stores/X/v3/). */
  storeHash: string;
  /** API token — X-Auth-Token header. Get from your BC admin → Settings → API → Store-level API accounts. */
  apiToken: string;
  /** API base URL. Default 'https://api.bigcommerce.com'. */
  apiBase: string;
}

export interface AppConfig {
  /** Per-merchant slug used in xpay-hosted URLs and as the UCP profile identifier. */
  merchantSlug: string;
  /** Public-facing site URL the discovery files describe. Trailing slash recommended. */
  siteUrl: string;
  /** Site display name (used in /llms.txt H1 and agent-card.json). */
  siteName: string;
  /** Optional short description for /llms.txt. */
  siteDescription?: string;
  /** Path the cart-deeplink handler redirects to after pre-filling the cart. Default '/checkout'. */
  checkoutPath: string;

  /** xpay merchant api_key — secret for HS256 cart-deeplink JWTs. Shared with the xpay backend. */
  xpayApiKey: string;

  /** BigCommerce credentials. */
  bc: BigCommerceCredentials;

  /** Bind host + port for the HTTP server. */
  host: string;
  port: number;

  /** Whether to emit /.well-known/oauth-protected-resource. */
  emitOauthProtectedResource: boolean;
  /** Whether to emit /.well-known/agent-card.json (watchlist). */
  emitAgentCard: boolean;
}

function readRequired(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`config: missing required env var ${name}`);
  }
  return v.trim();
}

function readOptional(name: string, defaultValue = ""): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : defaultValue;
}

function readBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function readInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined || !v.trim()) return defaultValue;
  const n = parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : defaultValue;
}

export function loadConfig(): AppConfig {
  return {
    merchantSlug: readRequired("XPAY_MERCHANT_SLUG"),
    siteUrl: ensureTrailingSlash(readRequired("SITE_URL")),
    siteName: readRequired("SITE_NAME"),
    siteDescription: readOptional("SITE_DESCRIPTION") || undefined,
    checkoutPath: readOptional("CHECKOUT_PATH", "/checkout"),

    xpayApiKey: readRequired("XPAY_API_KEY"),

    bc: {
      storeHash: readRequired("BIGCOMMERCE_STORE_HASH"),
      apiToken: readRequired("BIGCOMMERCE_API_TOKEN"),
      apiBase: readOptional("BIGCOMMERCE_API_BASE", "https://api.bigcommerce.com"),
    },

    host: readOptional("HOST", "0.0.0.0"),
    port: readInt("PORT", 8787),

    emitOauthProtectedResource: readBool("EMIT_OAUTH_PROTECTED_RESOURCE", false),
    emitAgentCard: readBool("EMIT_AGENT_CARD", false),
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}
