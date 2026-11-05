import {randomUUID} from 'node:crypto';
import {cents,providerJSON,esc,requireText,transaction} from './provider-http.mjs';
const CJ='https://developers.cjdropshipping.com/api2.0/v1';
export function initializeDiscovery(db){db.exec(`
 CREATE TABLE IF NOT EXISTS discovery_inbox(provider TEXT NOT NULL,product_id TEXT NOT NULL,sku TEXT NOT NULL,name TEXT NOT NULL,price_text TEXT NOT NULL,currency TEXT NOT NULL,listed_count INTEGER,inventory INTEGER,category TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,source_url TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',candidate_id TEXT REFERENCES candidates(id),PRIMARY KEY(provider,product_id));
 CREATE TABLE IF NOT EXISTS provider_price_history(provider TEXT NOT NULL,product_id TEXT NOT NULL,price_text TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(provider,product_id,observed_at));
 CREATE TABLE IF NOT EXISTS cj_freight_quotes(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES candidates(id),variant_id TEXT NOT NULL,origin TEXT NOT NULL,destination TEXT NOT NULL,quantity INTEGER NOT NULL,currency TEXT NOT NULL,carrier TEXT NOT NULL,price INTEGER NOT NULL,taxes INTEGER,clearance INTEGER,transit TEXT NOT NULL,quoted_at TEXT NOT NULL);
 `);}
