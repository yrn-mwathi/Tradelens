import {initializeAutomation, runAutomation, deliverAlerts, automationWorkspace} from './automation.mjs';
import {initializeDiscovery, discoverCj, promoteDiscovery, quoteCjFreight, discoveryWorkspace} from './discovery.mjs';
import {initializeStorePerformance, syncStorePerformance, syncAdvertising, mapAdvertising, performanceWorkspace} from './store-performance.mjs';
import { initializeIntelligence, generateBriefing, saveIntelligence, runIntelligence, intelligenceWorkspace } from './intelligence.mjs';
import { initializeShippingEvidence, saveShippingEvidence, shippingEvidenceWorkspace } from './shipping-evidence.mjs';
import { initializeCjCatalog, syncCjCatalog, cjCatalogWorkspace } from './cj-catalog.mjs';
import { initializeSupplierCatalog, syncPrintifyCatalog, printifyCatalogWorkspace } from './printify-catalog.mjs';
import { initializeSupplierHealth, checkSupplierConnection, supplierHealthWorkspace } from './supplier-health.mjs';
import { initializeDispatch, previewSupplierDispatch, dispatchWorkspace } from './supplier-dispatch.mjs';
import { initializeFulfillment, stageFulfillment, fulfillmentWorkspace } from './fulfillment.mjs';
import { initializeShopifyCatalog, syncShopifyCatalog, shopifyCatalogWorkspace } from './shopify-catalog.mjs';
import { initializeLaunch, saveLaunchScenario, launchWorkspace } from './launch.mjs';
import { initializeEvidence, recordEvidence, evidenceWorkspace } from './evidence.mjs';
import { renderCommerce } from './commerce.mjs';
import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

if(process.env.TRADELENS_DEMO==='1'){
 for(const key of ['SHOPIFY_SHOP','SHOPIFY_ADMIN_TOKEN','SHOPIFY_WEBHOOK_SECRET','CJ_ACCESS_TOKEN','PRINTIFY_API_TOKEN','META_ADS_TOKEN','META_AD_ACCOUNT_ID','OPENAI_API_KEY','RESEND_API_KEY'])delete process.env[key];
 process.env.TRADELENS_AUTOMATION='0';
}
const password = process.env.TRADELENS_PASSWORD;
const host = process.env.HOST || '127.0.0.1';
if (host !== '127.0.0.1' && (!password || password.length < 20)) {
  throw new Error('Set TRADELENS_PASSWORD to at least 20 characters before binding externally.');
}
const db = new DatabaseSync(process.env.TRADELENS_DEMO === '1' ? ':memory:' : (process.env.TRADELENS_DB || 'tradelens.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, variant TEXT NOT NULL, market TEXT NOT NULL,
  evidence TEXT NOT NULL, source TEXT NOT NULL, created TEXT NOT NULL,
  revenue INTEGER NOT NULL, supplier INTEGER NOT NULL, shipping INTEGER NOT NULL,
  duties INTEGER NOT NULL, fees INTEGER NOT NULL, acquisition INTEGER NOT NULL, losses INTEGER NOT NULL,
  approved TEXT
)`);

initializeIntelligence(db);
initializeAutomation(db);
initializeDiscovery(db);
initializeStorePerformance(db);
initializeEvidence(db);
initializeLaunch(db);
initializeShopifyCatalog(db);
initializeFulfillment(db);
initializeDispatch(db);
initializeSupplierHealth(db);
initializeSupplierCatalog(db);
initializeCjCatalog(db);
initializeShippingEvidence(db);

const fields = {
  revenue: 'Net selling price (excluding collected tax)',
  supplier: 'Supplier cost',
  shipping: 'Shipping and fulfillment',
  duties: 'Merchant duties and nonrecoverable tax',
  fees: 'Transaction fees',
  acquisition: 'Customer acquisition',
  losses: 'Expected refunds and other losses'
};
const providers = {
  Shopify: 'Storefront, checkout and draft import',
  'Dropship.io': 'Product and competitor research',
  AutoDS: 'Catalog, stock and order automation',
  Printify: 'Print-on-demand production',
  Zendrop: 'Managed sourcing and fulfillment',
  SaleHoo: 'Supplier leads',
  Syncee: 'Supplier marketplace',
  DSers: 'AliExpress fulfillment',
  CJDropshipping: 'Sourcing, warehouse and shipping'
};
const fulfillmentProviders = ['AutoDS', 'Printify', 'Zendrop', 'Syncee', 'DSers', 'CJDropshipping'];
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS supplier_leads (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, notes TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_lines (
    reference TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
    provider TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
    tracking TEXT
  );
  CREATE TABLE IF NOT EXISTS catalog_mappings (
    candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
    provider TEXT NOT NULL, sku TEXT NOT NULL, stock INTEGER NOT NULL CHECK(stock >= 0)
  );
`);

const escape = value => String(value).replace(/[&<>"']/g, c => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
})[c]);
const digest = value => createHash('sha256').update(value).digest();

