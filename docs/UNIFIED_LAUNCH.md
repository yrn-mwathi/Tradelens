# TradeLens unified release — Commerce + Intelligence + Fulfillment + International

This release combines the former Phases 3, 4, 5 and 6 into **one coordinated delivery**, with one data model, one administration experience and one release gate. A single release does not mean that unconfigured third-party APIs are live.

## User journey and acceptance criteria

1. **Discover**: Ingest authorized product observations from configured sources. Preserve source, observation timestamp, market and whether each value is reported, estimated or manually entered. Never invent sales, reviews or stock.
2. **Assess**: Rank candidates by demand, growth, competition, supplier evidence, contribution margin and confidence. Display the score inputs and evidence freshness. Incomplete data must be visibly marked.
3. **Verify**: Record supplier identity, supporting documents, shipping quotes and actual sample-test results. Supplier-validated and physically-tested claims require explicit human evidence.
4. **Approve**: Publish only approved, verified product variants to the merchant catalog; prevent duplicate product mappings.
5. **Sell**: Send shoppers to the configured Shopify checkout; support real variant selection and currency display without implying automatic tax or shipping calculations.
6. **Fulfill**: Import paid orders via authenticated webhooks, map Shopify variants to a supported fulfillment provider, create provider orders only with an explicitly enabled credentialed connector, store idempotency keys and synchronize tracking.
7. **Operate internationally**: Validate destination-country availability, shipping quotes, delivery estimates, currency and merchant tax configuration for US and UK before listing products as purchasable.
8. **Support**: Provide order status, refunds/cancellations handoff, support contact and legal policy links.
9. **Deploy**: Configure durable storage, HTTPS, secrets, webhook verification, rate limits, health monitoring and backup/restore.

## Integration strategy

| Provider | Supported integration target | Credential / entitlement gate |
| --- | --- | --- |
| Shopify | Catalog, variants, checkout, paid orders, fulfillment updates | Admin API token, app scopes, webhooks, store |
| CJDropshipping | Catalog, variants, stock, shipping quote, fulfillment, tracking | CJ API account and approved endpoints |
| Printify | POD catalog, orders and fulfillment events | Printify API token and store connection |
| AutoDS | Supplier/catalog/order workflows where officially exposed | API entitlement and supported endpoints |
| DSers | AliExpress order routing through authorized Shopify app | DSers/Shopify app access |
| Zendrop | Shopify supplier fulfillment through supported app | Zendrop/Shopify access |
| Syncee | Authorized supplier catalog/stock via app or documented API | Supplier and app permissions |
| SaleHoo | Supplier research and verified records | Licensed access; do not scrape |
| Dropship.io | Product/competitor research with documented permitted export/API | Explicit data access permission |
| Google Trends | Search-demand signals from authorized sources | Terms-compliant access and provenance |
| AliExpress | Product and supplier signals through approved partner channels | Partner entitlement and allowed scopes |

Do not label app-only connections as direct APIs. A provider without a documented, authorized integration remains a manual/export or Shopify-app handoff.

## Shared data contract

- `products`: canonical identity, title, category, description, brand, approval and publication status.
- `variants`: SKU, attributes, compatibility, source currency, cost, selling price and Shopify variant mapping.
- `supplier_offers`: supplier, provider SKU, stock timestamp, source URL, landed cost and destination-market constraints.
- `market_signals`: metric, value, market, observed time, evidence URL, source type and confidence.
- `shipping_quotes`: provider, variant, destination country, currency, amount, transit window, observed time and expiry.
- `profit_scenarios`: selling price, supplier cost, shipping, advertising, fees, duties, tax assumptions, refund allowance, net profit and margin.
- `orders`, `order_lines`, `fulfillment_attempts`: provider IDs, status, webhook/event deduplication, audit history and tracking.
- `integration_connections`: provider, scopes, credential presence (never secret values), last sync and error state.
- `research_evidence` and `supplier_reviews`: existing evidence ledger retained and linked to candidates.

Migrate existing SQLite tables incrementally and retain all existing approvals, listings, evidence and webhook history. Do not delete or rename tables without a tested migration and rollback.

## Unified delivery sequence within this release

**Gate A — Real commerce:** canonical variants, catalog import, Shopify publishing, authenticated paid-order sync, accurate listing availability, no fake checkout.

**Gate B — Evidence-based AI:** ingest permitted data, explainable score with confidence and staleness, profitability scenarios for US and UK, supplier evidence checks.

**Gate C — Fulfillment:** connect CJ and/or Printify first where credentials are available, enforce stock and shipping gates, create idempotent orders, sync tracking, handle failures and refunds. Add app-only providers through their supported handoffs.

**Gate D — International launch:** currency/tax disclosure, US/UK shipping, storefront policy pages, SEO, mobile accessibility, end-to-end tests, backup, production deployment and monitoring.

## Release definition of done

- No demo/synthetic product presented as an authentic offer.
- No supplier/API data claimed to be live without a successful authorized connection.
- Each order is deduplicated, traceable and cannot be sent twice to fulfillment on webhook retry.
- Shipping costs and delivery claims are grounded in provider quotes or clearly marked estimates.
- Product approvals and supplier verification are auditable.
- Shopify and supplier secrets never reach HTML or logs.
- Tests pass for demo and persistent database modes, with mocked connector tests and at least one credentialed sandbox end-to-end run.
- Public preview URL is verified separately from GitHub CI; production launch requires explicit merchant configuration.
