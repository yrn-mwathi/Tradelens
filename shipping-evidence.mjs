const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function initializeShippingEvidence(db){
 db.exec(`CREATE TABLE IF NOT EXISTS supplier_shipping_evidence(
 candidate_id TEXT NOT NULL REFERENCES candidates(id),
 destination TEXT NOT NULL CHECK(destination IN ('US','UK')),
 provider TEXT NOT NULL CHECK(provider IN ('Printify','CJDropshipping')),
 supplier_sku TEXT NOT NULL, currency TEXT NOT NULL,
 shipping_cents INTEGER NOT NULL CHECK(shipping_cents>=0),
 transit_min_days INTEGER NOT NULL CHECK(transit_min_days>0),
 transit_max_days INTEGER NOT NULL CHECK(transit_max_days>=transit_min_days),
 source_url TEXT NOT NULL, verified_at TEXT NOT NULL,
 PRIMARY KEY(candidate_id,destination,provider)
 );`);
}
export function saveShippingEvidence(db,form){
 const candidate=String(form.get('candidate_id')||'');
 const destination=String(form.get('destination')||'');
 if(!['US','UK'].includes(destination))throw new Error('Choose US or UK.');
 const mapping=db.prepare('SELECT * FROM catalog_mappings WHERE candidate_id=?').get(candidate);
 if(!mapping||!['Printify','CJDropshipping'].includes(mapping.provider))throw new Error('Choose a candidate mapped to CJ or Printify.');
 const currency=String(form.get('currency')||'');
 if(currency!==(destination==='US'?'USD':'GBP'))throw new Error('Quote must be converted into destination currency using a documented exchange rate.');
 const amount=String(form.get('shipping')||'');
 if(!/^\d{1,7}(?:\.\d{1,2})?$/.test(amount))throw new Error('Enter a valid shipping amount.');
 const cents=Math.round(Number(amount)*100);
 const min=Number(form.get('transit_min_days')),max=Number(form.get('transit_max_days'));
 if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min<1||max<min||max>180)throw new Error('Transit days must be between 1 and 180.');
 let url;try{url=new URL(String(form.get('source_url')||''));}catch{throw new Error('Provide a valid HTTPS quote URL.');}
 if(url.protocol!=='https:'||url.username||url.password||!url.hostname.includes('.'))throw new Error('Provide a public HTTPS quote URL.');
 db.prepare(`INSERT INTO supplier_shipping_evidence VALUES(?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(candidate_id,destination,provider) DO UPDATE SET
 supplier_sku=excluded.supplier_sku,currency=excluded.currency,shipping_cents=excluded.shipping_cents,
 transit_min_days=excluded.transit_min_days,transit_max_days=excluded.transit_max_days,
 source_url=excluded.source_url,verified_at=excluded.verified_at`).run(candidate,destination,mapping.provider,mapping.sku,currency,cents,min,max,url.href,new Date().toISOString());
}
export function shippingEvidenceWorkspace(db){
 const candidates=db.prepare(`SELECT c.id,c.name,m.provider,m.sku FROM candidates c JOIN catalog_mappings m ON m.candidate_id=c.id WHERE m.provider IN ('Printify','CJDropshipping') ORDER BY c.name`).all();
 const quotes=db.prepare(`SELECT e.*,c.name FROM supplier_shipping_evidence e JOIN candidates c ON c.id=e.candidate_id ORDER BY e.verified_at DESC LIMIT 100`).all();
 return '<section><h2>US / UK supplier shipping evidence</h2><p>Record documented supplier shipping quotes and delivery windows. Entries are manual evidence, not live API quotes. Use destination currency (USD for US, GBP for UK); record FX conversion in the evidence source. Quotes older than 7 days or with changed supplier SKU require refresh.</p>'+
 (candidates.length?'<form method="post" action="/shipping/evidence"><div class="grid"><label>Mapped product<select name="candidate_id">'+candidates.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+' · '+esc(c.provider)+' · '+esc(c.sku)+'</option>').join('')+'</select></label><label>Destination<select name="destination"><option>US</option><option>UK</option></select></label><label>Currency<select name="currency"><option>USD</option><option>GBP</option></select></label><label>Shipping cost<input name="shipping" type="number" min="0" step="0.01" required></label><label>Minimum transit days<input name="transit_min_days" type="number" min="1" max="180" required></label><label>Maximum transit days<input name="transit_max_days" type="number" min="1" max="180" required></label><label>Supplier quote evidence URL<input name="source_url" type="url" required></label></div><button>Save shipping evidence</button></form>':'<p>Create a CJ or Printify catalog mapping first.</p>')+
 '<h3>Quote evidence</h3><div class="grid">'+quotes.map(q=>'<article><strong>'+esc(q.name)+' · '+esc(q.destination)+'</strong><p>'+esc(q.provider)+' · SKU '+esc(q.supplier_sku)+'</p><p>'+esc(q.currency)+' '+(q.shipping_cents/100).toFixed(2)+' · '+q.transit_min_days+'–'+q.transit_max_days+' days</p><p>Recorded '+esc(q.verified_at.slice(0,10))+'</p><a href="'+esc(q.source_url)+'" target="_blank" rel="noopener noreferrer">Quote evidence</a></article>').join('')+'</div></section>';
}