const shop = process.env.SHOPIFY_SHOP?.toLowerCase();
const shopToken = process.env.TRADELENS_DEMO === '1' ? undefined : process.env.SHOPIFY_ADMIN_TOKEN;
const webhookSecret = process.env.TRADELENS_DEMO === '1' ? undefined : process.env.SHOPIFY_WEBHOOK_SECRET;
if (shop && !/^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$/.test(shop)) {
  throw new Error('SHOPIFY_SHOP must be a myshopify.com hostname.');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS shopify_drafts (
    shop TEXT NOT NULL, candidate_id TEXT NOT NULL REFERENCES candidates(id),
    product_gid TEXT, PRIMARY KEY (shop, candidate_id)
  );
  CREATE TABLE IF NOT EXISTS shopify_paid_orders (
    shop TEXT NOT NULL, order_gid TEXT NOT NULL, line_count INTEGER NOT NULL,
    PRIMARY KEY (shop, order_gid)
  );
`);

async function createDraft(id) {
  if (!shop || !shopToken) throw new Error('Configure the Shopify development store first.');
  const candidate = db.prepare('SELECT * FROM candidates WHERE id=? AND approved IS NOT NULL').get(id);
  if (!candidate) throw new Error('Choose an approved candidate.');
  const reserve = db.prepare('INSERT OR IGNORE INTO shopify_drafts (shop,candidate_id) VALUES (?,?)').run(shop, id);
  if (!reserve.changes) return;
  try {
    const result = await fetch('https://' + shop + '/admin/api/2026-10/graphql.json', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': shopToken },
      body: JSON.stringify({
        query: 'mutation CreateDraft($product: ProductCreateInput!) { productCreate(product: $product) { product { id status } userErrors { message } } }',
        variables: { product: {
          title: candidate.name + ' - ' + candidate.variant, status: 'DRAFT', handle: 'tradelens-' + id
        } }
      })
    });
    if (!result.ok) throw new Error('Shopify HTTP failure');
    const body = await result.json();
    const product = body.data?.productCreate?.product;
    if (product?.status !== 'DRAFT' || !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id)) {
      throw new Error('Missing Shopify draft');
    }
    db.prepare('UPDATE shopify_drafts SET product_gid=? WHERE shop=? AND candidate_id=?')
      .run(product.id, shop, id);
  } catch {
    throw new Error('Draft outcome needs review. Search Shopify for handle tradelens-' + id + ' before retrying.');
  }
}

async function receivePaidOrder(request, response) {
  if (!shop || !webhookSecret) {
    response.statusCode = 404;
    return response.end();
  }
  const raw = await readBody(request, 2_000_000);
  if (!raw) {
    response.statusCode = 413;
    return response.end();
  }
  const signature = Buffer.from(request.headers['x-shopify-hmac-sha256'] || '', 'base64');
  const expected = createHmac('sha256', webhookSecret).update(raw).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected) ||
      request.headers['x-shopify-shop-domain'] !== shop || request.headers['x-shopify-topic'] !== 'orders/paid') {
    response.statusCode = 401;
    return response.end();
  }
  let order;
  try { order = JSON.parse(raw.toString()); } catch {
    response.statusCode = 400;
    return response.end();
  }
  if (typeof order?.admin_graphql_api_id !== 'string' ||
      !/^gid:\/\/shopify\/Order\/\d+$/.test(order.admin_graphql_api_id) ||
      !Array.isArray(order.line_items)) {
    response.statusCode = 400;
    return response.end();
  }
  const lines = order.line_items.map(line => {
    const lineId = String(line.id ?? '');
    const variantId = String(line.variant_id ?? '');
    const quantity = line.quantity;
    if (!/^[1-9]\d*$/.test(lineId) || !/^[1-9]\d*$/.test(variantId) ||
        !Number.isSafeInteger(quantity) || quantity < 1) return null;
    return [shop,order.admin_graphql_api_id,lineId,'gid://shopify/ProductVariant/'+variantId,quantity];
  }).filter(Boolean);
  // Reject malformed line items instead of silently marking an incomplete order as paid.
  if (lines.length !== order.line_items.length) {
    response.statusCode = 400;
    return response.end();
  }
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR IGNORE INTO shopify_paid_orders VALUES (?,?,?)')
      .run(shop, order.admin_graphql_api_id, order.line_items.length);
    const insertLine = db.prepare('INSERT OR IGNORE INTO shopify_paid_order_lines VALUES (?,?,?,?,?)');
    for (const line of lines) insertLine.run(...line);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  response.statusCode = 204;
  return response.end();
}

function money(value) {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value || '')) throw new Error('Enter a valid amount for every cost. Use zero only when applicable.');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function required(form, key, limit) {
  const value = form.get(key)?.trim();
  if (!value || value.length > limit) throw new Error('Invalid ' + key);
  return value;
}

function operations(rows) {
  const candidates = rows.filter(row => row.approved);
  const options = candidates.map(row =>
    `<option value="${row.id}">${escape(row.name)} · ${escape(row.variant)} · ${row.market}</option>`).join('');
  const providerOptions = fulfillmentProviders.map(name => `<option>${name}</option>`).join('');
  const leads = db.prepare('SELECT * FROM supplier_leads ORDER BY name').all();
  const mappings = db.prepare(`SELECT m.*, c.name, c.market FROM catalog_mappings m
    JOIN candidates c ON c.id=m.candidate_id ORDER BY c.name`).all();
  const lines = db.prepare(`SELECT l.*, c.name FROM order_lines l
    JOIN candidates c ON c.id=l.candidate_id ORDER BY l.reference`).all();
  return `<section><h2>Supplier leads</h2>
    <form method="post" action="/leads"><div class="grid">
    <label>Supplier name<input name="name" required maxlength="120"></label>
    <label>Source<select name="provider">${Object.keys(providers).map(name => `<option>${name}</option>`).join('')}</select></label>
    <label>Verification notes<input name="notes" required maxlength="1200"></label>
    </div><button>Save lead</button></form>
    <ul>${leads.map(lead => `<li>${escape(lead.name)} · ${escape(lead.provider)} · ${escape(lead.notes)}</li>`).join('')}</ul></section>
    <section><h2>Catalog and fulfillment</h2><p>Local records for approved variants. Update stock from your provider and record tracking after fulfillment.</p>
    ${options ? `<form method="post" action="/catalog"><div class="grid">
    <label>Approved variant<select name="id">${options}</select></label>
    <label>Fulfillment owner<select name="provider">${providerOptions}</select></label>
    <label>Provider SKU<input name="sku" required maxlength="120"></label>
    <label>Reported stock<input name="stock" type="number" min="0" max="999999" required></label>
    </div><button>Save mapping</button></form>` : '<p>Approve a candidate to create its catalog mapping.</p>'}
    <ul>${mappings.map(item => `<li>${escape(item.name)} · ${item.market} · ${escape(item.provider)} · ${escape(item.sku)} · ${item.stock} reported units</li>`).join('')}</ul>
    ${mappings.length ? `<form method="post" action="/orders"><div class="grid">
    <label>Shopify order line reference<input name="reference" required maxlength="120"></label>
    <label>Mapped variant<select name="id">${mappings.map(item =>
      `<option value="${item.candidate_id}">${escape(item.name)} · ${item.market} · ${escape(item.sku)}</option>`).join('')}</select></label>
    <label>Quantity<input name="quantity" type="number" min="1" max="999999" required></label>
    </div><button>Assign order line</button></form>` : ''}
    ${lines.map(line => `<article><strong>${escape(line.reference)}</strong> · ${escape(line.name)} · ${escape(line.provider)} · Qty ${line.quantity}
    <form method="post" action="/tracking"><input type="hidden" name="reference" value="${escape(line.reference)}">
    <label>Tracking number<input name="tracking" required maxlength="120" value="${escape(line.tracking ?? '')}"></label>
    <button>Save tracking</button></form></article>`).join('')}</section>`;
}

function count(form, key, minimum) {
  const raw = required(form, key, 6);
  if (!/^\d+$/.test(raw) || Number(raw) < minimum) throw new Error('Invalid ' + key);
  return Number(raw);
}

function saveOperation(path, form) {
  if (path === '/leads') {
    const provider = required(form, 'provider', 30);
    if (!Object.hasOwn(providers, provider)) throw new Error('Unknown source.');
    db.prepare('INSERT INTO supplier_leads VALUES (?,?,?,?)').run(randomUUID(),
      required(form, 'name', 120), provider, required(form, 'notes', 1200));
    return;
  }
  if (path === '/catalog') {
    const id = required(form, 'id', 36);
    const provider = required(form, 'provider', 30);
    if (!fulfillmentProviders.includes(provider)) throw new Error('Unknown fulfillment provider.');
    if (!db.prepare('SELECT id FROM candidates WHERE id=? AND approved IS NOT NULL').get(id)) {
      throw new Error('Choose an approved candidate.');
    }
    db.prepare(`INSERT INTO catalog_mappings VALUES (?,?,?,?)
      ON CONFLICT(candidate_id) DO UPDATE SET provider=excluded.provider, sku=excluded.sku, stock=excluded.stock`)
      .run(id, provider, required(form, 'sku', 120), count(form, 'stock', 0));
    return;
  }
  const reference = required(form, 'reference', 120);
  if (path === '/tracking') {
    const result = db.prepare('UPDATE order_lines SET tracking=? WHERE reference=?')
      .run(required(form, 'tracking', 120), reference);
    if (!result.changes) throw new Error('Order line not found.');
    return;
  }
  const mapping = db.prepare('SELECT * FROM catalog_mappings WHERE candidate_id=?')
    .get(required(form, 'id', 36));
  if (!mapping) throw new Error('Choose a mapped candidate.');
  const quantity = count(form, 'quantity', 1);
  const result = db.prepare(`INSERT INTO order_lines (reference,candidate_id,provider,quantity)
    VALUES (?,?,?,?) ON CONFLICT(reference) DO NOTHING`)
    .run(reference, mapping.candidate_id, mapping.provider, quantity);
  if (!result.changes) {
    const existing = db.prepare('SELECT * FROM order_lines WHERE reference=?').get(reference);
    if (existing.candidate_id !== mapping.candidate_id || existing.provider !== mapping.provider || existing.quantity !== quantity) {
      throw new Error('This order line already has a fulfillment assignment.');
    }
  }
}

const markets = { US: 'USD', UK: 'GBP', KE: 'KES', NG: 'NGN' };
const factors = { demand: 30, supplier: 20, competition: 15, growth: 10 };
const validations = ['Market Validated', 'Supplier Validated', 'Physically Tested'];
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_assessments (
    candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), demand INTEGER NOT NULL,
    supplier INTEGER NOT NULL, competition INTEGER NOT NULL, growth INTEGER NOT NULL,
    evidence TEXT NOT NULL, recorded TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scout_validations (
    candidate_id TEXT NOT NULL REFERENCES candidates(id), badge TEXT NOT NULL,
    reviewer TEXT NOT NULL, evidence TEXT NOT NULL, recorded TEXT NOT NULL,
    PRIMARY KEY(candidate_id, badge)
  );
`);

