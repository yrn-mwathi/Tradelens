# Product Intelligence implementation

Updated 5 November 2026. See [live setup and acceptance checks](LIVE_TESTING.md).

## Implemented

| Area | Behavior | Data classification |
| --- | --- | --- |
| Discovery | Official CJ V2 keyword searches, deduplicated research inbox, product price history | API-reported catalog sample; not market sales |
| Review | Exact variant and complete cost entry before unapproved candidate creation; reject products | Merchant-reviewed assumptions |
| Supplier shipping | CJ one-unit freight quotes for US/GB with carrier estimates, USD costs and unknown tax markers | API-reported quotation, not guaranteed delivery or supplier verification |
| Research | Source-linked demand, price, review and competitor observations; existing supplier reviews | Explicit manual provenance; CJ product prices retain API provenance |
| Ranking | Daily saved reports, up to 20 eligible US/UK candidates, stale analyst exclusion | Rules-based decision support, not AI confidence |
| Performance | Shopify sales/refund snapshots; Meta daily ad insights and product mappings | API-reported observations, separate from reconciled profit |
| Learning | Fresh store traction adjusts demand/growth after 20 matched orders; accounting batches adjust margin after 20 recorded orders | Heuristics plus merchant accounting records; not statistical market validation |
| AI | Bounded report briefing through OpenAI Responses API, cached once per report | Unverified generated interpretation; cannot change approvals or badges |
| Alerts | Opportunity, price increase, demand increase, estimated profit decline and recorded loss; durable dashboard and email outbox | Evidence-based rule triggers; provider acceptance distinct from inbox delivery |
| Automation | Per-job state, scheduling, 15-minute failure backoff, skipped credentials, cycle overlap protection | Credential presence never labeled as a verified connection |
| Shopify handoff | Existing manual approval, draft import, catalog synchronization and signed paid-order webhook | Requires merchant authorization; no automatic publication |

## Formula and evidence boundaries

Demand 30%, supplier reliability 20%, low competition 15%, growth 10%, contribution margin 25%. Analyst inputs expire after 30 days. The profitability component saturates at a 40% contribution margin. Nonpositive assumed or learned contribution excludes a recommendation.

At 20 fresh API-reported store orders within the preceding 30 completed UTC dates, demand is `min(100, orders × 2.5) × remaining_units / original_units`. This is a store-traction heuristic, not overall market demand. When a preceding-week baseline exists, growth is `clamp(50 + 50 × (recent_week_orders - prior_week_orders) / prior_week_orders, 0, 100)`; otherwise the analyst growth input remains. Refunded/removed units reduce retained-unit traction. A stale sales snapshot (>24 hours) cannot adjust scores. Supplier reliability and competition still require real research, not fabricated API metrics.

Manual source-linked accounting batches cannot overlap per candidate, have market-currency checks and require visits >= orders. At 20 recorded orders in batches ending within 90 days, recorded margin replaces assumed margin. Whole batches are included by end date. Recorded profit subtracts actual entered costs, ads and refunds once. The heuristic threshold does not establish statistical validity, and manually reported figures are never labeled independently audited.

API merchandise revenue and ads remain separately visible. Conversion is calculated only from explicitly recorded visits and orders; clicks are never substituted for visits. No automatic currency conversion, universal tax/duties calculation, ad-attributed conversion inference, or complete actual-cost inference occurs.

The dashboard also shows an illustrative 25% contribution-margin selling price and break-even acquisition cost using the fixed entered costs. The price is a scenario, not an optimized or market-supported selling price, and does not recalculate price-dependent fees/taxes.

Physical validation always requires a named human reviewer, explicit real-sample confirmation and completed test date. No AI model or catalog import can award it. Market/Supplier Validated statuses document manual reviews, not third-party certification.

## Automation and notifications

Daily local reports run while the server is active. `TRADELENS_AUTOMATION=1` enables daily CJ discovery, hourly Shopify catalog/sales, six-hourly Meta insights, daily reports and 15-minute alert delivery checks. `TRADELENS_AUTO_AI=1` separately permits scheduled paid AI. Per-job errors do not erase prior snapshots or stop other jobs. No provider credentials exist in the checked-in code.

Email batches contain up to 20 alerts to the configured administrator. Stable stored payloads and Resend idempotency keys protect short-term retries. An uncertain delivery older than 23 hours stops for provider-log review, avoiding retries outside the provider's 24-hour key window. Accepted does not mean delivered. Run one server instance with durable SQLite storage; host sleep pauses jobs.

## Unsupported or unverified live access

| Provider | Current boundary |
| --- | --- |
| Google Trends | Official alpha access not supplied; manual relative-interest evidence only |
| Dropship.io / Sell The Trend | Authorized API/data contracts not supplied; source links and manual observations |
| AutoDS / Zendrop / SaleHoo / Syncee | Existing local provider/lead/mapping workspaces; live partner/app access remains to be supplied |
| DSers / AliExpress | Supported merchant Shopify app handoff; no custom API entitlement verified |
| Printify | Existing official catalog and read-only health checks; production/order submission acceptance tests remain |

These gates prevent claiming that the complete nine-service platform is live. Supplier quality/reliability, broad-market demand and physical product quality still require actual evidence. No unsupported endpoints or site scraping are used.

## Primary references

- https://developers.cjdropshipping.com/en/api/api2/api/product.html
- https://developers.cjdropshipping.com/en/api/api2/api/logistic.html
- https://shopify.dev/docs/api/admin-graphql/latest/queries/orders
- https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItem
- https://developers.facebook.com/docs/marketing-api/insights/
- https://www.postman.com/meta/facebook-marketing-api/request/u38qbri/get-insight-details-from-an-adaccount-l4
- https://developers.openai.com/api/docs/guides/text
- https://resend.com/docs/api-reference/emails/send-email
- https://resend.com/docs/dashboard/emails/idempotency-keys
- https://www.dsers.dev/
- https://developers.google.com/search/apis/trends

## Verification

`npm test` covers provider contracts, idempotency, source provenance, price histories, ranking feedback, currency rejection, stale data, atomic snapshot retention, alert retries, physical confirmation, real-mode signed webhook ingestion and protected HTTP routes. Live merchant calls, payment tests, browser visual checks and deployment acceptance remain pending account configuration.
