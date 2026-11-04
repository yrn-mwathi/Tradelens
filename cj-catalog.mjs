const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
export function initializeCjCatalog(db){
 db.exec(`CREATE TABLE IF NOT EXISTS cj_catalog_snapshot(
 product_id TEXT NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL,
 price_text TEXT NOT NULL, fetched_at TEXT NOT NULL,
 PRIMARY KEY(product_id,sku)
 );`);
}
export async function syncCjCatalog(db){
 const token=process.env.CJ_ACCESS_TOKEN;
 if(!token)throw new Error('Set CJ_ACCESS_TOKEN first.');
 const rows=[];
 for(let page=1;page<=10;page++){
  const url='https://developers.cjdropshipping.com/api2.0/v1/product/list?pageNum='+page+'&pageSize=100';
  const response=await fetch(url,{headers:{'CJ-Access-Token':token},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('CJ catalog returned HTTP '+response.status);
  const body=await response.json();
  if(body.code!==200&&body.code!=='200')throw new Error('CJ catalog request rejected.');
  const data=body.data;
  const products=Array.isArray(data?.list)?data.list:Array.isArray(data)?data:null;
  if(!products)throw new Error('Unexpected CJ catalog response; existing snapshot unchanged.');
  for(const p of products){
   const productId=String(p.pid||p.id||'');
   const sku=String(p.productSku||p.sku||'').trim();
   if(!productId||!sku)continue;
   rows.push([productId,sku,String(p.productNameEn||p.productName||'').slice(0,240),String(p.sellPrice||p.productPrice||'').slice(0,60),new Date().toISOString()]);
  }
  if(products.length<100)break;
  if(page===10)throw new Error('CJ catalog exceeds 1000-product safety limit; existing snapshot unchanged.');
 }
 db.exec('BEGIN');
 try{
  db.exec('DELETE FROM cj_catalog_snapshot');
  const insert=db.prepare('INSERT OR REPLACE INTO cj_catalog_snapshot VALUES(?,?,?,?,?)');
  for(const row of rows)insert.run(...row);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return rows.length;
}
export function cjCatalogWorkspace(db){
 const rows=db.prepare('SELECT * FROM cj_catalog_snapshot ORDER BY name LIMIT 150').all();
 const matches=db.prepare(`SELECT c.name,m.sku,(SELECT COUNT(*) FROM cj_catalog_snapshot s WHERE s.sku=m.sku AND s.fetched_at>=?) AS matching
 FROM catalog_mappings m JOIN candidates c ON c.id=m.candidate_id WHERE m.provider='CJDropshipping' ORDER BY c.name`).all(new Date(Date.now()-86400000).toISOString());
 return '<section><h2>CJ Dropshipping catalog</h2><p>Read-only CJ product list snapshot, not a live stock guarantee. Supplier prices are unverified text and do not automatically update profitability. Refresh before supplier review.</p><form method="post" action="/cj/sync"><button>Sync CJ product list</button></form><h3>Mapping checks</h3><div class="grid">'+matches.map(m=>'<article><strong>'+esc(m.name)+'</strong><p>SKU '+esc(m.sku)+' · '+(m.matching===1?'Fresh catalog match':m.matching>1?'Ambiguous matches':'No fresh match')+'</p></article>').join('')+'</div><h3>Catalog</h3><div class="grid">'+rows.map(p=>'<article><strong>'+esc(p.name)+'</strong><p>SKU '+esc(p.sku)+' · Price '+esc(p.price_text)+'</p><small>'+esc(p.fetched_at)+'</small></article>').join('')+'</div></section>';
}