if (process.env.TRADELENS_DEMO === '1') {
  db.exec(`BEGIN;
    INSERT OR IGNORE INTO candidates
      VALUES ('demo-hub','Demo USB-C desk hub','7-port','US',
        'Synthetic example for exploring TradeLens. Figures are illustrative.',
        'https://example.com/',datetime('now'),4900,1400,500,200,180,650,150,datetime('now'));
    INSERT OR IGNORE INTO scout_assessments
      VALUES ('demo-hub',82,75,68,80,'Synthetic analyst inputs for this demo.',datetime('now'));
    INSERT OR IGNORE INTO supplier_leads
      VALUES ('demo-supplier','Demo supplier','CJDropshipping','Synthetic supplier lead');
    INSERT OR IGNORE INTO catalog_mappings
      VALUES ('demo-hub','CJDropshipping','DEMO-HUB',24);
    INSERT OR IGNORE INTO order_lines
      VALUES ('demo-order-line','demo-hub','CJDropshipping',1,'DEMO-TRACKING');
    COMMIT;`);
}

function contribution(row) {
  return row.revenue - row.supplier - row.shipping - row.duties - row.fees - row.acquisition - row.losses;
}

function recordScout(path, form) {
  const id = required(form, 'id', 36);
  if (!db.prepare('SELECT id FROM candidates WHERE id=?').get(id)) throw new Error('Candidate not found.');
  const evidence = required(form, 'evidence', 1200);
  const recorded = new Date().toISOString();
  if (path === '/scout/validation') {
    const badge = required(form, 'badge', 30);
    if (!validations.includes(badge)) throw new Error('Choose a validation type.');
    if (badge === 'Physically Tested') {
      const date=form.get('test_date')||'';
      if(form.get('physical_confirm')!=='yes'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>recorded.slice(0,10)) throw new Error('Physical testing requires an explicit human confirmation and valid completed test date.');
    }
    db.prepare(`INSERT INTO scout_validations VALUES (?,?,?,?,?)
      ON CONFLICT(candidate_id,badge) DO UPDATE SET reviewer=excluded.reviewer,
      evidence=excluded.evidence, recorded=excluded.recorded`)
      .run(id, badge, required(form, 'reviewer', 120), badge==='Physically Tested'?'Sample test date '+form.get('test_date')+'. '+evidence:evidence, recorded);
    return;
  }
  const inputs = Object.keys(factors).map(key => count(form, key, 0));
  if (inputs.some(value => value > 100)) throw new Error('Scores must be between 0 and 100.');
  db.prepare(`INSERT INTO scout_assessments VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(candidate_id) DO UPDATE SET demand=excluded.demand, supplier=excluded.supplier,
    competition=excluded.competition, growth=excluded.growth, evidence=excluded.evidence,
    recorded=excluded.recorded`).run(id, ...inputs, evidence, recorded);
}

