# Product Intelligence implementation and activation

Implemented 5 November 2026 against the existing TradeLens application. Existing storefront, manual approval, Shopify draft creation and supplier workflows are retained.

## Available now

- `/admin/intelligence`: persisted top-20 eligible US/UK recommendation report, with fewer results when evidence is missing.
- Scheduled daily local report calculation, plus an authenticated manual refresh. Reports use current local data; they do not silently call suppliers or scrape websites.
- Traceable, timestamped manual source observations: relative search interest, supplier unit price, observed order volume, review rating and competition counts. Provenance is always labeled manual; source entry is not independent verification. Only relative search interest and supplier price observations currently trigger change alerts; other metrics support research review.
- Explicit 0–100 rules-based ranking: demand 30%, supplier reliability 20%, low competition 15%, growth 10%, contribution margin 25%. Analyst inputs expire after 30 days; a 40% contribution margin saturates the profitability component. A high score does not constitute market validation.
- Estimated contribution includes candidate supplier, shipping, merchant tax/duties, transaction fees, advertising and refund assumptions. It is not a promised net profit, automatic tax determination or FX conversion. Entered selling price is shown, not an AI-generated optimal price.
- Source-linked aggregate store/ad performance batches with duplicate/overlap protection and currency validation. Inputs remain manually reported. At 20 recorded orders in periods ending within the preceding 90 days, recorded contribution margin replaces assumed margin. The window includes whole batches by end date; it does not prorate batches. Twenty orders is a configurable-in-code heuristic, not a statistical validation guarantee. Conversion, CAC and realized contribution are displayed. Nonpositive estimated or learned contribution excludes a candidate.
- Persistent in-dashboard opportunity, demand increase (>20%), supplier price increase, assumed profit decline and realized-loss alerts. Duplicate identical messages are suppressed. Alerts need a previous report for comparisons. Supplier observations do not overwrite the pricing assumptions, since quotes can use different variants/destinations. Email/SMS/push delivery remains unconfigured.
- Optional, manually triggered OpenAI briefing based only on saved report data. No research tools or browsing are granted. Text is unverified, escaped in HTML and unable to alter approvals, scores or physical-test badges. API errors do not break the deterministic report. One attempt per report avoids repeated charges; a failed attempt can be retried after a new report. Live API access has not been tested; mocked contract tests cover success/failure and caching.
- Existing validation badges remain manual: Market Validated, Supplier Validated, Physically Tested. Only a named human reviewer can record physical testing through the existing form. No observation or AI output automatically assigns badges.

## Authorized integration gates

Public documentation establishes a supported integration path; it does not establish this merchant's entitlement, permissions or credential validity. Provider credentials are not committed or requested in chat.

| Service | Existing implementation / permitted next step | Outstanding gate |
| --- | --- | --- |
| Shopify | GraphQL draft import, read-only catalog and signed paid-order webhook | Store token/scopes, real account acceptance tests, full refund/financial sync |
| Printify | Existing REST catalog snapshot and read-only connection check | Merchant token, shipping/production/order permissions and end-to-end tests |
| CJDropshipping | Existing catalog snapshot and health check | Token entitlement and migration of existing deprecated `/product/list` adapter to documented `/product/listV2` after response-contract verification |
| DSers / AliExpress | Supported Shopify app workflow; supplier mapping already exists locally | Merchant installs/connects DSers; direct custom app requires developer approval and supplied contracts |
| Google Trends | Official API remains access-gated alpha | Approved account/access details; relative interest must never be labeled sales volume |
| Dropship.io | Source links/manual research only | Written API/data entitlement and actual documented contract |
| Sell The Trend | Source links/manual research only | Written API/data entitlement and actual documented contract |
| AutoDS | Local provider workspace and mappings | Confirm supported developer access and merchant entitlement |
| Zendrop | Local provider workspace; supported app handoff to be configured | Merchant app authorization and documented access |
| SaleHoo | Supplier lead records | Merchant access and permitted supplier-data workflow |
| Syncee | Local provider mappings | Merchant authorization and permitted catalog/integration contract |

No unofficial endpoints or scraping are used. API keys alone cannot establish authorization to redistribute provider content.

Official references checked for implementation planning:

- https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate
- https://shopify.dev/docs/api/webhooks/latest
- https://developers.printify.com/
- https://developers.cjdropshipping.com/en/api/api2/api/product.html
- https://www.dsers.dev/
- https://www.dsers.com/en/integration/shopify-dropshipping-service
- https://developers.google.com/search/apis/trends
- https://developers.openai.com/api/docs/guides/text

## Activation

Use Node 24+. Keep the existing database on durable storage and retain existing authentication/origin settings. New tables are added automatically at startup. Existing records are not overwritten.

For optional AI, configure `OPENAI_API_KEY` and `TRADELENS_AI_MODEL` server-side. Generation is explicit per saved report; provider usage costs apply. Reports and original inputs remain usable with no AI credentials.

Create candidates with US/USD or UK/GBP costs in Scout, enter recent analyst assessments, attach research sources, record any actual performance, and regenerate the report. Review evidence and physical samples before manually approving a product. Use Engine for Shopify draft import only after store authorization. No automated supplier purchases or automatic publication are introduced.

## Still required for the complete requested platform

Authorized live research connectors; scheduled provider catalog discovery with product deduplication and approval queues; independent supplier reliability/US-UK delivery verification; actual order/refund/advertising ingestion and reconciliation; optimal selling-price recommendations; external alert delivery; deployment and real-account integration tests. These cannot be called complete on the basis of local data entry or mocked tests.

## Verification

`node --test tests/*.test.mjs` covers fulfillment gates and intelligence ranking, provenance, alerts, mixed currencies, overlapping financial batches, loss exclusion, and the mocked Responses API contract. HTTP smoke testing covers the authenticated dashboard, source/performance forms and cross-origin rejection. No supplier order, live import, payment or paid AI request is placed by tests.
