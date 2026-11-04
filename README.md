# TradeLens — international tech discovery + merchant intelligence

TradeLens combines a public gadget storefront with an approval-led merchant workspace. This branch adds an original, mobile-friendly shopping experience inspired by recurring patterns in the references, without copying third-party artwork, code or catalog content.

## Preview in GitHub Codespaces

1. Open the `feat/unified-commerce-intelligence-launch` branch in Codespaces (or `main` after merge).
2. Use Node.js **24 or later** (Node's built-in `node:sqlite` is required).
3. Run:

```bash
TRADELENS_DEMO=1 HOST=0.0.0.0 TRADELENS_PASSWORD='change-this-demo-password-to-a-long-random-value' node server.mjs
```

4. Open forwarded port **3000** (keep the port private). The public storefront is `/`. Merchant pages include `/admin`, `/admin/engine`, `/admin/supply`, `/admin/evidence` and `/admin/launch` and `/admin/shopify`.

Preview mode uses **eight synthetic product concepts** with illustrative prices and vector artwork. It has working category navigation, keyword search, sort options, gift/work/travel discovery links and individual product detail pages. It does **not** accept payments or imply live supplier stock.

## Persistent merchant configuration

Run without `TRADELENS_DEMO` to use persistent records. Set `TRADELENS_DB` to a durable SQLite path, `HOST=0.0.0.0`, `TRADELENS_PASSWORD` (20+ characters), `TRADELENS_ORIGIN` (public HTTPS origin), and for Shopify `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`. Shopify checkout remains on Shopify. Only approved candidates with explicit public store listings are displayed to buyers. Prefer one server instance with a persistent disk.

The existing merchant pages manage:
- Product research candidates, evidence, margin and acquisition cost.
- Manual weighted analyst assessments and validation records.
- Approval and Shopify GraphQL product **draft** creation.
- Supplier leads, fulfillment mappings and tracking entered locally.
- Validated Shopify `orders/paid` webhook receipts.

## Integration status

| Provider | Current status | Required next step |
| --- | --- | --- |
| Shopify | Draft creation and paid-order webhook implemented; storefront can link to Shopify | Configure store credentials, permissions, product publication and fuller orders/refunds/fulfillment sync |
| Dropship.io | Research can be captured with evidence links | Obtain authorized research data access |
| AutoDS | Provider records and mappings only | Confirm API entitlement, credentials and endpoint access |
| Printify | Provider workspace only | Configure documented REST API + signed webhook handlers |
| Zendrop | Provider workspace only | Complete supported Shopify app handoff |
| SaleHoo | Supplier leads and notes | Verify supplier and app workflow |
| Syncee | Provider mappings only | Verify permitted catalog access and Shopify handoff |
| DSers | Supplier mapping only | Connect supported Shopify-to-AliExpress flow |
| CJDropshipping | Provider mapping and manually entered tracking | Configure CJ API credentials, catalogue, inventory, shipping quotes and orders |

**Do not present placeholder data as sourced sales metrics or authentic merchandise.** No unattended scraping from reference websites or unauthorized APIs is included.

## Reference design patterns

- BURGA: category-led merchandising and promotional collections.
- CASEKOO: model compatibility and accessory-feature navigation.
- DailyObjects: lifestyle and workspace groupings.
- PopSockets: personalization and fit choices (full custom product builder not implemented).
- Gadget Flow: thematic gadget discovery and editorial curation.
- GadgetFinder: guided product finders.
- Trend Hunter: trend research and editorial inspiration.

## Testing checklist

Run `node --check commerce.mjs` and `node --check server.mjs` under Node 24+. Then verify `/health`, home, category, search, sort, gift finder, product detail and admin authentication. Do not expose the admin port publicly without a strong password and HTTPS.

## Combined international launch work

See [the unified release plan](docs/UNIFIED_LAUNCH.md). The International admin workspace now records source-linked landed-profit scenarios for US (USD) and UK (GBP), including shipping, advertising, fees, duties and refunds. These are **manual assumptions**, not live provider quotations or automatic tax calculations. The Shopify and supplier integration gates in the plan remain to be implemented and tested before launch.

### Shopify catalog synchronization

In persistent mode, set `SHOPIFY_SHOP` and `SHOPIFY_ADMIN_TOKEN` with `read_products` permission, then open `/admin/shopify` and choose **Sync Shopify catalog**. The snapshot imports up to 250 products, with up to 50 variants per product; larger catalogs or products with more variants fail without replacing the previous snapshot. It stores Shopify product/variant IDs, SKUs, prices, status, inventory quantities and image URLs in SQLite. This is a **read-only snapshot** and does not automatically publish to the TradeLens storefront or trigger fulfillment. Shopify prices are in the shop currency; no conversion is assumed.