function scout(row, assessment, badges) {
  return `<details><summary>Scout evidence and validation</summary>
    ${assessment ? `<p>Analyst assessment · ${escape(assessment.recorded.slice(0,10))} · ${escape(assessment.evidence)}</p>` : ''}
    <form method="post" action="/scout/assessment">
    <input type="hidden" name="id" value="${row.id}"><div class="grid">
    ${Object.keys(factors).map(key => `<label>${key} (0–100; higher is better)
      <input name="${key}" type="number" min="0" max="100" value="${assessment?.[key] ?? ''}" required></label>`).join('')}
    <label>Supporting observations and sources<textarea name="evidence" maxlength="1200" required>${escape(assessment?.evidence ?? '')}</textarea></label></div>
    <button>Save analyst assessment</button></form>
    <ul>${badges.map(badge => `<li>${escape(badge.badge)} · ${escape(badge.reviewer)} · ${escape(badge.recorded.slice(0,10))} · ${escape(badge.evidence)}</li>`).join('')}</ul>
    <form method="post" action="/scout/validation"><input type="hidden" name="id" value="${row.id}">
    <div class="grid"><label>Validation<select name="badge">${validations.map(value => `<option>${value}</option>`).join('')}</select></label>
    <label>Physical test date (required only for Physically Tested)<input name="test_date" type="date"></label><label><span>I personally confirm a real sample was physically tested (required only for Physically Tested)</span><input name="physical_confirm" type="checkbox" value="yes"></label><label>Reviewer or sample tester<input name="reviewer" maxlength="120" required></label>
    <label>Evidence and results (include sample test date for physical testing)<textarea name="evidence" maxlength="1200" required></textarea></label></div>
    <button>Confirm validation</button></form></details>`;
}

const collections = ['Phone Accessories', 'Charging', 'Desk & Work', 'Smart Living', 'Travel Tech'];
db.exec(`CREATE TABLE IF NOT EXISTS store_listings (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), collection TEXT NOT NULL,
  description TEXT NOT NULL, handle TEXT NOT NULL, shop TEXT NOT NULL,
  UNIQUE(shop, handle)
)`);

const listingColumns = db.prepare('PRAGMA table_info(store_listings)').all();
for (const column of ['photo', 'compatibility', 'variant_id']) {
  if (!listingColumns.some(item => item.name === column)) {
    db.exec('ALTER TABLE store_listings ADD COLUMN ' + column + ' TEXT');
  }
}

function updateListing(form) {
  const id = required(form, 'id', 36);
  if (form.get('action') === 'remove') {
    db.prepare('DELETE FROM store_listings WHERE candidate_id=?').run(id);
    return;
  }
  if (!shop || process.env.TRADELENS_DEMO === '1') throw new Error('Configure Shopify in the persistent workspace first.');
  if (!db.prepare('SELECT id FROM candidates WHERE id=? AND approved IS NOT NULL').get(id)) {
    throw new Error('Approve the candidate first.');
  }
  const collection = required(form, 'collection', 30);
  const handle = required(form, 'handle', 120);
  if (!collections.includes(collection) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) {
    throw new Error('Choose a collection and enter a valid Shopify product handle.');
  }
  const photo = form.get('photo')?.trim() || null;
  const compatibility = form.get('compatibility')?.trim() || null;
  const variantId = form.get('variant_id')?.trim() || null;
  if (photo && (photo.length > 2048 || !/^https:\/\/cdn[.]shopify[.]com\/[^\s]+$/.test(photo))) {
    throw new Error('Use an HTTPS product photo hosted on cdn.shopify.com.');
  }
  if (compatibility && compatibility.length > 400) throw new Error('Compatibility details exceed 400 characters.');
  if (variantId && !/^[1-9][0-9]{0,19}$/.test(variantId)) throw new Error('Enter a numeric Shopify variant ID.');
  const cached = db.prepare('SELECT * FROM shopify_catalog_snapshot WHERE shop=? AND handle=? AND variant_gid=?').get(shop,handle,'gid://shopify/ProductVariant/'+variantId);
  if (!variantId || !cached || cached.status !== 'ACTIVE') {
    throw new Error('Choose an ACTIVE variant from the synchronized Shopify catalog. Sync the catalog first.');
  }
  if (cached.inventory !== null && cached.inventory <= 0) throw new Error('Shopify snapshot shows no stock for this variant.');
  const candidatePrice = db.prepare('SELECT revenue FROM candidates WHERE id=?').get(id).revenue;
  if (!/^\d+(?:\.\d{1,2})?$/.test(cached.price) || Math.round(Number(cached.price)*100) !== candidatePrice) throw new Error('Candidate selling price must match the synchronized Shopify variant price; confirm Shopify shop currency matches candidate market.');
  if (photo && photo !== cached.image_url) throw new Error('Use the synchronized Shopify image or leave the photo blank.');
  db.prepare(`INSERT INTO store_listings
    (candidate_id,collection,description,handle,shop,photo,compatibility,variant_id) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(candidate_id) DO UPDATE SET collection=excluded.collection,
    description=excluded.description, handle=excluded.handle, shop=excluded.shop,
    photo=excluded.photo, compatibility=excluded.compatibility, variant_id=excluded.variant_id`)
    .run(id, collection, required(form, 'description', 1000), handle, shop, photo, compatibility, variantId);
}

const previewCatalog = [
  ['GripStand Case', 'Magnetic phone case', 'A protective case concept with a fold-out stand for hands-free viewing.'],
  ['Arc Charging Dock', 'Desktop charging', 'An upright charging dock concept that keeps your phone visible while you work.'],
  ['Studio USB-C Hub', '7-port concept', 'A compact hub concept for connecting displays, storage and desk accessories.'],
  ['Glow Desk Lamp', 'Ambient lighting', 'A compact lamp concept for adding soft light to a shelf or desk.'],
  ['Transit Tech Pouch', 'Travel organizer', 'A zippered organizer concept for cables, adapters and small accessories.']
];

function productArt(collection) {
  const shapes = [
    '<rect x="87" y="30" width="126" height="160" rx="24" fill="#151724"/><rect x="101" y="44" width="48" height="46" rx="12" fill="#8884ac"/><circle cx="117" cy="60" r="8"/><circle cx="133" cy="75" r="8"/><circle cx="150" cy="130" r="32" fill="none" stroke="#b1aafa" stroke-width="7"/>',
    '<path d="M104 171h104l24 19H71z" fill="#332449"/><rect x="105" y="35" width="100" height="135" rx="22" fill="#262035"/><circle cx="155" cy="100" r="29" fill="none" stroke="#edc7ff" stroke-width="8"/>',
    '<path d="M206 98q62 0 57 53" fill="none" stroke="#191a23" stroke-width="10"/><rect x="54" y="75" width="159" height="75" rx="17" fill="#272b38"/><path d="M71 126h22m12 0h22m12 0h22m12 0h22" stroke="#9fa4c4" stroke-width="7"/>',
    '<path d="M153 91v83m-45 7h92" stroke="#293b37" stroke-width="16" stroke-linecap="round"/><path d="M91 100a60 60 0 0 1 120 0z" fill="#fff3c6"/>',
    '<rect x="56" y="60" width="190" height="105" rx="31" fill="#33414c"/><path d="M66 100h170m-32 0v20" stroke="#c1d6db" stroke-width="5"/><path d="M102 61q0-29 48-29t48 29" fill="none" stroke="#33414c" stroke-width="8"/>'
  ];
  return `<svg viewBox="0 0 300 220" aria-hidden="true">${shapes[collections.indexOf(collection)] || ''}</svg>`;
}

