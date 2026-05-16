# Agentic Commerce for BigCommerce

Multi-protocol agentic-commerce layer for [BigCommerce](https://www.bigcommerce.com). Speaks **[ACP](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)**, **[UCP](https://github.com/Universal-Commerce-Protocol/ucp)**, and **[AP2](https://github.com/google-agentic-commerce/AP2)** out of the box, emits real-standard discovery files (`/llms.txt`, schema.org JSON-LD, real-AI-crawler `robots.txt`), and settles through whichever payment integration your BigCommerce store already uses — cards, [Stripe MPP](https://mpp.dev), [x402](https://x402.org), stablecoins.

> Scaffold for the [`agentic-commerce-for-*`](https://github.com/xpaysh?q=agentic-commerce-for-) family. Full implementation lands in coming weeks alongside the [plugin template](https://github.com/xpaysh/agentic-commerce-plugin-template).

## What this gives a BigCommerce merchant

- **Agent-readable storefront** — your existing BigCommerce catalog gets exposed to ChatGPT, Claude, Gemini, and Perplexity via [llms.txt](https://llmstxt.org), schema.org JSON-LD on PDPs and listings, and a `robots.txt` allowlist for real AI crawlers (`GPTBot`, `ClaudeBot`, `Google-Extended`, `PerplexityBot`, `CCBot`, `Amazonbot`).
- **Multi-protocol checkout endpoints** — ACP `POST /checkout_sessions` + `/delegate_payment` backed by BigCommerce Carts and Orders API; UCP REST surface with [RFC 9421](https://datatracker.ietf.org/doc/rfc9421/) signed-request verification; AP2 mandate acceptance for Google Agent Builder flows.
- **No new processor.** Agents settle through whichever payment provider your BigCommerce store already uses (Stripe, Braintree, PayPal, Adyen, …). Optional MPP / x402 / stablecoin rails are configurable add-ons.
- **Cart deeplinks** — JWT-signed (commercial mode) or query-string (standalone) — pre-fill a BigCommerce cart via the Storefront API and redirect the buyer into your existing checkout flow.
- **Two-mode operation** — *standalone* (no xpay backend, discovery + protocol endpoints only) or *commercial* (xpay backend adds catalog hosting, attribution, multi-region analytics).

## Distribution shape

BigCommerce stores don't host arbitrary plugins inside the storefront; this ships as a **hosted [BigCommerce App](https://developer.bigcommerce.com/docs/integrations/apps)** distributed via the [App Marketplace](https://www.bigcommerce.com/apps/), authenticating via OAuth 2.0 with the relevant store-resource scopes (catalog read, carts read/write, orders read).

```
   AI Agent  ───►  agentic-commerce-for-bigcommerce app  ───►  BigCommerce APIs
                  (ACP / UCP / AP2 endpoints,                  (Catalog, Carts,
                   OAuth-scoped per merchant)                   Orders, Webhooks)
                          │
                          └──►  Merchant's existing PSP / payment integration
                                (Stripe, Braintree, PayPal, MPP, x402, …)
```

Real discovery files (`/llms.txt`, schema.org JSON-LD) are emitted by your storefront — via Stencil theme snippets the app installs, or via middleware for headless deployments using BigCommerce as a backend.

## Why BigCommerce after commercetools

The autocomplete probe (2026-05-16) ranked `bigcommerce agentic …` as a strong demand signal — `bigcommerce agentic commerce` is the #1 autocomplete completion, with adjacent stems `bigcommerce ai agent` and `bigcommerce ai chatbot`. BigCommerce's REST + GraphQL APIs are first-class and well-documented, which makes it the cleanest integration after commercetools' headless / JS-native shape established the template's TypeScript scaffolding.

## Status

- 🚧 **Scaffold** — README + LICENSE only. Implementation pending the [plugin template](https://github.com/xpaysh/agentic-commerce-plugin-template) extraction from [`agentic-commerce-for-woocommerce`](https://github.com/xpaysh/agentic-commerce-for-woocommerce).
- Target first usable release: shortly after commercetools' first content drop, reusing the same TypeScript scaffolding.
- Track progress and adjacent platforms in the [awesome-agentic-commerce](https://github.com/xpaysh/awesome-agentic-commerce) registry.

## See also

- [Plugin template](https://github.com/xpaysh/agentic-commerce-plugin-template) — shared TypeScript core
- [awesome-agentic-commerce](https://github.com/xpaysh/awesome-agentic-commerce) — ecosystem registry
- [Agentic Commerce for WooCommerce](https://github.com/xpaysh/agentic-commerce-for-woocommerce) — reference implementation (live, v0.1.7+, GPLv2)
- [Agentic Commerce for commercetools](https://github.com/xpaysh/agentic-commerce-for-commercetools) — sibling scaffold
- [ACP vs UCP vs AP2 — Technical Comparison](https://docs.xpay.sh/agentic-commerce-protocols/comparison)
- [Agentic commerce roadmap on docs.xpay.sh](https://docs.xpay.sh/merchants/agentic-commerce)
- [BigCommerce Dev Docs](https://developer.bigcommerce.com/) · [App Marketplace](https://www.bigcommerce.com/apps/)

## License

Apache-2.0.
