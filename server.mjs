import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
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

function page() {
  const rows = db.prepare('SELECT * FROM candidates ORDER BY created DESC').all();
  const cards = rows.map(row => {
    const breakEven = row.revenue - row.supplier - row.shipping - row.duties - row.fees - row.losses;
    const contribution = breakEven - row.acquisition;
    const currency = row.market === 'US' ? 'USD' : 'GBP';
    const format = cents => new Intl.NumberFormat('en', { style:'currency', currency }).format(cents / 100);
    return `<article><small>${row.market} · ${escape(row.variant)} · Analyst estimate</small>
      <h3>${escape(row.name)}</h3><p>${escape(row.evidence)}</p>
      <p><a href="${escape(row.source)}" rel="noreferrer">Evidence source</a> · ${escape(row.created.slice(0,10))}</p>
      <p>Estimated contribution <strong>${format(contribution)}</strong> · Margin ${(contribution / row.revenue * 100).toFixed(1)}%</p>
      <p>Break-even acquisition cost ${format(breakEven)}</p>
      ${row.approved ? '<strong>Approved for handoff</strong>' : `<form method="post" action="/approve"><input type="hidden" name="id" value="${row.id}"><button>Approve for handoff</button></form>`}
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
    <section><h2>Add candidate</h2><p>Use USD for US and GBP for UK. Enter per-order amounts and cite your supporting evidence.</p>
    <form method="post" action="/candidates"><div class="grid">
    <label>Product<input name="name" required maxlength="120"></label>
    <label>Variant<input name="variant" required maxlength="120"></label>
    <label>Market<select name="market"><option>US</option><option>UK</option></select></label>
    <label>Source URL<input type="url" name="source" required></label>
    ${Object.entries(fields).map(([key,label]) => `<label>${label}<input name="${key}" inputmode="decimal" required></label>`).join('')}
    <label>Evidence notes<textarea name="evidence" required maxlength="1200"></textarea></label></div><button>Save candidate</button></form></section>
    <h2>Candidates</h2>${cards || '<p>No candidates yet.</p>'}
    ${operations(rows)}
    <section><h2>Provider workspace</h2><div class="grid">${Object.entries(providers).map(([name, role]) =>
      `<div><strong>${name}</strong><p>${role}<br><small>Awaiting verified connection</small></p></div>`).join('')}</div></section>
    </main></html>`;
}

async function readForm(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16000) return null;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

createServer(async (request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'GET' && request.url === '/health') return response.end('ok');
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
    if (request.method !== 'POST' || !['/candidates','/approve','/leads','/catalog','/orders','/tracking'].includes(request.url)) {
      response.statusCode = 404;
      return response.end('Not found');
    }
    const origin = process.env.TRADELENS_ORIGIN || 'http://' + request.headers.host;
    if (request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      response.statusCode = 403;
      return response.end('Submit the form from the dashboard.');
    }
    const form = await readForm(request);
    if (!form) {
      response.statusCode = 413;
      return response.end('Form too large.');
    }
    if (request.url === '/candidates') {
      const market = required(form, 'market', 2);
      const source = new URL(required(form, 'source', 2048));
      if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) throw new Error('Use an HTTP or HTTPS evidence URL.');
      if (!['US','UK'].includes(market)) throw new Error('Choose US or UK.');
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
    if (!['/candidates', '/approve'].includes(request.url)) saveOperation(request.url, form);
    response.writeHead(303, { Location: '/' });
    response.end();
  } catch (error) {
    const databaseError = error.code?.startsWith('ERR_SQLITE');
    response.statusCode = databaseError ? 500 : 400;
    response.end(databaseError ? 'Storage error.' : error.message);
  }
}).listen(Number(process.env.PORT || 3000), host);