function storefront(url) {
  const demo = process.env.TRADELENS_DEMO === '1';
  const listings = demo ? previewCatalog.map(([name, variant, description], index) => ({
    candidate_id: 'preview-' + index, name, variant, description, collection: collections[index]
  })) : db.prepare(`
    SELECT l.*, c.name, c.variant FROM store_listings l JOIN candidates c ON c.id=l.candidate_id
    WHERE l.shop=? AND c.approved IS NOT NULL ORDER BY c.name`).all(shop || '');
  const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const selected = collections.find(name => name === url.searchParams.get('collection'));
  const detail = listings.find(item => item.candidate_id === url.searchParams.get('product'));
  const featured = listings.find(item => item.collection === 'Desk & Work') || listings[0];
  const visible = listings.filter(item => (!selected || item.collection === selected) &&
    [item.name, item.variant, item.description, item.collection, item.compatibility].join(' ').toLowerCase().includes(query.toLowerCase()));
  const productLink = item => '/?product=' + encodeURIComponent(item.candidate_id);
  const artwork = item => `<div class="art tone${collections.indexOf(item.collection)}">${item.photo ? `<img src="${escape(item.photo)}" alt="${escape(item.name)}" width="480" height="360">` : productArt(item.collection)}</div>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>TradeLens | Tech &amp; everyday carry</title>
    <style>
    *{box-sizing:border-box}body{margin:0;background:#fcfaf6;color:#211e25;font:16px system-ui}
    main,nav{max-width:1280px;margin:auto;padding:0 24px}a{color:inherit}nav{display:flex;gap:24px;align-items:center;flex-wrap:wrap;padding-block:18px}nav strong{font-size:26px;letter-spacing:-1px}nav form{margin-left:auto;display:flex;gap:6px}input,button{font:inherit;padding:9px;border:1px solid #9a909e;border-radius:7px;min-width:0}button{cursor:pointer}
    .strip{background:#221d2b;color:white;text-align:center;padding:9px;font-size:13px}.hero,.detail{display:grid;grid-template-columns:1fr 1fr;background:#eae3f8;border-radius:24px;overflow:hidden}.copy{padding:clamp(22px,5vw,72px)}h1{font-size:clamp(38px,6vw,82px);line-height:1;margin:.25em 0;letter-spacing:-.05em}
    .action{display:inline-block;background:#241a33;color:white;padding:12px 18px;border-radius:8px;text-decoration:none}.eyebrow{font-size:12px;letter-spacing:.13em;font-weight:750}.art{display:grid;place-items:center;min-height:180px;background:#eae3f8}.hero>a{display:grid}.art img{width:100%;height:100%;max-height:440px;object-fit:cover}.card .art img{aspect-ratio:4/3}.art svg{width:min(100%,340px);filter:drop-shadow(8px 12px 9px #231e3740)}.tone1{background:#f1dbf1}.tone2{background:#dce2fa}.tone3{background:#dcead9}.tone4{background:#dce8ea}
    .chips{display:flex;flex-wrap:wrap;gap:8px}.chips a{border:1px solid #ada3b4;border-radius:30px;padding:8px 14px;text-decoration:none}.chips a[aria-current]{background:#241a33;color:white}
    section{margin:36px 0}.cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,215px),1fr))}.card{border:1px solid #ddd6df;border-radius:16px;overflow:hidden;background:white;text-decoration:none}.card:hover,.card:focus-visible{outline:2px solid #624689}.card div:last-child{padding:16px}.card h3{margin:.35em 0}.note{padding:12px;background:#f0e9da;border-radius:8px}footer{padding:28px 0;color:#514956}
    @media(max-width:640px){.hero,.detail{grid-template-columns:1fr}nav form{margin-left:0;width:100%}nav input{flex:1}}
    </style><div class="strip">TradeLens · Gadgets, desk upgrades &amp; everyday carry</div>
    <nav aria-label="Store navigation"><strong><a href="/">TradeLens</a></strong><a href="/#discover">Discover</a><a href="/admin">Merchant workspace</a>
    <form action="/" role="search"><input name="q" aria-label="Search products" placeholder="Search gadgets" value="${escape(query)}"><button>Search</button></form></nav>
    <main>${demo ? '<p class="note">Preview catalog · Illustrated concepts for exploring the store.</p>' : ''}
    ${detail ? `<section class="detail">${artwork(detail)}<div class="copy"><a href="/#discover">← Back to discover</a>
    <p class="eyebrow">${escape(detail.collection)}</p><h1>${escape(detail.name)}</h1><p>${escape(detail.variant)}</p>
    <p>${escape(detail.description)}</p>${detail.compatibility ? `<p><strong>Compatibility</strong><br>${escape(detail.compatibility)}</p>` : ''}${demo ? '<p>Preview product · Checkout unavailable</p>' :
      `<a class="action" href="https://${escape(detail.shop)}/products/${escape(detail.handle)}">View on Shopify</a>${detail.variant_id ? ` <a class="action" href="https://${escape(detail.shop)}/cart/${escape(detail.variant_id)}:1">Buy this variant</a>` : ''}`}</div></section>`
    : `<header class="hero"><div class="copy"><span class="eyebrow">THE EVERYDAY TECH EDIT</span>
    <h1>Upgrade your everyday.</h1><p>Discover clever accessories for your phone, desk, home and travels.</p>
    <a class="action" href="#discover">Explore the collection →</a></div>
    ${featured ? `<a href="${productLink(featured)}" aria-label="Explore ${escape(featured.name)}">${artwork(featured)}</a>` :
      `<div class="art tone2">${productArt('Desk & Work')}</div>`}</header>
    <section id="discover"><span class="eyebrow">CURATED BY TRADELENS</span><h2>${query ? 'Search results' : 'Discover products'}</h2>
    <div class="chips"><a href="/#discover"${selected ? '' : ' aria-current="true"'}>All products</a>
    ${collections.map(name => `<a href="/?collection=${encodeURIComponent(name)}#discover"${selected === name ? ' aria-current="true"' : ''}>${escape(name)}</a>`).join('')}</div></section>
    <div class="cards">${visible.map(item => `<a class="card" href="${productLink(item)}">${artwork(item)}<div>
    <small>${escape(item.collection)}</small><h3>${escape(item.name)}</h3><span>${escape(item.variant)} · View details →</span></div></a>`).join('')}</div>
    ${visible.length ? '' : '<p>No products found in this view.</p>'}`}
    <footer>TradeLens · ACL Smart Solutions Ltd</footer></main></html>`;
}

