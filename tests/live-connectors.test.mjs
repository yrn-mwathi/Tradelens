import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeDiscovery,parseCjV2,discoverCj,promoteDiscovery,quoteCjFreight} from '../discovery.mjs';
import {initializeIntelligence} from '../intelligence.mjs';
import {initializeCjCatalog,syncCjCatalog} from '../cj-catalog.mjs';
import {initializeStorePerformance,syncStorePerformance,syncAdvertising,mapAdvertising,liveCandidateMetrics} from '../store-performance.mjs';
import {initializeAutomation,deliverAlerts,runAutomation,integrationReadiness} from '../automation.mjs';
import {cents,providerJSON} from '../provider-http.mjs';
const now=new Date('2026-11-05T12:00:00Z');
const form=o=>new URLSearchParams(o);
const reply=body=>({ok:true,json:async()=>body});
const product={id:'p1',nameEn:'USB hub',sku:'HUB',sellPrice:'12.50',listedNum:50,warehouseInventoryNum:20};
const cj=products=>({code:200,result:true,data:{totalPages:1,content:[{productList:products}]}});
function setup(){
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE candidates(id TEXT PRIMARY KEY,name TEXT,variant TEXT,market TEXT,evidence TEXT,source TEXT,created TEXT,revenue INTEGER,supplier INTEGER,shipping INTEGER,duties INTEGER,fees INTEGER,acquisition INTEGER,losses INTEGER,approved TEXT);
 CREATE TABLE scout_assessments(candidate_id TEXT,demand INTEGER,supplier INTEGER,competition INTEGER,growth INTEGER,recorded TEXT);
 CREATE TABLE scout_validations(candidate_id TEXT,badge TEXT,reviewer TEXT,recorded TEXT);
 CREATE TABLE research_evidence(id TEXT PRIMARY KEY,candidate_id TEXT,kind TEXT,source_name TEXT,source_url TEXT,notes TEXT,captured_at TEXT);
 CREATE TABLE store_listings(candidate_id TEXT,shop TEXT,variant_id TEXT);
 INSERT INTO candidates VALUES('a','Hub','A','US','cost notes','https://example.com','2026-11-01',5000,1000,500,100,100,500,100,NULL);
 INSERT INTO store_listings VALUES('a','test.myshopify.com','77');`);
 initializeIntelligence(db);initializeCjCatalog(db);initializeDiscovery(db);initializeStorePerformance(db);initializeAutomation(db);return db;
}
test('CJ V2 response contract: listing counts are not sales, price ranges preserved',()=>{
 const p=parseCjV2(cj([{...product,sellPrice:'10.00-20.00'}]))[0];assert.equal(p.price,'10.00-20.00');assert.equal(p.listed,50);assert.equal(p.sales,undefined);
 assert.throws(()=>parseCjV2({code:200,data:{list:[]}}));assert.throws(()=>parseCjV2(cj([{...product,id:null}])));
});
test('CJ discovery is idempotent, keeps merchant decisions, and retains old snapshot on failure',async()=>{
 const db=setup();const options={token:'test',keywords:'usb,charger',now,fetcher:async(url,opts)=>{assert.ok(url.startsWith('https://developers.cjdropshipping.com/api2.0/v1/product/listV2?'));assert.equal(opts.headers['CJ-Access-Token'],'test');return reply(cj([product]));}};
 assert.equal(await discoverCj(db,options),1);db.exec("UPDATE discovery_inbox SET status='rejected'");await discoverCj(db,options);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM discovery_inbox').get().n,1);assert.equal(db.prepare('SELECT status FROM discovery_inbox').get().status,'rejected');
 await assert.rejects(discoverCj(db,{...options,fetcher:async()=>reply({code:500})}));assert.equal(db.prepare('SELECT COUNT(*) n FROM cj_catalog_snapshot').get().n,1);db.close();
});
test('promoting requires explicit costs, rejects stale or mixed-currency costs and never auto-approves',async()=>{
 const db=setup();await discoverCj(db,{token:'test',keywords:'usb',fetcher:async()=>reply(cj([product])),now});
 const fields={product_id:'p1',market:'US',variant:'Exact hub variant',revenue:'50',supplier:'12.50',shipping:'4',duties:'1',fees:'1.50',acquisition:'8',losses:'1',evidence:'USD variant costs reviewed'};
 assert.throws(()=>promoteDiscovery(db,form({...fields,market:'UK'}),now),/USD/);
 assert.throws(()=>promoteDiscovery(db,form(fields),new Date('2026-11-07')),/Refresh/);
 const id=promoteDiscovery(db,form(fields),now);assert.equal(db.prepare('SELECT approved FROM candidates WHERE id=?').get(id).approved,null);
 assert.throws(()=>promoteDiscovery(db,form(fields),now),/already/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM scout_validations').get().n,0);
 await discoverCj(db,{token:'test',keywords:'usb',fetcher:async()=>reply(cj([{...product,sellPrice:'14.00'}])),now:new Date('2026-11-06')});
 assert.match(db.prepare('SELECT provenance FROM intelligence_signals').get().provenance,/CJ API/);db.close();
});
test('freight quotes preserve USD for UK and never assign supplier validation',async()=>{
 const db=setup();const n=await quoteCjFreight(db,form({candidate_id:'a',variant_id:'v1',origin:'CN',destination:'GB'}),{token:'test',now,fetcher:async(url,opts)=>{assert.equal(JSON.parse(opts.body).products[0].quantity,1);assert.equal(JSON.parse(opts.body).endCountryCode,'GB');return reply({code:200,data:[{logisticName:'Carrier',logisticPrice:4.71,logisticAging:'7-12'}]});}});
 assert.equal(n,1);const q=db.prepare('SELECT * FROM cj_freight_quotes').get();assert.equal(q.currency,'USD');assert.equal(q.price,471);assert.equal(q.taxes,null);assert.equal(db.prepare('SELECT COUNT(*) n FROM scout_validations').get().n,0);db.close();
});
function order(changes={}){return {id:'gid://shopify/Order/1',createdAt:'2026-11-01T00:00:00Z',test:false,cancelledAt:null,displayFinancialStatus:'PARTIALLY_REFUNDED',totalRefundedSet:{shopMoney:{amount:'10.00',currencyCode:'USD'}},lineItems:{pageInfo:{hasNextPage:false},nodes:[{id:'gid://shopify/LineItem/1',quantity:2,currentQuantity:1,variant:{id:'gid://shopify/ProductVariant/77'},priceAfterAllDiscountsBeforeTaxesSet:{shopMoney:{amount:'35.00',currencyCode:'USD'}}}]},...changes};}
const ordersReply=orders=>reply({data:{orders:{nodes:orders,pageInfo:{hasNextPage:false}}}});
test('Shopify API imports net merchandise and refunds once, excludes tests and pending orders',async()=>{
 const db=setup(),opts={shop:'test.myshopify.com',token:'test',now,fetcher:async()=>ordersReply([order(),order({...order(),id:'gid://shopify/Order/2',test:true}),order({...order(),id:'gid://shopify/Order/3',displayFinancialStatus:'PENDING'})])};
 await syncStorePerformance(db,opts);await syncStorePerformance(db,opts);assert.equal(db.prepare('SELECT COUNT(*) n FROM shopify_sales_snapshot').get().n,1);assert.equal(db.prepare('SELECT net_merchandise FROM shopify_sales_snapshot').get().net_merchandise,3500);assert.equal(db.prepare('SELECT refunded FROM shopify_order_totals WHERE order_id=?').get('gid://shopify/Order/1').refunded,1000);
 const m=liveCandidateMetrics(db,db.prepare("SELECT * FROM candidates WHERE id='a'").get(),'test.myshopify.com',undefined,now);assert.equal(m.revenue,3500);assert.equal(m.units,1);assert.equal(m.adSpend,null);db.close();
});
test('invalid Shopify pages/currencies and oversized line connections preserve previous snapshot',async()=>{
 const db=setup();const opts={shop:'test.myshopify.com',token:'test',now,fetcher:async()=>ordersReply([order()])};await syncStorePerformance(db,opts);
 for(const o of [order({lineItems:{pageInfo:{hasNextPage:true},nodes:[]}}),order({totalRefundedSet:{shopMoney:{amount:'1',currencyCode:'EUR'}}})])await assert.rejects(syncStorePerformance(db,{...opts,fetcher:async()=>ordersReply([o])}));assert.equal(db.prepare('SELECT COUNT(*) n FROM shopify_sales_snapshot').get().n,1);db.close();
});
test('Meta daily sync uses fixed host with opaque pagination and replaces batches without duplicates',async()=>{
 const db=setup();let calls=0;
 const opts={token:'test',account:'act_123',version:'v26.0',now,fetcher:async(url,options)=>{assert.ok(url.startsWith('https://graph.facebook.com/v26.0/act_123/insights?'));assert.equal(options.headers.Authorization,'Bearer test');calls++;return reply({data:[{ad_id:String(calls%2?1:2),date_start:'2026-11-01',date_stop:'2026-11-01',spend:'2.50',account_currency:'USD',clicks:'3',impressions:'30'}],...(calls%2?{paging:{next:'https://evil.example/steal',cursors:{after:'opaque'}}}:{})});}};
 await syncAdvertising(db,opts);await syncAdvertising(db,opts);assert.equal(calls,4);assert.equal(db.prepare('SELECT COUNT(*) n FROM advertising_snapshot').get().n,2);
 mapAdvertising(db,form({ad_id:'1',candidate_id:'a'}),'act_123');const m=liveCandidateMetrics(db,db.prepare("SELECT * FROM candidates WHERE id='a'").get(),'test.myshopify.com','act_123',now);assert.equal(m.adSpend,250);db.close();
});
test('email retry uses stable payload and idempotency key; accepted email never requeues',async()=>{
 const db=setup();db.prepare('INSERT INTO intelligence_alerts VALUES(?,?,?,?,?,?,NULL)').run('alert','hash','a','Opportunity','Review product','2026-11-05');let first;
 const opts={key:'test',from:'TradeLens <alerts@example.com>',to:'admin@example.com',now,fetcher:async(url,o)=>{first=o;throw new Error('Unknown send outcome');}};
 await assert.rejects(deliverAlerts(db,opts));assert.equal(db.prepare('SELECT status FROM alert_deliveries').get().status,'pending');
 const message=await deliverAlerts(db,{...opts,to:'changed@example.com',fetcher:async(url,o)=>{assert.equal(o.headers['Idempotency-Key'],first.headers['Idempotency-Key']);assert.equal(o.body,first.body);return reply({id:'receipt'});}});assert.match(message,/accepted/);
 assert.equal(await deliverAlerts(db,opts),'No pending alerts.');db.close();
});
test('uncertain email older than safe retry window is blocked for review',async()=>{
 const db=setup();db.prepare('INSERT INTO intelligence_alerts VALUES(?,?,?,?,?,?,NULL)').run('alert','hash','a','Opportunity','Review product','2026-11-05');const opts={key:'test',from:'alerts@example.com',to:'admin@example.com',now,fetcher:async()=>{throw new Error('failed');}};await assert.rejects(deliverAlerts(db,opts));let called=false;await deliverAlerts(db,{...opts,now:new Date('2026-11-07'),fetcher:async()=>{called=true;return reply({id:'receipt'});}});assert.equal(called,false);assert.equal(db.prepare('SELECT status FROM alert_deliveries').get().status,'needs_review');db.close();
});
test('missing credentials skip external jobs but local report succeeds; individual failures isolated',async()=>{
 const db=setup();assert.equal(integrationReadiness({}).some(x=>x[1]),false);await runAutomation(db,{env:{},now,fetcher:async()=>{throw new Error('Unexpected network');}});
 assert.equal(db.prepare("SELECT status FROM automation_jobs WHERE name='Recommendation report'").get().status,'succeeded');
 await runAutomation(db,{force:true,env:{CJ_ACCESS_TOKEN:'test'},now,fetcher:async()=>reply({code:401})});assert.equal(db.prepare("SELECT status FROM automation_jobs WHERE name='CJ discovery'").get().status,'failed');assert.equal(db.prepare("SELECT COUNT(*) n FROM intelligence_runs").get().n,2);db.close();
});
test('provider money and response bounds reject malformed amounts and large payloads',async()=>{
 assert.equal(cents('12.50'),1250);for(const v of ['1.234','-1','NaN','1-2'])assert.throws(()=>cents(v));
 const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4000001));controller.close();}});await assert.rejects(providerJSON('https://example.com',{},async()=>({ok:true,body:stream})),/4 MB/);
});

test('fresh real store traction changes demand component, stale snapshots do not',async()=>{
 const {buildRecommendations}=await import('../intelligence.mjs');const db=setup();
 db.prepare('INSERT INTO scout_assessments VALUES(?,?,?,?,?,?)').run('a',0,80,80,50,now.toISOString());
 const before=buildRecommendations(db,now)[0].score;
 const data=Array.from({length:20},(_,i)=>order({id:'gid://shopify/Order/'+(i+1),createdAt:'2026-11-03T00:00:00Z'}));
 await syncStorePerformance(db,{shop:'test.myshopify.com',token:'test',now,fetcher:async()=>ordersReply(data)});
 const savedShop=process.env.SHOPIFY_SHOP;process.env.SHOPIFY_SHOP='test.myshopify.com';
 try{const after=buildRecommendations(db,now)[0];assert.ok(after.score>before);assert.match(after.basis,/API store traction/);const stale=buildRecommendations(db,new Date(now.getTime()+2*86400000))[0];assert.equal(stale.score,before);}finally{if(savedShop===undefined)delete process.env.SHOPIFY_SHOP;else process.env.SHOPIFY_SHOP=savedShop;db.close();}
});
