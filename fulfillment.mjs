const esc = x => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
export function initializeFulfillment(db){
 db.exec(`CREATE TABLE IF NOT EXISTS shopify_paid_order_lines(shop TEXT NOT NULL, order_gid TEXT NOT NULL, line_id TEXT NOT NULL, variant_id TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(shop,order_gid,line_id));`);
 db.exec(`CREATE TABLE IF NOT EXISTS fulfillment_queue(
 id TEXT PRIMARY KEY, shop TEXT NOT NULL, order_gid TEXT NOT NULL,
 provider TEXT NOT NULL, candidate_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('needs_review','ready','blocked')),
 notes TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(shop,order_gid,provider,candidate_id)
 );`);
}
export function stageFulfillment(db,form,shop){
 if(!shop)throw new Error('Configure Shopify first.');
 const order=String(form.get('order_gid')||'');
 const candidate=String(form.get('candidate_id')||'');
 const provider=String(form.get('provider')||'');
 const notes=String(form.get('notes')||'').trim();
 if(!/^gid:\/\/shopify\/Order\/\d+$/.test(order))throw new Error('Choose a valid Shopify order.');
 if(!['CJDropshipping','Printify'].includes(provider))throw new Error('Choose CJ or Printify.');
 if(notes.length>1000)throw new Error('Notes exceed 1000 characters.');
 if(!db.prepare('SELECT 1 FROM shopify_paid_orders WHERE shop=? AND order_gid=?').get(shop,order))throw new Error('Order must be received from a verified Shopify paid-order webhook.');
 const row=db.prepare('SELECT 1 FROM candidates WHERE id=? AND approved IS NOT NULL').get(candidate);
 if(!row)throw new Error('Candidate must be approved.');
 const listing=db.prepare('SELECT variant_id FROM store_listings WHERE candidate_id=? AND shop=?').get(candidate,shop);
 if(!listing?.variant_id)throw new Error('Candidate needs a synchronized Shopify variant listing.');
 const matched=db.prepare('SELECT SUM(quantity) AS quantity FROM shopify_paid_order_lines WHERE shop=? AND order_gid=? AND variant_id=?').get(shop,order,listing.variant_id);
 if(!matched?.quantity)throw new Error('The verified paid order does not contain this candidate’s Shopify variant. Older orders must be reverified before staging.');
 const mapping=db.prepare('SELECT * FROM catalog_mappings WHERE candidate_id=?').get(candidate);
 if(!mapping||mapping.provider!==provider||mapping.stock<matched.quantity)throw new Error('Supplier mapping must have enough stock for the verified ordered quantity.');
 if(provider==='Printify'){
  const snapshot=db.prepare('SELECT * FROM printify_catalog_snapshot WHERE sku=? AND enabled=1 AND available=1 ORDER BY fetched_at DESC LIMIT 1').get(mapping.sku);
  if(!snapshot)throw new Error('Printify supplier SKU must appear as enabled and available in a synchronized catalog.');
  if(Date.now()-Date.parse(snapshot.fetched_at)>24*60*60*1000)throw new Error('Printify catalog evidence is older than 24 hours; synchronize again.');
 }
 db.prepare(`INSERT INTO fulfillment_queue VALUES(?,?,?,?,?,?,?,?)
 ON CONFLICT(shop,order_gid,provider,candidate_id) DO UPDATE SET notes=excluded.notes`).run(
 shop+'|'+order+'|'+provider+'|'+candidate,shop,order,provider,candidate,'needs_review',notes,new Date().toISOString());
}
export function fulfillmentWorkspace(db,shop){
 const orders=db.prepare('SELECT order_gid,line_count FROM shopify_paid_orders WHERE shop=? ORDER BY rowid DESC LIMIT 30').all(shop||'');
 const mappings=db.prepare(`SELECT m.candidate_id,m.provider,m.sku,m.stock,c.name
 FROM catalog_mappings m JOIN candidates c ON c.id=m.candidate_id
 WHERE c.approved IS NOT NULL AND m.provider IN ('CJDropshipping','Printify') ORDER BY c.name`).all();
 const queued=db.prepare('SELECT * FROM fulfillment_queue WHERE shop=? ORDER BY created_at DESC LIMIT 100').all(shop||'');
 return '<section><h2>Fulfillment review queue</h2><p>Manually stage a verified paid Shopify order for CJ or Printify review. This does NOT send an order to a supplier. A credentialed, idempotent connector and shipping validation are still required.</p>'+
 (orders.length&&mappings.length?'<form method="post" action="/fulfillment/stage"><label>Verified paid order<select name="order_gid">'+orders.map(o=>'<option value="'+esc(o.order_gid)+'">'+esc(o.order_gid)+' ('+o.line_count+' lines)</option>').join('')+'</select></label><label>Approved supplier mapping<select name="candidate_id" id="candidate_id">'+mappings.map(m=>'<option value="'+esc(m.candidate_id)+'">'+esc(m.name)+' · '+esc(m.provider)+' · SKU '+esc(m.sku)+' · stock '+m.stock+'</option>').join('')+'</select></label><label>Provider<select name="provider"><option>CJDropshipping</option><option>Printify</option></select></label><p>Choose the same provider as the mapping. Verify order line items and shipping address manually before staging.</p><label>Review notes<textarea name="notes" maxlength="1000"></textarea></label><button>Stage for manual review</button></form>':'<p>First receive a verified Shopify paid order and configure an approved CJ or Printify catalog mapping.</p>')+
 '<h3>Staged orders</h3><div class="grid">'+queued.map(q=>'<article><strong>'+esc(q.provider)+' · '+esc(q.status)+'</strong><p>'+esc(q.order_gid)+'</p><p>Candidate '+esc(q.candidate_id)+'</p><p>'+esc(q.notes)+'</p><small>'+esc(q.created_at)+'</small></article>').join('')+'</div></section>';
}