function listingControls(row, listing) {
  if (!row.approved || !shop || process.env.TRADELENS_DEMO === '1') return '';
  return `<details><summary>Buyer storefront listing</summary>
    <p>Confirm the product is available in your Shopify online store before adding its handle.</p>
    <form method="post" action="/store/listing"><input type="hidden" name="id" value="${row.id}">
    <label>Collection<select name="collection">${collections.map(name =>
      `<option${listing?.collection === name ? ' selected' : ''}>${escape(name)}</option>`).join('')}</select></label>
    <label>Shopify product handle<input name="handle" required maxlength="120" value="${escape(listing?.handle ?? '')}"></label>
    <label>Public description<textarea name="description" required maxlength="1000">${escape(listing?.description ?? '')}</textarea></label>
    <label>Shopify CDN photo URL<input name="photo" type="url" maxlength="2048" value="${escape(listing?.photo ?? '')}"></label>
    <label>Compatibility and supported models<textarea name="compatibility" maxlength="400">${escape(listing?.compatibility ?? '')}</textarea></label>
    <label>Shopify variant (synced ACTIVE catalog)<select name="variant_id" required><option value="">Select synchronized variant</option>${db.prepare("SELECT variant_gid,title,variant_title,handle,inventory FROM shopify_catalog_snapshot WHERE shop=? AND status='ACTIVE' ORDER BY title LIMIT 250").all(shop).map(v=>`<option value="${escape(v.variant_gid.split('/').at(-1))}"${listing?.variant_id === v.variant_gid.split('/').at(-1) ? ' selected' : ''}>${escape(v.title)} — ${escape(v.variant_title)} (${escape(v.handle)}) · stock ${escape(v.inventory ?? 'untracked')}</option>`).join('')}</select></label>
    <p>The selected variant's Shopify handle must match the handle above. Sync the catalog first in Shopify catalog.</p>
    <button>Publish to TradeLens storefront</button></form>
    ${listing ? `<form method="post" action="/store/listing"><input type="hidden" name="id" value="${row.id}">
    <button name="action" value="remove">Remove from storefront</button></form>` : ''}</details>`;
}

const workspaces = { '/admin/connections': 'Live connections', '/admin/discovery': 'Discovery inbox', '/admin/performance': 'Live performance', '/admin/intelligence': 'Product Intelligence', '/admin': 'Scout', '/admin/engine': 'Engine', '/admin/supply': 'Supply', '/admin/evidence': 'Evidence', '/admin/launch': 'International', '/admin/shopify': 'Shopify catalog', '/admin/fulfillment': 'Fulfillment', '/admin/dispatch': 'Dispatch previews', '/admin/suppliers': 'Supplier connections', '/admin/printify': 'Printify catalog', '/admin/cj': 'CJ catalog', '/admin/shipping': 'Shipping evidence' };

