const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function initializeShopifyCatalog(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS shopify_catalog_snapshot(
 shop TEXT NOT NULL, product_gid TEXT NOT NULL, variant_gid TEXT NOT NULL,
 title TEXT NOT NULL, variant_title TEXT NOT NULL, handle TEXT NOT NULL,
 status TEXT NOT NULL, sku TEXT, price TEXT NOT NULL, inventory INTEGER,
 image_url TEXT, synced_at TEXT NOT NULL,
 PRIMARY KEY(shop,variant_gid)
 );`);
}
const query = `query TradeLensCatalog($cursor: String) {
 products(first: 50, after: $cursor, sortKey: UPDATED_AT) {
  pageInfo { hasNextPage endCursor }
  nodes {
   id title handle status featuredImage { url }
   variants(first: 50) {
    pageInfo { hasNextPage }
    nodes { id title sku price inventoryQuantity }
   }
  }
 }
}`;
export async function syncShopifyCatalog(db,{shop,token}){
 if(!shop||!token)throw new Error('Configure Shopify store and Admin API token first.');
 if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))throw new Error('Invalid Shopify shop domain.');
 const rows=[];let cursor=null;
 for(let page=0;page<5;page++){
  const response=await fetch('https://'+shop+'/admin/api/2026-10/graphql.json',{
   method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},
   body:JSON.stringify({query,variables:{cursor}})
  });
  if(!response.ok)throw new Error('Shopify catalog request failed (HTTP '+response.status+').');
  const body=await response.json();
  if(body.errors?.length || body.data?.products==null)throw new Error('Shopify returned a catalog API error; verify read_products scope.');
  for(const product of body.data.products.nodes||[]){
   if(product.variants?.pageInfo?.hasNextPage)throw new Error('A product has more than 50 variants; full variant pagination is required before synchronization.');
   for(const variant of product.variants?.nodes||[]){
    if(!/^gid:\/\/shopify\/Product\/\d+$/.test(product.id)||!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant.id))throw new Error('Invalid Shopify product identifier.');
    rows.push([shop,product.id,variant.id,product.title,variant.title,product.handle,product.status,variant.sku||null,String(variant.price),variant.inventoryQuantity??null,product.featuredImage?.url||null,new Date().toISOString()]);
   }
  }
  if(!body.data.products.pageInfo.hasNextPage){
   db.exec('BEGIN');
   try{
    const insert=db.prepare('INSERT INTO shopify_catalog_snapshot VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    db.prepare('DELETE FROM shopify_catalog_snapshot WHERE shop=?').run(shop);
    for(const row of rows)insert.run(...row);
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   return rows.length;
  }
  cursor=body.data.products.pageInfo.endCursor;
  if(!cursor)throw new Error('Shopify pagination cursor missing.');
 }
 throw new Error('Catalog exceeds the current 250-product sync limit. No snapshot was changed.');
}
export function shopifyCatalogWorkspace(db,shop,connected){
 const rows=db.prepare('SELECT * FROM shopify_catalog_snapshot WHERE shop=? ORDER BY title,variant_title LIMIT 250').all(shop||'');
 const updated=rows[0]?.synced_at;
 return '<section><h2>Shopify catalog snapshot</h2><p>Read-only import of real Shopify product variants. This does not publish products to TradeLens or submit fulfillment orders. Snapshot may be stale; verify stock in Shopify before accepting orders.</p>'+
 '<p>Connection: '+(connected?'Configured (not independently verified)':'Not configured')+' · Variants cached: '+rows.length+(updated?' · Last successful sync: '+esc(updated):'')+'</p>'+
 (connected?'<form method="post" action="/shopify/catalog-sync"><button>Sync Shopify catalog (up to 250 products)</button></form>':'<p>Set SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN with read_products access.</p>')+
 '<div class="grid">'+rows.map(r=>'<article><h3>'+esc(r.title)+'</h3><p>'+esc(r.variant_title)+' · '+esc(r.status)+' · SKU '+esc(r.sku||'not set')+'</p><p>Shopify price: '+esc(r.price)+' (shop currency) · Reported inventory: '+esc(r.inventory??'not tracked')+'</p><p><a target="_blank" rel="noopener noreferrer" href="https://'+esc(shop)+'/products/'+esc(r.handle)+'">Shopify product URL (may be unpublished)</a></p></article>').join('')+'</div></section>';
}
