# TradeLens live testing

## Start in Codespaces

Use Node 24 or later. No dependency installation is required.

```bash
npm run setup
npm start
```

`setup` generates a long random administrator password in the ignored `.env` file without displaying it. It never overwrites an existing `.env`. Keep forwarded port 3000 private. Open `/admin/connections` and sign in as `admin` with that password. Set `TRADELENS_ORIGIN` to the exact public HTTPS origin when not running under Codespaces.

For a synthetic preview instead, run `npm run demo`. Demo mode uses an in-memory database and disables all external providers, AI, scheduled provider jobs and email. Demo records reset on restart. Stop the existing server before changing modes.

## Connect accounts securely

Use Codespaces secrets or your host's environment settings. Do not put credentials in an issue, PR or chat. `.env.example` lists the required variable names; `.env` is ignored by Git and Docker.

| Integration | Variables | Permission / account gate |
| --- | --- | --- |
| Shopify | `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET` | A `*.myshopify.com` store, `read_products`, `read_orders`, and `write_products` for draft creation; subscribe the paid-order webhook |
| CJ | `CJ_ACCESS_TOKEN` | Valid CJ API access token; permission for catalog and freight calculation |
| Printify | `PRINTIFY_API_TOKEN` | Authorized merchant token and shop/catalog access |
| Meta ads | `META_ADS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_VERSION` | `ads_read`, account access, account ID `act_...`, and a Graph API version currently supported by the merchant's app |
| AI | `OPENAI_API_KEY`, `TRADELENS_AI_MODEL` | API billing and model access; select an account-supported Responses model |
| Email | `RESEND_API_KEY`, `TRADELENS_ALERT_FROM`, `TRADELENS_ALERT_TO` | Verified sender, single administrator recipient, and sending entitlement |

Restart after changing environment variables. A configured variable does not establish a live connection: run each action and inspect its saved result.

## Test the supported workflow

1. **Connections:** open `/admin/connections`, run configured integrations, and inspect job status. Missing providers must remain unconfigured. Failure must preserve previous snapshots.
2. **Discovery:** open `/admin/discovery`, run CJ discovery, and verify real product IDs/SKUs/prices against CJ. Try duplicate discovery and a token failure. Listed counts mean merchant listings, not consumer orders. Keyword discovery samples up to 250 matching results, not the entire catalog.
3. **Costs:** review a product's exact variant and enter all costs before creating a US/USD research candidate. Confirm it is unapproved. UK/GBP candidates require documented destination-currency costs in Scout; no implicit USD→GBP conversion occurs.
4. **Freight:** enter the matching CJ variant ID and request one-unit quotes for US and GB. Confirm prices remain USD, transit estimates are labeled estimates, and missing taxes remain unknown. These generic country quotes do not include all postcode or customs considerations.
5. **Evidence:** record research and analyst assessments in Scout. Confirm no API or AI action awards a validation badge. Physically Tested must require an explicit human attestation and a completed test date.
6. **Shopify drafts:** approve a reviewed candidate, create a draft in Engine, and inspect its title, price and status in the merchant's Shopify admin. This modifies Shopify and requires the configured `write_products` scope. Publication remains a separate merchant decision.
7. **Sales/refunds:** place a controlled test purchase in Shopify, then sync `/admin/performance`. Shopify test orders are excluded from analytics, so a genuine paid order is needed for a live analytics acceptance test. Test the signed `orders/paid` subscription at `/shopify/webhooks/orders-paid`; duplicate delivery must not duplicate lines. Compare real sales/refunds against Shopify. Net merchandise is already reduced for refunded/removed quantities; do not subtract order refund totals again.
8. **Ads:** sync Meta, map an individual product ad to a candidate, and compare daily spend/currency with Ads Manager. Check unmapped ads and different currencies are excluded from product totals. No ad is created, changed or funded by TradeLens.
9. **Learning:** at 20 fresh matched API orders, compare the store-traction demand component; below the threshold, analyst demand remains. Actual contribution margin uses the separate, source-linked accounting batches after 20 recorded orders. Provider revenue and ad spend alone cannot establish realized profit or store conversion because actual costs and visits are missing. Enter these accounting/traffic records explicitly.
10. **AI:** generate one optional report briefing, confirm source IDs and uncertainty labels, and verify no product is approved or marked physically tested. Each saved report caches one attempt. A failed attempt is retried by generating a new report first.
11. **Alerts:** create a qualifying opportunity or compare two reports with a source-price increase; inspect the in-dashboard alert and configured administrator email. Email acceptance is not proof of inbox delivery. The delivery outbox must retain a provider receipt, preserve the exact retry payload, and stop automatic retries after 23 hours of uncertain outcome.
12. **Scheduling:** set `TRADELENS_AUTOMATION=1` after account tests pass. Set `TRADELENS_AUTO_AI=1` separately to permit scheduled paid AI calls. Keep the host awake; Codespaces shutdown or a sleeping service pauses jobs. Inspect Live connections after restart. One server instance per SQLite database is supported.

## Deployment

The Dockerfile uses Node 24. Mount a durable volume at `/data`, supply a 20+ character `TRADELENS_PASSWORD`, an HTTPS `TRADELENS_ORIGIN` and provider secrets, and route your host's port to port 3000. The container intentionally refuses external binding without a strong password. No production deployment is created by this change.

## Limits and remaining access gates

This release implements CJ V2 discovery/freight, Shopify catalog/draft/paid-webhook/sales snapshots, Meta ad insights, optional OpenAI briefings, persistent jobs, research rankings and Resend alerts. These adapters have contract and HTTP tests; real merchant accounts have not yet been tested.

Google Trends alpha, Dropship.io, Sell The Trend, AutoDS, Zendrop, SaleHoo, Syncee and a direct custom DSers/AliExpress connector are not claimed as implemented APIs. Their authorized access contracts have not been supplied or verified. Use the supported merchant Shopify apps and local mapping/evidence workflows where appropriate. No unattended scraping, invented sales, automatic supplier purchases, full multi-provider fulfillment, or blanket supplier certification is included.

Shopify sync is bounded to 500 orders over 59 days and 100 lines per order, preserving old data when the bound is exceeded. Ads sync is bounded to 2000 daily ad rows over 30 completed requested dates. The ad-account reporting timezone can differ from UTC store windows. Financial values with unsupported precision/currencies are rejected. These limits are visible constraints, not silent partial-data imports.