export function parseCjV2(body){
 if(Number(body.code)!==200||body.result===false||!Array.isArray(body.data?.content))throw new Error('Unexpected CJ V2 response. Previous data retained.');
 const products=[];
 for(const group of body.data.content){
  if(!Array.isArray(group.productList))throw new Error('CJ V2 productList missing.');
  for(const p of group.productList){
   if(typeof p.id!=='string'||!p.id||p.id.length>200||typeof p.nameEn!=='string'||!p.nameEn||typeof p.sku!=='string'||!p.sku)throw new Error('Invalid CJ product identifier, name or SKU.');
   const count=(x)=>Number.isSafeInteger(x)&&x>=0?x:null;
   // Preserve ranges/unknown prices as provider text; never infer a unit price from a range.
   products.push({id:p.id,sku:p.sku.slice(0,200),name:p.nameEn.slice(0,240),price:String(p.sellPrice??'').slice(0,60),listed:count(p.listedNum),inventory:count(p.warehouseInventoryNum),category:[p.oneCategoryName,p.twoCategoryName,p.threeCategoryName].filter(Boolean).join(' / ').slice(0,500)});
  }
 }
 return products;
}
export async function fetchCjPage({token=process.env.CJ_ACCESS_TOKEN,keyword='',page=1,size=50,trending=true,fetcher=fetch}={}){
 if(!token)throw new Error('Configure CJ_ACCESS_TOKEN.');
 if(!Number.isInteger(page)||page<1||page>1000||!Number.isInteger(size)||size<1||size>100)throw new Error('Invalid CJ page.');
 const url=new URL(CJ+'/product/listV2');url.search=new URLSearchParams({page:String(page),size:String(size),keyWord:keyword,...(trending?{productFlag:'0'}:{})});
 const body=await providerJSON(url.href,{headers:{'CJ-Access-Token':token}},fetcher);
 return {products:parseCjV2(body),totalPages:Number(body.data.totalPages)};
}
export async function discoverCj(db,{token=process.env.CJ_ACCESS_TOKEN,keywords=process.env.TRADELENS_DISCOVERY_KEYWORDS||'smart,charger,usb',fetcher=fetch,now=new Date()}={}){
 const terms=[...new Set(keywords.split(',').map(x=>x.trim()).filter(Boolean))];
 if(!terms.length||terms.length>5||terms.some(x=>x.length>100))throw new Error('Set one to five comma-separated discovery keywords, at most 100 characters each.');
 // Deliberately bounded discovery sample, not a claim to have scanned the entire catalog.
 const products=new Map();for(const keyword of terms){const result=await fetchCjPage({token,keyword,fetcher});for(const p of result.products)products.set(p.id,p);}
 transaction(db,()=>{
  const snapshot=db.prepare('INSERT OR REPLACE INTO cj_catalog_snapshot VALUES(?,?,?,?,?)');
  const inbox=db.prepare(`INSERT INTO discovery_inbox(provider,product_id,sku,name,price_text,currency,listed_count,inventory,category,first_seen,last_seen,source_url) VALUES('CJDropshipping',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,product_id) DO UPDATE SET sku=excluded.sku,name=excluded.name,price_text=excluded.price_text,listed_count=excluded.listed_count,inventory=excluded.inventory,category=excluded.category,last_seen=excluded.last_seen,source_url=excluded.source_url`);
  for(const p of products.values()){
   const source=CJ+'/product/query?pid='+encodeURIComponent(p.id),time=now.toISOString();
   inbox.run(p.id,p.sku,p.name,p.price,'USD',p.listed,p.inventory,p.category,time,time,source);snapshot.run(p.id,p.sku,p.name,p.price,time);
   db.prepare('INSERT OR IGNORE INTO provider_price_history VALUES(?,?,?,?)').run('CJDropshipping',p.id,p.price,time);
   const mapped=db.prepare("SELECT i.candidate_id,c.market FROM discovery_inbox i JOIN candidates c ON c.id=i.candidate_id WHERE i.provider='CJDropshipping' AND i.product_id=?").get(p.id);
   if(mapped?.market==='US' && /^\d+(?:\.\d{1,2})?$/.test(p.price)){
    db.prepare('INSERT INTO intelligence_signals VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),mapped.candidate_id,'supplier_price',Number(p.price),source,time,time,'CJ API product-level USD catalog price; exact variant not verified');
   }

  }
 });return products.size;
}
export function promoteDiscovery(db,form,now=new Date()){
 const id=requireText(form,'product_id',200),row=db.prepare("SELECT * FROM discovery_inbox WHERE provider='CJDropshipping' AND product_id=?").get(id);
 if(!row)throw new Error('Unknown discovered product.');
 if(row.candidate_id)throw new Error('Product already has a candidate.');
 if(form.get('decision')==='reject'){db.prepare("UPDATE discovery_inbox SET status='rejected' WHERE provider='CJDropshipping' AND product_id=?").run(id);return;}
 if(now.getTime()-Date.parse(row.last_seen)>86400000)throw new Error('Refresh discovery before creating a candidate.');
 if(requireText(form,'market',2)!=='US')throw new Error('CJ list prices are USD. Use Scout for UK candidates with documented GBP costs.');
 const amounts=['revenue','supplier','shipping','duties','fees','acquisition','losses'].map(k=>cents(requireText(form,k,20)));
 if(amounts[0]<=0)throw new Error('Selling price must be positive.');
 const evidence=requireText(form,'evidence',1200),variant=requireText(form,'variant',120),candidate=randomUUID();
 transaction(db,()=>{
  db.prepare('INSERT INTO candidates(id,name,variant,market,evidence,source,created,revenue,supplier,shipping,duties,fees,acquisition,losses) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(candidate,row.name,variant,'US',evidence,row.source_url,now.toISOString(),...amounts);
  db.prepare("UPDATE discovery_inbox SET candidate_id=?,status='candidate' WHERE provider='CJDropshipping' AND product_id=?").run(candidate,id);
  db.prepare('INSERT INTO research_evidence VALUES(?,?,?,?,?,?,?)').run(randomUUID(),candidate,'Product research','CJ official catalog API',row.source_url,'API catalog observation: listed count '+(row.listed_count??'unknown')+' represents merchant listings, NOT sales. Supplier product price text USD '+row.price_text+'. Costs entered by merchant require variant verification.',now.toISOString());
 });return candidate;
}
export async function quoteCjFreight(db,form,{token=process.env.CJ_ACCESS_TOKEN,fetcher=fetch,now=new Date()}={}){
 if(!token)throw new Error('Configure CJ_ACCESS_TOKEN.');
 const candidate=requireText(form,'candidate_id',36),variant=requireText(form,'variant_id',200),destination=requireText(form,'destination',2),origin=requireText(form,'origin',2);
 if(!db.prepare('SELECT id FROM candidates WHERE id=?').get(candidate))throw new Error('Unknown candidate.');
 if(!['US','GB'].includes(destination)||!['CN','US','GB'].includes(origin))throw new Error('Unsupported origin or destination.');
 // One unit to permit valid per-order comparison. API quotations do not validate the operator-entered variant mapping.
 const body=await providerJSON(CJ+'/logistic/freightCalculate',{method:'POST',headers:{'Content-Type':'application/json','CJ-Access-Token':token},body:JSON.stringify({startCountryCode:origin,endCountryCode:destination,products:[{quantity:1,vid:variant}]})},fetcher);
 if(Number(body.code)!==200||body.result===false||!Array.isArray(body.data)||body.data.length>100)throw new Error('CJ freight response invalid.');
 const rows=body.data.map(q=>({carrier:String(q.logisticName||'Unknown carrier').slice(0,200),price:cents(q.logisticPrice),taxes:q.taxesFee==null?null:cents(q.taxesFee),clearance:q.clearanceOperationFee==null?null:cents(q.clearanceOperationFee),transit:String(q.logisticAging??'Not supplied').slice(0,100)}));
 transaction(db,()=>{for(const q of rows)db.prepare('INSERT INTO cj_freight_quotes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),candidate,variant,origin,destination,1,'USD',q.carrier,q.price,q.taxes,q.clearance,q.transit,now.toISOString());});return rows.length;
}
export function discoveryWorkspace(db){
 const rows=db.prepare('SELECT * FROM discovery_inbox ORDER BY last_seen DESC LIMIT 100').all(),candidates=db.prepare('SELECT id,name FROM candidates ORDER BY name').all();
 const quotes=db.prepare('SELECT q.*,c.name FROM cj_freight_quotes q JOIN candidates c ON c.id=q.candidate_id ORDER BY q.rowid DESC LIMIT 100').all();
 return `<section><h2>Live product discovery</h2><p>Official CJ V2 API. Searches up to five technology keywords, 50 results per keyword per run. Provider trending labels and merchant listing counts are not sales or proof of demand. Discovery preserves existing candidate decisions and never auto-publishes.</p><form method="post" action="/live/discover"><button>Discover CJ products now</button></form><p>Credentials: ${process.env.CJ_ACCESS_TOKEN?'Configured; run a job to verify':'Missing CJ_ACCESS_TOKEN'}</p><p>Keywords: ${esc(process.env.TRADELENS_DISCOVERY_KEYWORDS||'smart,charger,usb')}</p></section>
 <section><h2>Research inbox</h2><div class="grid">${rows.map(r=>`<article><h3>${esc(r.name)}</h3><p>SKU ${esc(r.sku)} · ${esc(r.category)} · ${esc(r.status)}</p><p>API-reported product price: USD ${esc(r.price_text)} · Listed by ${r.listed_count??'unknown'} merchants · Reported inventory ${r.inventory??'unknown'}</p><small>Last observed ${esc(r.last_seen)}</small><p><a href="${esc(r.source_url)}" rel="noreferrer">Official source endpoint (requires authorization)</a></p>${r.candidate_id?'<a href="/admin">Review candidate in Scout</a>':`<details><summary>Review costs and create candidate</summary><form method="post" action="/live/promote"><input type="hidden" name="product_id" value="${esc(r.product_id)}"><input type="hidden" name="market" value="US"><label>Exact variant / model<input name="variant" required maxlength="120"></label>${['revenue','supplier','shipping','duties','fees','acquisition','losses'].map(k=>`<label>${k} (USD assumption)<input name="${k}" type="number" min="0" step="0.01" required></label>`).join('')}<label>Cost evidence / assumptions<textarea name="evidence" required maxlength="1200"></textarea></label><button name="decision" value="candidate">Create unapproved research candidate</button></form><form method="post" action="/live/promote"><input type="hidden" name="product_id" value="${esc(r.product_id)}"><button name="decision" value="reject">Reject product</button></form></details>`}</article>`).join('')||'<p>No live products have been discovered. Configure CJ and run discovery.</p>'}</div></section>
 <section><h2>US / UK live freight quotes</h2><p>Read-only CJ trial quote for one unit, using a manually verified variant ID. All quotes are USD even for GB destinations. Carrier estimates do not guarantee delivery, customs, taxes or product quality. Quotes never overwrite GBP candidate costs or mark a supplier verified.</p><form method="post" action="/live/freight"><div class="grid"><label>Candidate<select name="candidate_id">${candidates.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><label>CJ variant ID<input name="variant_id" required maxlength="200"></label><label>Origin<select name="origin"><option>CN</option><option>US</option><option>GB</option></select></label><label>Destination<select name="destination"><option>US</option><option>GB</option></select></label></div><button>Request live freight quote</button></form><div class="grid">${quotes.map(q=>`<article><h3>${esc(q.name)} · ${esc(q.destination)}</h3><p>${esc(q.carrier)} · USD ${(q.price/100).toFixed(2)} freight · taxes ${q.taxes==null?'not supplied':(q.taxes/100).toFixed(2)} · clearance ${q.clearance==null?'not supplied':(q.clearance/100).toFixed(2)}</p><p>Provider transit estimate: ${esc(q.transit)} days · Variant ${esc(q.variant_id)}</p><small>${esc(q.quoted_at)}</small></article>`).join('')}</div></section>`;
}