function page(path) {
  const rows = db.prepare('SELECT * FROM candidates ORDER BY created DESC').all();
  const assessments = new Map(db.prepare('SELECT * FROM scout_assessments').all()
    .map(item => [item.candidate_id, item]));
  const badges = db.prepare('SELECT * FROM scout_validations').all();
  const ranked = rows.flatMap(row => {
    const assessment = assessments.get(row.id);
    const profit = contribution(row);
    if (!assessment || profit <= 0 || Date.now() - Date.parse(assessment.recorded) > 30 * 86400000) return [];
    const marginScore = Math.min(100, 250 * profit / row.revenue);
    const score = (25 * marginScore + Object.entries(factors)
      .reduce((sum, [key, weight]) => sum + assessment[key] * weight, 0)) / 100;
    return [{row, score, profit}];
  }).sort((a,b) => b.score - a.score);
  const drafts = new Map(db.prepare('SELECT * FROM shopify_drafts WHERE shop=?').all(shop || '')
    .map(draft => [draft.candidate_id, draft]));
  const paidOrders = db.prepare('SELECT * FROM shopify_paid_orders WHERE shop=? ORDER BY rowid DESC LIMIT 30').all(shop || '');
  const listings = new Map(db.prepare('SELECT * FROM store_listings WHERE shop=?').all(shop || '')
    .map(item => [item.candidate_id, item]));
  const cards = rows.map(row => {
    const draft = drafts.get(row.id);
    const shopify = draft?.product_gid ? '<p>Shopify draft: ' + escape(draft.product_gid) + '</p>'
      : draft ? '<p>Draft request pending or needs review. Search Shopify for tradelens-' + row.id + '.</p>'
      : row.approved && shop && shopToken ? `<form method="post" action="/shopify/draft">
      <input type="hidden" name="id" value="${row.id}"><button>Create Shopify draft</button></form>` : '';
    if (path === '/admin/engine') return row.approved ? `<article><h3>${escape(row.name)}</h3><p>${escape(row.variant)} · ${row.market}</p>${shopify}${listingControls(row, listings.get(row.id))}</article>` : '';
    const breakEven = row.revenue - row.supplier - row.shipping - row.duties - row.fees - row.losses;
    const contribution = breakEven - row.acquisition;
    const currency = markets[row.market];
    const format = cents => new Intl.NumberFormat('en', { style:'currency', currency }).format(cents / 100);
    return `<article><small>${row.market} · ${escape(row.variant)} · Analyst estimate</small>
      <h3>${escape(row.name)}</h3><p>${escape(row.evidence)}</p>
      <p><a href="${escape(row.source)}" rel="noreferrer">Evidence source</a> · ${escape(row.created.slice(0,10))}</p>
      <p>Estimated contribution <strong>${format(contribution)}</strong> · Margin ${(contribution / row.revenue * 100).toFixed(1)}%</p>
      <p>Break-even acquisition cost ${format(breakEven)}</p>
      ${row.approved ? '<strong>Approved for handoff</strong>' : `<form method="post" action="/approve"><input type="hidden" name="id" value="${row.id}"><button>Approve for handoff</button></form>`}
      ${scout(row, assessments.get(row.id), badges.filter(badge => badge.candidate_id === row.id))}
    </article>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>TradeLens</title><style>
    *{box-sizing:border-box}body{margin:0;background:#101827;color:#eef3ff;font:16px system-ui}main{max-width:1060px;margin:auto;padding:32px 20px}
    header,section,article{margin-bottom:20px}section,article{background:#192438;border:1px solid #34425b;border-radius:14px;padding:20px}
    h1{font-size:48px;margin:8px 0}small,a{color:#82e6d4}p{line-height:1.5}label{display:grid;gap:5px}
    nav{display:flex;flex-wrap:wrap;gap:16px;margin:18px 0}nav a[aria-current]{font-weight:800;text-decoration-thickness:3px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(225px,1fr));gap:14px}
    input,select,textarea,button{font:inherit;border-radius:7px;padding:10px;border:1px solid #50627e}
    input,select,textarea{width:100%;background:#111b2c;color:#fff}button{background:#82e6d4;color:#102128;cursor:pointer;font-weight:700;margin-top:12px}
    </style><main><header><small>ACL SMART SOLUTIONS LTD</small><nav aria-label="Workspace">${Object.entries(workspaces).map(([url,label]) => `<a href="${url}"${url === path ? ' aria-current="page"' : ''}>${label}</a>`).join('')}<a href="/">Storefront</a></nav><h1>TradeLens ${workspaces[path]}</h1>${process.env.TRADELENS_DEMO === '1' ? '<p><strong>Demo workspace.</strong> Sample figures are synthetic. Changes reset on restart.</p>' : ''}</header>
    ${path === '/admin' ? `<section><h2>Add candidate</h2><p>Use USD for US, GBP for UK, KES for Kenya and NGN for Nigeria. Enter per-order amounts and cite your supporting evidence.</p>
    <form method="post" action="/candidates"><div class="grid">
    <label>Product<input name="name" required maxlength="120"></label>
    <label>Variant<input name="variant" required maxlength="120"></label>
    <label>Market<select name="market"><option value="US">United States</option><option value="UK">United Kingdom</option><option value="KE">Kenya</option><option value="NG">Nigeria</option></select></label>
    <label>Source URL<input type="url" name="source" required></label>
    ${Object.entries(fields).map(([key,label]) => `<label>${label}<input name="${key}" inputmode="decimal" required></label>`).join('')}
    <label>Evidence notes<textarea name="evidence" required maxlength="1200"></textarea></label></div><button>Save candidate</button></form></section>
    <section><h2>Scout shortlist</h2>
    <p>Up to 20 candidates with positive estimated contribution and analyst evidence recorded within 30 days. Scores reflect analyst inputs and margin assumptions.</p>
    ${ranked.length ? `<ol>${ranked.slice(0,20).map(({row,score,profit}) =>
      `<li>${escape(row.name)} · ${escape(row.variant)} · ${row.market} · ${score.toFixed(1)}/100
      · Estimated price ${(row.revenue / 100).toFixed(2)} ${markets[row.market]}
      · Estimated contribution ${(profit / 100).toFixed(2)} ${markets[row.market]}
      · <a href="${escape(row.source)}" rel="noreferrer">Evidence</a></li>`).join('')}</ol>` : '<p>No qualifying candidates.</p>'}</section>
    <h2>Candidates</h2>${cards || '<p>No candidates yet.</p>'}
    ` : ''}
    ${path === '/admin/engine' ? `<section><h2>Store catalog</h2>
    <p>${shop ? 'Manage approved products and Shopify handoff.' : 'Set SHOPIFY_SHOP to enable storefront listing controls.'}</p>
    ${cards || '<p>Approve a candidate in Scout to bring it into the catalog.</p>'}</section>` : ''}
    ${path === '/admin/connections' ? automationWorkspace(db) : ''}
    ${path === '/admin/discovery' ? discoveryWorkspace(db) : ''}
    ${path === '/admin/performance' ? performanceWorkspace(db,shop) : ''}
    ${path === '/admin/intelligence' ? intelligenceWorkspace(db) : ''}
    ${path === '/admin/evidence' ? evidenceWorkspace(db) : ''}
    ${path === '/admin/launch' ? launchWorkspace(db) : ''}
    ${path === '/admin/shopify' ? shopifyCatalogWorkspace(db, shop, Boolean(shop && shopToken)) : ''}
    ${path === '/admin/fulfillment' ? fulfillmentWorkspace(db, shop) : ''}
    ${path === '/admin/dispatch' ? dispatchWorkspace(db, shop) : ''}
    ${path === '/admin/suppliers' ? supplierHealthWorkspace(db) : ''}
    ${path === '/admin/printify' ? printifyCatalogWorkspace(db) : ''}
    ${path === '/admin/cj' ? cjCatalogWorkspace(db) : ''}
    ${path === '/admin/shipping' ? shippingEvidenceWorkspace(db) : ''}
    ${path === '/admin/supply' ? `${operations(rows)}
    <section><h2>Shopify paid orders</h2>
    <p>Recent paid-order notifications. Fulfillment assignment is a separate step.</p>
    <ul>${paidOrders.map(order => `<li>${escape(order.order_gid)} · ${order.line_count} lines</li>`).join('')}</ul>
    </section>
    <section><h2>Provider workspace</h2><div class="grid">${Object.entries(providers).map(([name, role]) =>
      `<div><strong>${name}</strong><p>${role}<br><small>Awaiting verified connection</small></p></div>`).join('')}</div></section>` : ''}
    </main></html>`;
}

async function readBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function refreshDailyIntelligence() {
  const latest=db.prepare('SELECT ran_at FROM intelligence_runs ORDER BY rowid DESC LIMIT 1').get();
  if (!latest || Date.now()-Date.parse(latest.ran_at)>=86400000) runIntelligence(db);
}
refreshDailyIntelligence();
let automationRunning=false;
async function automationTick(){
 if(automationRunning)return;automationRunning=true;
 try {
  if(process.env.TRADELENS_AUTOMATION==='1') await runAutomation(db);
  else refreshDailyIntelligence();
 } catch { console.error('Automation cycle failed; inspect Live connections.'); }
 finally {automationRunning=false;}
}
setInterval(automationTick,60000).unref();

const server=createServer(async (request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https://cdn.shopify.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'GET' && request.url === '/health') return response.end('ok');
  if (request.method === 'POST' && request.url === '/shopify/webhooks/orders-paid') {
    try { return await receivePaidOrder(request, response); } catch {
      response.statusCode = 500;
      return response.end('Webhook processing failed.');
    }
  }
  const storeUrl = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && ['/', '/store'].includes(storeUrl.pathname)) {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const demo = process.env.TRADELENS_DEMO === '1';
    const listings = demo ? [] : db.prepare(
      'SELECT l.*, c.name, c.variant, c.revenue, c.market FROM store_listings l JOIN candidates c ON c.id=l.candidate_id WHERE l.shop=? AND c.approved IS NOT NULL ORDER BY c.name'
    ).all(shop || '').map(item => ({...item, currency: markets[item.market]}));
    return response.end(renderCommerce({url:storeUrl, listings, demo}));
  }
  const expected = 'Basic ' + Buffer.from('admin:' + password).toString('base64');
  if (password && !timingSafeEqual(digest(request.headers.authorization || ''), digest(expected))) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TradeLens", charset="UTF-8"' });
    return response.end('Sign in as admin.');
  }
  try {
    if (request.method === 'GET' && Object.hasOwn(workspaces, request.url)) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end(page(request.url));
    }
    if (request.method !== 'POST' || !['/live/discover','/live/promote','/live/freight','/live/sales','/live/ads','/live/ad-map','/live/cycle','/live/alerts','/intelligence/briefing','/intelligence/run','/intelligence/signal','/intelligence/performance','/intelligence/ack','/candidates','/approve','/leads','/catalog','/orders','/tracking','/shopify/draft','/scout/assessment','/scout/validation','/store/listing','/research/evidence','/research/supplier-review','/launch/scenario','/shopify/catalog-sync','/fulfillment/stage','/dispatch/preview','/suppliers/check','/printify/sync','/cj/sync','/shipping/evidence'].includes(request.url)) {
      response.statusCode = 404;
      return response.end('Not found');
    }
    const codespaceOrigin = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
      ? 'https://' + process.env.CODESPACE_NAME + '-' + (process.env.PORT || '3000') + '.' + process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
      : null;
    const origin = process.env.TRADELENS_ORIGIN || codespaceOrigin || 'http://' + request.headers.host;
    if (request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      response.statusCode = 403;
      return response.end('Submit the form from the dashboard.');
    }
    const raw = await readBody(request, 16000);
    if (!raw) {
      response.statusCode = 413;
      return response.end('Form too large.');
    }
    const form = new URLSearchParams(raw.toString());
    if (request.url === '/candidates') {
      const market = required(form, 'market', 2);
      const source = new URL(required(form, 'source', 2048));
      if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) throw new Error('Use an HTTP or HTTPS evidence URL.');
      if (!Object.hasOwn(markets, market)) throw new Error('Choose a supported market.');
      const amounts = Object.keys(fields).map(key => money(form.get(key)));
      if (amounts[0] <= 0) throw new Error('Revenue must be positive.');
      db.prepare(`INSERT INTO candidates
        (id,name,variant,market,evidence,source,created,revenue,supplier,shipping,duties,fees,acquisition,losses)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), required(form,'name',120), required(form,'variant',120),
          market, required(form,'evidence',1200), source.href, new Date().toISOString(), ...amounts);
    } else if (request.url === '/approve') {
      const id = required(form, 'id', 36);
      const result = db.prepare('UPDATE candidates SET approved=COALESCE(approved, ?) WHERE id=?').run(new Date().toISOString(), id);
      if (!result.changes) {
        response.statusCode = 404;
        return response.end('Candidate not found.');
      }
    }
    if (request.url === '/live/discover') await discoverCj(db);
    else if (request.url === '/live/promote') promoteDiscovery(db,form);
    else if (request.url === '/live/freight') await quoteCjFreight(db,form);
    else if (request.url === '/live/sales') await syncStorePerformance(db);
    else if (request.url === '/live/ads') await syncAdvertising(db);
    else if (request.url === '/live/ad-map') mapAdvertising(db,form);
    else if (request.url === '/live/cycle') await runAutomation(db,{force:true});
    else if (request.url === '/live/alerts') await deliverAlerts(db);
    else if (request.url === '/intelligence/briefing') await generateBriefing(db);
    else if (request.url === '/intelligence/run') runIntelligence(db);
    else if (request.url === '/intelligence/ack') db.prepare('UPDATE intelligence_alerts SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?').run(new Date().toISOString(),required(form,'alert_id',36));
    else if (['/intelligence/signal','/intelligence/performance'].includes(request.url)) saveIntelligence(db,request.url,form);
    else if (request.url === '/shopify/draft') await createDraft(required(form, 'id', 36));
    else if (request.url === '/store/listing') updateListing(form);
    else if (request.url.startsWith('/scout/')) recordScout(request.url, form);
    else if (request.url.startsWith('/research/')) recordEvidence(db, request.url, form);
    else if (request.url === '/launch/scenario') saveLaunchScenario(db, form);
    else if (request.url === '/shopify/catalog-sync') await syncShopifyCatalog(db,{shop,token:shopToken});
    else if (request.url === '/fulfillment/stage') stageFulfillment(db,form,shop);
    else if (request.url === '/dispatch/preview') previewSupplierDispatch(db,form,shop);
    else if (request.url === '/suppliers/check') await checkSupplierConnection(db,form);
    else if (request.url === '/printify/sync') await syncPrintifyCatalog(db,form);
    else if (request.url === '/cj/sync') await syncCjCatalog(db);
    else if (request.url === '/shipping/evidence') saveShippingEvidence(db,form);
    else if (!['/candidates', '/approve'].includes(request.url)) saveOperation(request.url, form);
    const destination = ['/live/discover','/live/promote','/live/freight'].includes(request.url) ? '/admin/discovery' : ['/live/sales','/live/ads','/live/ad-map'].includes(request.url) ? '/admin/performance' : request.url.startsWith('/live/') ? '/admin/connections' : request.url.startsWith('/intelligence/') ? '/admin/intelligence' : request.url === '/shipping/evidence' ? '/admin/shipping' : request.url === '/cj/sync' ? '/admin/cj' : request.url === '/printify/sync' ? '/admin/printify' : request.url === '/suppliers/check' ? '/admin/suppliers' : request.url === '/dispatch/preview' ? '/admin/dispatch' : request.url === '/fulfillment/stage' ? '/admin/fulfillment' : request.url === '/shopify/catalog-sync' ? '/admin/shopify' : request.url === '/launch/scenario' ? '/admin/launch' : request.url.startsWith('/research/') ? '/admin/evidence' : ['/shopify/draft', '/store/listing'].includes(request.url) ? '/admin/engine'
      : ['/leads', '/catalog', '/orders', '/tracking'].includes(request.url) ? '/admin/supply' : '/admin';
    response.writeHead(303, { Location: destination });
    response.end();
  } catch (error) {
    const databaseError = error.code?.startsWith('ERR_SQLITE');
    response.statusCode = databaseError ? 500 : 400;
    response.end(databaseError ? 'Storage error.' : error.message);
  }
}).listen(Number(process.env.PORT || 3000), host,()=>{console.log('TradeLens listening on http://'+host+':'+server.address().port);});
