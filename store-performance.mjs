import {cents,providerJSON,esc,requireText,transaction} from './provider-http.mjs';
export function initializeStorePerformance(db){db.exec(`
 CREATE TABLE IF NOT EXISTS shopify_sales_snapshot(shop TEXT NOT NULL,order_id TEXT NOT NULL,line_id TEXT NOT NULL,variant_id TEXT,currency TEXT NOT NULL,ordered_at TEXT NOT NULL,financial_status TEXT NOT NULL,quantity INTEGER NOT NULL,current_quantity INTEGER NOT NULL,net_merchandise INTEGER NOT NULL,synced_at TEXT NOT NULL,PRIMARY KEY(shop,order_id,line_id));
 CREATE TABLE IF NOT EXISTS shopify_order_totals(shop TEXT NOT NULL,order_id TEXT NOT NULL,currency TEXT NOT NULL,refunded INTEGER NOT NULL,cancelled INTEGER NOT NULL,synced_at TEXT NOT NULL,PRIMARY KEY(shop,order_id));
 CREATE TABLE IF NOT EXISTS advertising_mappings(account_id TEXT NOT NULL,ad_id TEXT NOT NULL,candidate_id TEXT NOT NULL REFERENCES candidates(id),PRIMARY KEY(account_id,ad_id));
 CREATE TABLE IF NOT EXISTS advertising_snapshot(account_id TEXT NOT NULL,ad_id TEXT NOT NULL,day TEXT NOT NULL,currency TEXT NOT NULL,spend INTEGER NOT NULL,impressions INTEGER NOT NULL,clicks INTEGER NOT NULL,synced_at TEXT NOT NULL,PRIMARY KEY(account_id,ad_id,day));
 `);}
