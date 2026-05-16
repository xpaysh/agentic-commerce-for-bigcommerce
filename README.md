# Agentic Commerce for BigCommerce

Service that exposes a [BigCommerce](https://www.bigcommerce.com) store to AI shopping agents — `/llms.txt`, `/.well-known/ucp` (UCP business profile), schema.org JSON-LD on PDPs (via API), signed-JWT cart deeplinks, and a **full ACP/UCP/AP2 REST endpoint stack** on top of the BigCommerce Stores API.

**Status**: v0.1.0 — full multi-protocol implementation from day one (mirrors [`xpaysh/agentic-commerce-for-commercetools`](https://github.com/xpaysh/agentic-commerce-for-commercetools) v0.2 shape). Apache-2.0.

## Architecture

```
   AI Agent (ChatGPT, Claude, Gemini, …)
         │
         │   ACP / UCP / AP2 / cart-deeplink request
         ▼
   ┌─────────────────────────────────────────┐
   │ agentic-commerce-for-bigcommerce        │
   │  - Discovery routes                     │
   │  - Cart-deeplink verifier               │
   │  - ACP / UCP / AP2 endpoints            │
   │  - BigCommerceAdapter implements        │
   │    @xpaysh/adapter-contract             │
   └──────────────────┬──────────────────────┘
                      │   X-Auth-Token
                      ▼
   ┌─────────────────────────────────────────┐
   │ BigCommerce Stores API                  │
   │  v3: catalog + carts                    │
   │  v2: orders                             │
   └──────────────────┬──────────────────────┘
                      │   merchant's existing payment integration
                      ▼
   Stripe / Square / PayPal / Adyen / Braintree / etc.
```

Standalone Node service. Same code can run as a Docker container, AWS Lambda (HTTP API v2), Vercel function, Cloud Run, or bare VPS.

## Surface

### Discovery layer

| Method | Path | Notes |
|---|---|---|
| GET | `/llms.txt` | llmstxt.org Markdown menu |
| GET | `/.well-known/ucp` | UCP business profile (Google + Shopify + Etsy + Wayfair + Target + Walmart fetch this) |
| GET | `/robots.txt` | AI-crawler allow blocks (template) |
| GET | `/.well-known/agent-card.json` | A2A 1.0; opt-in via `EMIT_AGENT_CARD=1` |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728; opt-in via `EMIT_OAUTH_PROTECTED_RESOURCE=1` |
| GET | `/api/v1/jsonld/product/:id[?slim=1]` | schema.org Product JSON-LD; storefront embeds in PDP HTML |
| GET | `/cart/deeplink?token=<jwt>` | redeem cart-deeplink → BC cart → 302 to checkout |
| GET | `/healthz` | liveness + BC API reachability |

### UCP — Universal Commerce Protocol

| Method | Path |
|---|---|
| GET | `/api/ucp/v1/catalog/search?q=&sku=&limit=&cursor=&sort=` |
| GET | `/api/ucp/v1/catalog/products/:id` |
| POST | `/api/ucp/v1/carts` |
| GET | `/api/ucp/v1/carts/:id` |
| PATCH | `/api/ucp/v1/carts/:id` |
| POST | `/api/ucp/v1/checkout` |
| GET | `/api/ucp/v1/orders/:id` |

### ACP — Agentic Commerce Protocol

| Method | Path |
|---|---|
| POST | `/api/acp/v1/checkout_sessions` |
| GET | `/api/acp/v1/checkout_sessions/:id` |
| POST | `/api/acp/v1/checkout_sessions/:id` |
| POST | `/api/acp/v1/checkout_sessions/:id/complete` |
| GET | `/api/acp/v1/orders/:id` |

Sessions are in-memory in v0.1; DDB-backed in v0.2.

### AP2 — Agent Payments Protocol

| Method | Path |
|---|---|
| POST | `/api/ap2/v1/mandates/verify` |
| POST | `/api/ap2/v1/checkout` |

Mandate verification is structural + audience + expiry only in v0.1 (`signature_verified: false`, `signature_verification_status: "deferred_to_v0.3"`). Issuer-key fetching + VC verification land with the broader Credential Provider work.

## Adapter capabilities (v0.1)

`{cart: true, checkout: true, catalogSearch: true, catalogLookup: true, order: true, refunds: false, disputes: false, inventoryRealtime: true, webhooks: false}`

`refundOrder` / `openDispute` not implemented; BigCommerce webhook subscriptions land in v0.2 (`webhooks: true`).

## Quickstart

### 1. Get credentials

- **BigCommerce**: BC admin → Settings → API → Store-level API accounts → Create. v0.1 scopes: **Products READ, Carts MODIFY, Orders MODIFY, Information READ**. Copy the X-Auth-Token + the store hash.
- **xpay**: merchant slug + api_key at [`app.xpay.sh/onboard/bigcommerce`](https://app.xpay.sh/onboard/bigcommerce), or mint your own in standalone mode.

### 2. Configure

```bash
git clone https://github.com/xpaysh/agentic-commerce-for-bigcommerce.git
cd agentic-commerce-for-bigcommerce
cp .env.example .env
# Edit .env with your store hash + token
```

### 3. Run (Docker)

```bash
docker compose -f examples/docker-compose.yml up --build
curl -sS http://localhost:8787/healthz | jq .
```

### 3-alt. Run (Node)

```bash
npm install
npm run build
node dist/server.js
```

### 4. Wire the storefront

For BigCommerce, the agentic-commerce service typically lives on a sub-domain (`agentic.merchant.example/`). Add reverse-proxy rules in your CDN (Cloudflare, Fastly) or storefront config:

```
/llms.txt                                  → agentic.merchant.example/llms.txt
/.well-known/ucp                           → agentic.merchant.example/.well-known/ucp
/.well-known/oauth-protected-resource      → agentic.merchant.example/.well-known/oauth-protected-resource   (if enabled)
/.well-known/agent-card.json               → agentic.merchant.example/.well-known/agent-card.json            (if enabled)
/cart/deeplink                             → agentic.merchant.example/cart/deeplink
/api/acp/v1/*                              → agentic.merchant.example/api/acp/v1/*
/api/ucp/v1/*                              → agentic.merchant.example/api/ucp/v1/*
/api/ap2/v1/*                              → agentic.merchant.example/api/ap2/v1/*
```

For PDP JSON-LD:

```ts
const ld = await fetch(`https://agentic.merchant.example/api/v1/jsonld/product/${productId}`).then(r => r.json());
// embed: <script type="application/ld+json">{JSON.stringify(ld)}</script>
```

For `robots.txt`, merge the AI-allow blocks from `GET /robots.txt` into your storefront's existing robots.txt.

### 5. Smoke-test the deeplink flow

```bash
node -e "
const { signCartDeeplink } = require('@xpaysh/cart-deeplinks');
const { token } = signCartDeeplink({
  merchant: process.env.XPAY_MERCHANT_SLUG,
  items: [{ sku: 'SOME-SKU-IN-YOUR-CATALOG', qty: 1 }],
  ttlSeconds: 300,
  apiKey: process.env.XPAY_API_KEY,
});
console.log('https://merchant.example/cart/deeplink?token=' + token);
"
```

Open the URL — you should land on the merchant's BC checkout with the cart pre-filled.

## Environment

| Var | Required | Notes |
|---|---|---|
| `XPAY_MERCHANT_SLUG` | ✅ | Per-merchant identifier |
| `SITE_URL` | ✅ | Public site URL the discovery files describe |
| `SITE_NAME` | ✅ | Display name (used in `/llms.txt` H1) |
| `XPAY_API_KEY` | ✅ | Shared HS256 secret for cart-deeplink JWTs |
| `BIGCOMMERCE_STORE_HASH` | ✅ | Hash in `api.bigcommerce.com/stores/<HASH>/v3/` |
| `BIGCOMMERCE_API_TOKEN` | ✅ | X-Auth-Token from BC admin |
| `BIGCOMMERCE_API_BASE` | | Default `https://api.bigcommerce.com` |
| `SITE_DESCRIPTION` | | One-line description for `/llms.txt` |
| `CHECKOUT_PATH` | | Default `/checkout` |
| `HOST` / `PORT` | | Default `0.0.0.0` / `8787` |
| `EMIT_OAUTH_PROTECTED_RESOURCE` | | `1` to emit |
| `EMIT_AGENT_CARD` | | `1` to emit (A2A watchlist) |

## BigCommerce API quirks worth knowing

- **Catalog + carts on v3** with `{data, meta}` envelope; **orders on v2** with flat objects + sub-resources. Adapter handles both.
- **Auth is X-Auth-Token**, not OAuth. Simpler than commercetools but BC tokens are forever-valid; rotate manually via BC admin.
- **Money is decimal strings** ("19.99") in most places, integers in v3 carts. Adapter normalises to integer minor units (cents) at the contract boundary.
- **Cart → order is a two-step flow**: adapter creates a v2 order with `status_id: 11` (Awaiting Payment) carrying cart line items + addresses, then deletes the v3 cart. Buyers complete payment via the storefront's existing PSP. v0.2+ adds direct delegated-payment capture for the CP role.
- **No cart versioning** — unlike commercetools' optimistic concurrency, BC carts mutate in place. Adapter dispatches add/remove/update line items via separate v3 endpoints.

## Library usage (embed in your own Node app)

```ts
import { BigCommerceAdapter, BigCommerceClient, loadConfig } from 'agentic-commerce-for-bigcommerce';

const config = loadConfig();
const bc = new BigCommerceClient(config.bc);
const adapter = new BigCommerceAdapter({ bc, siteUrl: config.siteUrl });

const product = await adapter.getProduct('123');
const cart = await adapter.createCart({ items: [{ sku: 'SKU-1', quantity: 1 }] });
```

`BigCommerceAdapter` implements `@xpaysh/adapter-contract`'s `PlatformAdapter`, so any code written against the interface (hosted backend, audit's commerce checks, sibling-plugin orchestration) accepts this adapter unchanged.

## Family packages this service uses

| npm package | Role |
|---|---|
| [`@xpaysh/adapter-contract`](https://www.npmjs.com/package/@xpaysh/adapter-contract) | `PlatformAdapter` interface |
| [`@xpaysh/discovery`](https://www.npmjs.com/package/@xpaysh/discovery) | discovery-file generators |
| [`@xpaysh/ucp-schemas`](https://www.npmjs.com/package/@xpaysh/ucp-schemas) | UCP profile generator + `sh.xpay` namespace |
| [`@xpaysh/cart-deeplinks`](https://www.npmjs.com/package/@xpaysh/cart-deeplinks) | HS256 cart-handoff JWT verifier |

## Verifying agent-readiness

```bash
npx @xpaysh/storefront-audit https://store.merchant.example/
# Or browse to https://audit.xpay.sh/?url=https://store.merchant.example/
```

## What's intentionally **not** here in v0.1

- **ACP `POST /delegate_payment`** — CP role; v0.2
- **AP2 mandate signature verification** — structural checks pass; issuer-key fetching deferred to v0.3
- **UCP RFC 9421 request-signature verification** — middleware skeleton; off by default in v0.1; on in v0.3
- **Refunds + disputes** — `capabilities.{refunds,disputes} = false`. v0.3
- **Webhooks for order state changes** — BC webhook subscriptions for `store/order/created`, `store/order/statusUpdated`. v0.2
- **Persistent ACP session storage** — in-memory in v0.1; moves to DynamoDB in v0.2

## See also

- [`xpaysh/agentic-commerce-for-commercetools`](https://github.com/xpaysh/agentic-commerce-for-commercetools) — sibling repo, same shape. commercetools-specific differences (OAuth, LocalizedString, decimal-integer money) live in `src/ct-client.ts` / `src/adapter.ts` / `src/mappers.ts`. The route files (`src/routes/*`), `src/server.ts`, `src/config.ts` are essentially copy-paste between siblings.
- [`xpaysh/agentic-commerce-for-woocommerce`](https://github.com/xpaysh/agentic-commerce-for-woocommerce) — PHP reference; same wire format
- [Plugin template + family monorepo](https://github.com/xpaysh/agentic-commerce-plugin-template)
- [docs.xpay.sh — ACP vs UCP vs AP2](https://docs.xpay.sh/agentic-commerce-protocols/comparison)
- [BigCommerce Stores API reference](https://developer.bigcommerce.com/docs/rest-management)

## License

Apache-2.0.
