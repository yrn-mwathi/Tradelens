const escape = x => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function initializeDispatch(db){
 db.exec(`CREATE TABLE IF NOT EXISTS supplier_dispatch_previews(
 queue_id TEXT PRIMARY KEY, provider TEXT NOT NULL, supplier_sku TEXT NOT NULL,
 variant_id TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0),
 payload TEXT NOT NULL, reviewed_at TEXT NOT NULL,
 FOREIGN KEY(queue_id) REFERENCES fulfillment_queue(id)
 );`);
}
export function previewSupplierDispatch(db,form,shop){
 const id=String(form.get('queue_id')||'');
 const q=db.prepare('SELECT * FROM fulfillment_queue WHERE id=? AND shop=?').get(id,shop);
 if(!q||q.status!=='needs_review')throw new Error('Choose an eligible fulfillment review item.');
 const mapping=db.prepare('SELECT * FROM catalog_mappings WHERE candidate_id=?').get(q.candidate_id);
 const listing=db.prepare('SELECT variant_id FROM store_listings WHERE candidate_id=? AND shop=?').get(q.candidate_id,shop);
 if(!mapping||!listing||mapping.provider!==q.provider)throw new Error('Supplier mapping changed. Review again.');
 const line=db.prepare('SELECT SUM(quantity) AS quantity FROM shopify_paid_order_lines WHERE shop=? AND order_gid=? AND variant_id=?').get(shop,q.order_gid,listing.variant_id);
 if(!line?.quantity||mapping.stock<line.quantity)throw new Error('Paid order quantity or supplier stock no longer validates.');
 const payload={provider:q.provider,external_reference:q.order_gid,supplier_sku:mapping.sku,quantity:line.quantity,shopify_variant_id:listing.variant_id,shipping_address:null,shipping_method:null,shipping_quote:null};
 db.prepare(`INSERT INTO supplier_dispatch_previews VALUES (?,?,?,?,?,?,?)
 ON CONFLICT(queue_id) DO UPDATE SET provider=excluded.provider,supplier_sku=excluded.supplier_sku,variant_id=excluded.variant_id,quantity=excluded.quantity,payload=excluded.payload,reviewed_at=excluded.reviewed_at`)
 .run(q.id,q.provider,mapping.sku,listing.variant_id,line.quantity,JSON.stringify(payload),new Date().toISOString());
}
export function dispatchWorkspace(db,shop){
 const queued=db.prepare(`SELECT q.id,q.provider,q.order_gid,q.status,p.payload,p.reviewed_at FROM fulfillment_queue q LEFT JOIN supplier_dispatch_previews p ON p.queue_id=q.id WHERE q.shop=? ORDER BY q.created_at DESC LIMIT 100`).all(shop||'');
 return '<section><h2>Supplier dispatch previews</h2><p>Review verified SKU and quantity before connecting a supplier API. Previews intentionally omit customer shipping details and cannot place orders. No payment or supplier API call is made.</p><div class="grid">'+queued.map(q=>'<article><h3>'+escape(q.provider)+'</h3><p>'+escape(q.order_gid)+'</p><p>Status: '+escape(q.status)+'</p>'+(q.payload?'<pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+escape(q.payload)+'</pre><small>Reviewed '+escape(q.reviewed_at)+'</small>':'<p>Not yet previewed</p>')+(q.status==='needs_review'?'<form method="post" action="/dispatch/preview"><input type="hidden" name="queue_id" value="'+escape(q.id)+'"><button>Revalidate and preview</button></form>':'')+'</article>').join('')+'</div></section>';
}
