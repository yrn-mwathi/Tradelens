import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const password = process.env.TRADELENS_PASSWORD;
const host = process.env.HOST || '127.0.0.1';
if (host !== '127.0.0.1' && (!password || password.length < 20)) {
  throw new Error('Set TRADELENS_PASSWORD to at least 20 characters before binding externally.');
}
const db = new DatabaseSync(process.env.TRADELENS_DB || 'tradelens.sqlite');
db.exec(`CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, variant TEXT NOT NULL, market TEXT NOT NULL,
  evidence TEXT NOT NULL, source TEXT NOT NULL, created TEXT NOT NULL,
  revenue INTEGER NOT NULL, supplier INTEGER NOT NULL, shipping INTEGER NOT NULL,
  duties INTEGER NOT NULL, fees INTEGER NOT NULL, acquisition INTEGER NOT NULL, losses INTEGER NOT NULL,
  approved TEXT
)`);

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
const shopToken = process.env.SHOPIFY_ADMIN_TOKEN;
const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
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
  db.prepare('INSERT OR IGNORE INTO shopify_paid_orders VALUES (?,?,?)')
    .run(shop, order.admin_graphql_api_id, order.line_items.length);
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
    db.prepare(`INSERT INTO scout_validations VALUES (?,?,?,?,?)
      ON CONFLICT(candidate_id,badge) DO UPDATE SET reviewer=excluded.reviewer,
      evidence=excluded.evidence, recorded=excluded.recorded`)
      .run(id, badge, required(form, 'reviewer', 120), evidence, recorded);
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
    <label>Reviewer or sample tester<input name="reviewer" maxlength="120" required></label>
    <label>Evidence and results (include sample test date for physical testing)<textarea name="evidence" maxlength="1200" required></textarea></label></div>
    <button>Confirm validation</button></form></details>`;
}

function page() {
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
  const cards = rows.map(row => {
    const draft = drafts.get(row.id);
    const shopify = draft?.product_gid ? '<p>Shopify draft: ' + escape(draft.product_gid) + '</p>'
      : draft ? '<p>Draft request pending or needs review. Search Shopify for tradelens-' + row.id + '.</p>'
      : row.approved && shop && shopToken ? `<form method="post" action="/shopify/draft">
      <input type="hidden" name="id" value="${row.id}"><button>Create Shopify draft</button></form>` : '';
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
      ${shopify}
      ${scout(row, assessments.get(row.id), badges.filter(badge => badge.candidate_id === row.id))}
    </article>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>TradeLens</title><style>
    *{box-sizing:border-box}body{margin:0;background:#101827;color:#eef3ff;font:16px system-ui}main{max-width:1060px;margin:auto;padding:32px 20px}
    header,section,article{margin-bottom:20px}section,article{background:#192438;border:1px solid #34425b;border-radius:14px;padding:20px}
    h1{font-size:48px;margin:8px 0}small,a{color:#82e6d4}p{line-height:1.5}label{display:grid;gap:5px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(225px,1fr));gap:14px}
    input,select,textarea,button{font:inherit;border-radius:7px;padding:10px;border:1px solid #50627e}
    input,select,textarea{width:100%;background:#111b2c;color:#fff}button{background:#82e6d4;color:#102128;cursor:pointer;font-weight:700;margin-top:12px}
    </style><main><header><small>ACL SMART SOLUTIONS LTD</small><h1>TradeLens</h1><p>Product research and approval workspace</p></header>
    <section><h2>Add candidate</h2><p>Use USD for US, GBP for UK, KES for Kenya and NGN for Nigeria. Enter per-order amounts and cite your supporting evidence.</p>
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
    ${operations(rows)}
    <section><h2>Shopify paid orders</h2>
    <p>Recent paid-order notifications. Fulfillment assignment is a separate step.</p>
    <ul>${paidOrders.map(order => `<li>${escape(order.order_gid)} · ${order.line_count} lines</li>`).join('')}</ul>
    </section>
    <section><h2>Provider workspace</h2><div class="grid">${Object.entries(providers).map(([name, role]) =>
      `<div><strong>${name}</strong><p>${role}<br><small>Awaiting verified connection</small></p></div>`).join('')}</div></section>
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

createServer(async (request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'GET' && request.url === '/health') return response.end('ok');
  if (request.method === 'POST' && request.url === '/shopify/webhooks/orders-paid') {
    try { return await receivePaidOrder(request, response); } catch {
      response.statusCode = 500;
      return response.end('Webhook processing failed.');
    }
  }
  const expected = 'Basic ' + Buffer.from('admin:' + password).toString('base64');
  if (password && !timingSafeEqual(digest(request.headers.authorization || ''), digest(expected))) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TradeLens", charset="UTF-8"' });
    return response.end('Sign in as admin.');
  }
  try {
    if (request.method === 'GET' && request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end(page());
    }
    if (request.method !== 'POST' || !['/candidates','/approve','/leads','/catalog','/orders','/tracking','/shopify/draft','/scout/assessment','/scout/validation'].includes(request.url)) {
      response.statusCode = 404;
      return response.end('Not found');
    }
    const origin = process.env.TRADELENS_ORIGIN || 'http://' + request.headers.host;
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
    if (request.url === '/shopify/draft') await createDraft(required(form, 'id', 36));
    else if (request.url.startsWith('/scout/')) recordScout(request.url, form);
    else if (!['/candidates', '/approve'].includes(request.url)) saveOperation(request.url, form);
    response.writeHead(303, { Location: '/' });
    response.end();
  } catch (error) {
    const databaseError = error.code?.startsWith('ERR_SQLITE');
    response.statusCode = databaseError ? 500 : 400;
    response.end(databaseError ? 'Storage error.' : error.message);
  }
}).listen(Number(process.env.PORT || 3000), host);