const orderQuery=`query TradeLensSales($cursor: String, $search: String!) {
 orders(first: 50, after: $cursor, sortKey: CREATED_AT, query: $search) {
  pageInfo {hasNextPage endCursor}
  nodes {id createdAt test cancelledAt displayFinancialStatus
   totalRefundedSet {shopMoney {amount currencyCode}}
   lineItems(first: 100) {pageInfo {hasNextPage} nodes {id quantity currentQuantity variant {id} priceAfterAllDiscountsBeforeTaxesSet {shopMoney {amount currencyCode}}}}
  }
 }
}`;
export async function syncStorePerformance(db,{shop=process.env.SHOPIFY_SHOP,token=process.env.SHOPIFY_ADMIN_TOKEN,fetcher=fetch,now=new Date()}={}){
 if(!shop||!token||!(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/).test(shop))throw new Error('Configure a valid Shopify shop and read_orders token.');
 const search='created_at:>='+new Date(now.getTime()-59*86400000).toISOString();
 const sales=[],totals=[],seen=new Set();let cursor=null;
 for(let page=0;page<10;page++){
  const body=await providerJSON('https://'+shop+'/admin/api/2026-10/graphql.json',{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query:orderQuery,variables:{cursor,search}})},fetcher);
  if(body.errors?.length||!Array.isArray(body.data?.orders?.nodes))throw new Error('Shopify sales API rejected request; check read_orders scope.');
  const connection=body.data.orders;
  for(const o of connection.nodes){
   if(!/^gid:\/\/shopify\/Order\/\d+$/.test(o.id)||!Number.isFinite(Date.parse(o.createdAt))||!o.lineItems||!Array.isArray(o.lineItems.nodes)||o.lineItems.pageInfo?.hasNextPage)throw new Error('Order shape invalid or exceeds 100-line limit. Previous snapshot retained.');
   if(o.test)continue;
   const money=o.totalRefundedSet?.shopMoney;
   if(!money||!['USD','GBP','KES','NGN'].includes(money.currencyCode))throw new Error('Unsupported Shopify currency; no FX conversion assumed.');
   totals.push([shop,o.id,money.currencyCode,cents(money.amount),o.cancelledAt?1:0,now.toISOString()]);
   for(const l of o.lineItems.nodes){
    if(!/^gid:\/\/shopify\/LineItem\/\d+$/.test(l.id)||!Number.isSafeInteger(l.quantity)||l.quantity<0||!Number.isSafeInteger(l.currentQuantity)||l.currentQuantity<0||l.currentQuantity>l.quantity)throw new Error('Invalid Shopify sales line.');
    const amount=l.priceAfterAllDiscountsBeforeTaxesSet?.shopMoney;
    if(!amount||amount.currencyCode!==money.currencyCode)throw new Error('Shopify line currency mismatch.');
    if(l.variant&&!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(l.variant.id))throw new Error('Invalid Shopify variant identifier.');
    if(o.cancelledAt||!['PAID','PARTIALLY_REFUNDED','REFUNDED'].includes(o.displayFinancialStatus))continue;
    sales.push([shop,o.id,l.id,l.variant?.id||null,money.currencyCode,o.createdAt,o.displayFinancialStatus,l.quantity,l.currentQuantity,cents(amount.amount),now.toISOString()]);
   }
  }
  if(!connection.pageInfo?.hasNextPage){
   transaction(db,()=>{
    db.prepare('DELETE FROM shopify_sales_snapshot WHERE shop=?').run(shop);db.prepare('DELETE FROM shopify_order_totals WHERE shop=?').run(shop);
    const insert=db.prepare('INSERT INTO shopify_sales_snapshot VALUES(?,?,?,?,?,?,?,?,?,?,?)');for(const row of sales)insert.run(...row);
    const total=db.prepare('INSERT INTO shopify_order_totals VALUES(?,?,?,?,?,?)');for(const row of totals)total.run(...row);
   });return {orders:totals.length,lines:sales.length};
  }
  cursor=connection.pageInfo.endCursor;if(!cursor||seen.has(cursor))throw new Error('Shopify pagination cursor repeated or missing.');seen.add(cursor);
 }
 throw new Error('More than 500 orders in sync window; previous snapshot retained.');
}
function natural(value){if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value)))throw new Error('Invalid provider count.');return Number(value);}
export async function syncAdvertising(db,{token=process.env.META_ADS_TOKEN,account=process.env.META_AD_ACCOUNT_ID,version=process.env.META_GRAPH_VERSION,fetcher=fetch,now=new Date()}={}){
 if(!token||!/^act_\d+$/.test(account||'')||!/^v\d+\.0$/.test(version||''))throw new Error('Configure META_ADS_TOKEN, META_AD_ACCOUNT_ID (act_...) and supported META_GRAPH_VERSION.');
 const until=new Date(now.getTime()-86400000).toISOString().slice(0,10),since=new Date(now.getTime()-30*86400000).toISOString().slice(0,10);
 const params={level:'ad',fields:'ad_id,date_start,date_stop,spend,account_currency,impressions,clicks',time_increment:'1',time_range:JSON.stringify({since,until}),limit:'100'};
 const rows=[],seen=new Set();let after;
 for(let page=0;page<20;page++){
  const url=new URL('https://graph.facebook.com/'+version+'/'+account+'/insights');url.search=new URLSearchParams({...params,...(after?{after}:{})});
  const body=await providerJSON(url.href,{headers:{Authorization:'Bearer '+token}},fetcher);
  if(body.error||!Array.isArray(body.data))throw new Error('Meta Insights rejected request; verify ads_read access.');
  for(const r of body.data){
   if(!/^\d+$/.test(r.ad_id)||!/^\d{4}-\d{2}-\d{2}$/.test(r.date_start)||r.date_start!==r.date_stop||r.date_start<since||r.date_start>until||!['USD','GBP','KES','NGN'].includes(r.account_currency))throw new Error('Invalid Meta daily insights response.');
   rows.push([account,r.ad_id,r.date_start,r.account_currency,cents(r.spend),natural(r.impressions),natural(r.clicks),now.toISOString()]);
  }
  if(!body.paging?.next){
   transaction(db,()=>{db.prepare('DELETE FROM advertising_snapshot WHERE account_id=?').run(account);const insert=db.prepare('INSERT INTO advertising_snapshot VALUES(?,?,?,?,?,?,?,?)');for(const row of rows)insert.run(...row);});return rows.length;
  }
  // Never follow provider-supplied next URLs: only reuse opaque cursors on the fixed official host.
  after=body.paging.cursors?.after;if(!after||seen.has(after))throw new Error('Meta pagination cursor repeated or missing.');seen.add(after);
 }
 throw new Error('Meta insight sample exceeds 2000 daily ad rows; previous snapshot retained.');
}
export function mapAdvertising(db,form,account=process.env.META_AD_ACCOUNT_ID,now=new Date()){
 const ad=requireText(form,'ad_id',50),candidate=requireText(form,'candidate_id',36);
 if(!/^act_\d+$/.test(account||'')||!/^\d+$/.test(ad))throw new Error('Configure a valid account and ad ID.');
 if(!db.prepare('SELECT id FROM candidates WHERE id=?').get(candidate)||!db.prepare('SELECT 1 FROM advertising_snapshot WHERE account_id=? AND ad_id=?').get(account,ad))throw new Error('Select a candidate and a synchronized ad.');
 db.prepare('INSERT INTO advertising_mappings VALUES(?,?,?) ON CONFLICT(account_id,ad_id) DO UPDATE SET candidate_id=excluded.candidate_id').run(account,ad,candidate);
}
export function liveCandidateMetrics(db,candidate,shop=process.env.SHOPIFY_SHOP,account=process.env.META_AD_ACCOUNT_ID,now=new Date()){
 const currency=({US:'USD',UK:'GBP',KE:'KES',NG:'NGN'})[candidate.market];
 const listing=db.prepare('SELECT variant_id FROM store_listings WHERE candidate_id=? AND shop=?').get(candidate.id,shop||'');
 if(!listing)return null;
 const variant=listing.variant_id.startsWith('gid://')?listing.variant_id:'gid://shopify/ProductVariant/'+listing.variant_id;
 const start=new Date(now.getTime()-30*86400000).toISOString().slice(0,10),end=new Date(now.getTime()-86400000).toISOString().slice(0,10);
 const sales=db.prepare(`SELECT COUNT(DISTINCT order_id) orders,COALESCE(SUM(current_quantity),0) units,COALESCE(SUM(quantity),0) original_units,COALESCE(SUM(net_merchandise),0) revenue,MAX(synced_at) synced_at FROM shopify_sales_snapshot WHERE shop=? AND variant_id=? AND currency=? AND substr(ordered_at,1,10)>=? AND substr(ordered_at,1,10)<=?`).get(shop,variant,currency,start,end);
 const ads=db.prepare(`SELECT COALESCE(SUM(s.spend),0) spend,COALESCE(SUM(s.clicks),0) clicks,COUNT(*) records,MAX(s.synced_at) synced_at FROM advertising_snapshot s JOIN advertising_mappings m ON m.account_id=s.account_id AND m.ad_id=s.ad_id WHERE m.candidate_id=? AND m.account_id=? AND s.currency=?`).get(candidate.id,account||'',currency);
 const week=new Date(now.getTime()-7*86400000).toISOString().slice(0,10),priorWeek=new Date(now.getTime()-14*86400000).toISOString().slice(0,10);
 const weeks=db.prepare("SELECT COUNT(DISTINCT CASE WHEN substr(ordered_at,1,10)>=? THEN order_id END) recent,COUNT(DISTINCT CASE WHEN substr(ordered_at,1,10)<? THEN order_id END) prior FROM shopify_sales_snapshot WHERE shop=? AND variant_id=? AND currency=? AND substr(ordered_at,1,10)>=? AND substr(ordered_at,1,10)<=?").get(week,week,shop,variant,currency,priorWeek,end);
 return {...sales,...weeks,adSpend:ads.records?ads.spend:null,adClicks:ads.records?ads.clicks:null,adSyncedAt:ads.synced_at,currency,windowStart:start,windowEnd:end};
}
export function performanceWorkspace(db,shop){
 const orders=db.prepare('SELECT currency,COUNT(*) orders,SUM(refunded) refunded,MAX(synced_at) updated FROM shopify_order_totals WHERE shop=? GROUP BY currency').all(shop||'');
 const rows=db.prepare('SELECT * FROM candidates ORDER BY name').all().map(c=>({c,m:liveCandidateMetrics(db,c,shop)}));
 const ads=db.prepare('SELECT ad_id,currency,SUM(spend) spend,SUM(clicks) clicks FROM advertising_snapshot WHERE account_id=? GROUP BY ad_id,currency').all(process.env.META_AD_ACCOUNT_ID||'');
 return `<section><h2>Live sales and advertising</h2><p>Shopify: rolling 59-day order snapshot, up to 500 orders, excluding test orders. Per-product view: preceding 30 completed UTC days, only paid/partly refunded/refunded noncancelled orders. Net merchandise excludes refunded/removed quantities and taxes; refund totals below include all order-level refunds and must not be subtracted again. Values are API-reported, not independent financial audits.</p><form method="post" action="/live/sales"><button>Sync Shopify sales / refunds</button></form><form method="post" action="/live/ads"><button>Sync Meta advertising</button></form><div class="grid">${orders.map(o=>`<article><h3>${esc(o.currency)}</h3><p>${o.orders} orders in snapshot · Recorded refunds ${(o.refunded/100).toFixed(2)}</p><small>${esc(o.updated)}</small></article>`).join('')}</div></section>
 <section><h2>Product performance</h2><p>Uses current storefront variant mappings. Meta covers preceding 30 completed UTC-requested calendar days; the provider reports in the ad-account timezone. Currency mismatches are excluded. Clicks are not store visits, and orders are not ad-attributed conversions. Product ad spend only includes mapped ads. Actual supplier/fulfillment/fee costs still require accounting records; this view does not call an assumed margin realized profit.</p><div class="grid">${rows.map(({c,m})=>`<article><h3>${esc(c.name)}</h3>${m?`<p>${esc(m.currency)} net merchandise ${(m.revenue/100).toFixed(2)} · ${m.orders} orders · ${m.units} remaining units</p><p>Mapped ad spend ${m.adSpend===null?'unavailable':(m.adSpend/100).toFixed(2)} · Clicks ${m.adClicks??'unavailable'}</p><small>Sales ${esc(m.synced_at||'not synced')} · Ads ${esc(m.adSyncedAt||'not synced')}</small>`:'<p>No storefront variant mapping for this shop.</p>'}</article>`).join('')}</div></section>
 <section><h2>Map advertising to products</h2><p>One ad maps to one product. Do not assign multi-product ads as if their full spend belonged to one product. Unmapped advertising remains visible below.</p><form method="post" action="/live/ad-map"><div class="grid"><label>Product<select name="candidate_id">${rows.map(({c})=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><label>Synced ad ID<select name="ad_id">${ads.map(a=>`<option>${esc(a.ad_id)}</option>`).join('')}</select></label></div><button>Save ad mapping</button></form><ul>${ads.map(a=>`<li>${esc(a.ad_id)} · ${esc(a.currency)} ${(a.spend/100).toFixed(2)} · ${a.clicks} clicks · ${esc(db.prepare('SELECT candidate_id FROM advertising_mappings WHERE account_id=? AND ad_id=?').get(process.env.META_AD_ACCOUNT_ID||'',a.ad_id)?.candidate_id||'unmapped')}</li>`).join('')}</ul></section>`;
}
