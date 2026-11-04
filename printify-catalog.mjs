const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
export function initializeSupplierCatalog(db){
 db.exec(`CREATE TABLE IF NOT EXISTS printify_catalog_snapshot(
 shop_id TEXT NOT NULL, product_id TEXT NOT NULL, title TEXT NOT NULL,
 variant_id TEXT NOT NULL, sku TEXT NOT NULL, price_cents INTEGER NOT NULL,
 enabled INTEGER NOT NULL, available INTEGER NOT NULL, fetched_at TEXT NOT NULL,
 PRIMARY KEY(shop_id,product_id,variant_id)
 );`);
}
async function getJson(path,token){
 const response=await fetch('https://api.printify.com/v1/'+path,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('Printify catalog returned HTTP '+response.status);
 return response.json();
}
export async function syncPrintifyCatalog(db,form){
 const token=process.env.PRINTIFY_API_TOKEN;
 if(!token)throw new Error('Set PRINTIFY_API_TOKEN first.');
 const shopId=String(form.get('shop_id')||'');
 if(!/^\d{1,20}$/.test(shopId))throw new Error('Choose a valid Printify shop ID.');
 const shops=await getJson('shops.json',token);
 if(!Array.isArray(shops)||!shops.some(s=>String(s.id)===shopId))throw new Error('Shop is not accessible with this token.');
 let page=1,rows=[],total=0;
 while(page<=20){
  const data=await getJson('shops/'+shopId+'/products.json?limit=50&page='+page,token);
  if(!Array.isArray(data.data))throw new Error('Unexpected Printify catalog response.');
  for(const product of data.data){
   const productId=String(product.id||'');
   if(!productId||!Array.isArray(product.variants))continue;
   for(const variant of product.variants){
    const variantId=String(variant.id||'');
    const sku=String(variant.sku||'').trim();
    const price=variant.price;
    if(!variantId||!sku||!Number.isSafeInteger(price)||price<0)continue;
    rows.push([shopId,productId,String(product.title||'').slice(0,240),variantId,sku,price,variant.is_enabled?1:0,variant.is_available?1:0,new Date().toISOString()]);
   }
  }
  total=Number(data.last_page||data.total_pages||1);
  if(!Number.isSafeInteger(total)||total>20)throw new Error('Catalog exceeds 20-page safety limit; existing snapshot unchanged.');
  if(page>=total)break;
  page++;
 }
 db.exec('BEGIN');
 try{
  db.prepare('DELETE FROM printify_catalog_snapshot WHERE shop_id=?').run(shopId);
  const insert=db.prepare('INSERT INTO printify_catalog_snapshot VALUES(?,?,?,?,?,?,?,?,?)');
  for(const row of rows)insert.run(...row);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return rows.length;
}
export function printifyCatalogWorkspace(db){
 const rows=db.prepare('SELECT * FROM printify_catalog_snapshot ORDER BY fetched_at DESC,title LIMIT 150').all();
 const counts=db.prepare('SELECT shop_id,COUNT(*) AS variants,MAX(fetched_at) AS fetched_at FROM printify_catalog_snapshot GROUP BY shop_id').all();
 return '<section><h2>Printify catalog snapshot</h2><p>Read-only catalog import. SKU, listed price, enabled and availability flags are supplier-provided snapshots; they are not guaranteed live inventory or landed cost. A shop ID must belong to your authenticated Printify account.</p><form method="post" action="/printify/sync"><label>Printify shop ID<input name="shop_id" required pattern="[0-9]+" placeholder="Shop ID from Printify" /></label><button>Import catalog (read-only)</button></form><p>'+counts.map(x=>'Shop '+esc(x.shop_id)+': '+x.variants+' variants, last '+esc(x.fetched_at)).join(' · ')+'</p><div class="grid">'+rows.map(x=>'<article><strong>'+esc(x.title)+'</strong><p>SKU '+esc(x.sku)+' · Variant '+esc(x.variant_id)+'</p><p>Price '+(x.price_cents/100).toFixed(2)+' (shop currency) · '+(x.enabled?'Enabled':'Disabled')+' · '+(x.available?'Available':'Unavailable')+'</p></article>').join('')+'</div></section>';
}
