import {randomUUID} from 'node:crypto';
import {providerJSON,esc,transaction} from './provider-http.mjs';
import {discoverCj} from './discovery.mjs';
import {syncStorePerformance,syncAdvertising} from './store-performance.mjs';
import {syncShopifyCatalog} from './shopify-catalog.mjs';
import {runIntelligence,generateBriefing} from './intelligence.mjs';
export function initializeAutomation(db){db.exec(`
 CREATE TABLE IF NOT EXISTS automation_jobs(name TEXT PRIMARY KEY,status TEXT NOT NULL,started_at TEXT,finished_at TEXT,next_at TEXT,message TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS alert_deliveries(id TEXT PRIMARY KEY,payload TEXT NOT NULL,alert_ids TEXT NOT NULL,status TEXT NOT NULL,first_attempt TEXT NOT NULL,last_attempt TEXT NOT NULL,provider_id TEXT,message TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notified_alerts(alert_id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL);
 `);}
export async function deliverAlerts(db,{key=process.env.RESEND_API_KEY,from=process.env.TRADELENS_ALERT_FROM,to=process.env.TRADELENS_ALERT_TO,fetcher=fetch,now=new Date()}={}){
 if(!key||!from||!to)throw new Error('Configure RESEND_API_KEY, TRADELENS_ALERT_FROM and TRADELENS_ALERT_TO.');
 if(/[\r\n]/.test(from+to)||!from.includes('@')||!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(to))throw new Error('Configure one valid administrator email recipient and verified sender.');
 let delivery=db.prepare("SELECT * FROM alert_deliveries WHERE status IN ('pending','sending') ORDER BY rowid LIMIT 1").get();
 if(delivery&&now.getTime()-Date.parse(delivery.first_attempt)>23*3600000){
  db.prepare("UPDATE alert_deliveries SET status='needs_review',message='Retry window expired. Check Resend logs before any manual resend.' WHERE id=?").run(delivery.id);return 'Previous delivery outcome needs review.';
 }
 if(!delivery){
  const alerts=db.prepare('SELECT a.* FROM intelligence_alerts a LEFT JOIN notified_alerts n ON n.alert_id=a.id WHERE n.alert_id IS NULL AND a.acknowledged_at IS NULL ORDER BY a.rowid LIMIT 20').all();
  if(!alerts.length)return 'No pending alerts.';
  const id=randomUUID(),payload=JSON.stringify({from,to:[to],subject:'TradeLens product intelligence alerts',text:alerts.map(a=>a.kind+'\n'+a.message+'\n'+a.created_at).join('\n\n')});
  transaction(db,()=>{db.prepare("INSERT INTO alert_deliveries VALUES(?,?,?,'pending',?,?,NULL,'Queued')").run(id,payload,JSON.stringify(alerts.map(a=>a.id)),now.toISOString(),now.toISOString());for(const a of alerts)db.prepare('INSERT INTO notified_alerts VALUES(?,?)').run(a.id,id);});
  delivery=db.prepare('SELECT * FROM alert_deliveries WHERE id=?').get(id);
 }
 db.prepare("UPDATE alert_deliveries SET status='sending',last_attempt=? WHERE id=?").run(now.toISOString(),delivery.id);
 try{
  const body=await providerJSON('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':'tradelens/'+delivery.id},body:delivery.payload},fetcher);
  if(typeof body.id!=='string'||!body.id)throw new Error('Missing mail receipt.');
  db.prepare("UPDATE alert_deliveries SET status='accepted',provider_id=?,message='Accepted by email provider; inbox delivery is not confirmed.' WHERE id=?").run(body.id,delivery.id);
  return 'Email accepted by provider.';
 }catch{
  db.prepare("UPDATE alert_deliveries SET status='pending',message='Send outcome unknown or failed. Retry uses the same payload and idempotency key within 23 hours.' WHERE id=?").run(delivery.id);
  throw new Error('Alert delivery failed or is unconfirmed; queued for safe retry.');
 }
}
export function integrationReadiness(env=process.env){return [
 ['Shopify catalog',!!(env.SHOPIFY_SHOP&&env.SHOPIFY_ADMIN_TOKEN),'SHOPIFY_SHOP + SHOPIFY_ADMIN_TOKEN; read_products'],
 ['Shopify sales',!!(env.SHOPIFY_SHOP&&env.SHOPIFY_ADMIN_TOKEN),'read_orders scope; API sync confirms access'],
 ['CJ discovery / freight',!!env.CJ_ACCESS_TOKEN,'CJ_ACCESS_TOKEN; read catalog and freight API entitlement'],
 ['Printify',!!env.PRINTIFY_API_TOKEN,'PRINTIFY_API_TOKEN; existing catalog and connection checks'],
 ['Meta advertising',!!(env.META_ADS_TOKEN&&env.META_AD_ACCOUNT_ID&&env.META_GRAPH_VERSION),'META_ADS_TOKEN + META_AD_ACCOUNT_ID + META_GRAPH_VERSION; ads_read'],
 ['OpenAI briefings',!!(env.OPENAI_API_KEY&&env.TRADELENS_AI_MODEL),'OPENAI_API_KEY + TRADELENS_AI_MODEL'],
 ['Email alerts',!!(env.RESEND_API_KEY&&env.TRADELENS_ALERT_FROM&&env.TRADELENS_ALERT_TO),'RESEND_API_KEY + TRADELENS_ALERT_FROM + TRADELENS_ALERT_TO'],
 ['DSers / AliExpress',false,'Connect the supported DSers Shopify app; custom API requires approved developer access'],
 ['Google Trends',false,'Official alpha access contract not supplied; manual evidence only'],
 ['Dropship.io / Sell The Trend',false,'Authorized research-data contract not supplied; manual evidence only'],
 ['AutoDS / Zendrop / SaleHoo / Syncee',false,'Provider-specific app or partner access contract not supplied; existing local workflows only']
 ];}
const busy=new WeakSet();
export async function runAutomation(db,{force=false,env=process.env,fetcher=fetch,now=new Date()}={}){
 if(busy.has(db))throw new Error('Automation cycle already running.');busy.add(db);
 const jobs=[
  ['CJ discovery',86400000,!!env.CJ_ACCESS_TOKEN,()=>discoverCj(db,{token:env.CJ_ACCESS_TOKEN,keywords:env.TRADELENS_DISCOVERY_KEYWORDS,fetcher,now})],
  ['Shopify catalog',3600000,!!(env.SHOPIFY_SHOP&&env.SHOPIFY_ADMIN_TOKEN),()=>syncShopifyCatalog(db,{shop:env.SHOPIFY_SHOP,token:env.SHOPIFY_ADMIN_TOKEN,fetcher})],
  ['Shopify sales',3600000,!!(env.SHOPIFY_SHOP&&env.SHOPIFY_ADMIN_TOKEN),()=>syncStorePerformance(db,{shop:env.SHOPIFY_SHOP,token:env.SHOPIFY_ADMIN_TOKEN,fetcher,now})],
  ['Meta advertising',21600000,!!(env.META_ADS_TOKEN&&env.META_AD_ACCOUNT_ID&&env.META_GRAPH_VERSION),()=>syncAdvertising(db,{token:env.META_ADS_TOKEN,account:env.META_AD_ACCOUNT_ID,version:env.META_GRAPH_VERSION,fetcher,now})],
  ['Recommendation report',86400000,true,()=>runIntelligence(db,now).length],
  ['AI briefing',86400000,env.TRADELENS_AUTO_AI==='1'&&!!(env.OPENAI_API_KEY&&env.TRADELENS_AI_MODEL),async()=>{await generateBriefing(db,{key:env.OPENAI_API_KEY,model:env.TRADELENS_AI_MODEL,fetcher});const result=db.prepare('SELECT b.status FROM intelligence_briefings b JOIN intelligence_runs r ON r.id=b.run_id ORDER BY r.rowid DESC LIMIT 1').get();if(result?.status!=='completed')throw new Error('AI briefing did not complete.');return 'Briefing completed';}],
  ['Email alerts',900000,!!(env.RESEND_API_KEY&&env.TRADELENS_ALERT_FROM&&env.TRADELENS_ALERT_TO),()=>deliverAlerts(db,{key:env.RESEND_API_KEY,from:env.TRADELENS_ALERT_FROM,to:env.TRADELENS_ALERT_TO,fetcher,now})]
 ];
 try{for(const [name,interval,enabled,execute] of jobs){
  const row=db.prepare('SELECT * FROM automation_jobs WHERE name=?').get(name);
  if(row?.status==='running'&&now.getTime()-Date.parse(row.started_at)<300000)continue;
  if(!enabled){db.prepare("INSERT INTO automation_jobs(name,status,message) VALUES(?,'unconfigured','Required credentials, access or opt-in are missing.') ON CONFLICT(name) DO UPDATE SET status=excluded.status,message=excluded.message").run(name);continue;}
  if(!force&&row?.next_at&&Date.parse(row.next_at)>now.getTime())continue;
  db.prepare("INSERT INTO automation_jobs VALUES(?,'running',?,NULL,NULL,'Running') ON CONFLICT(name) DO UPDATE SET status=excluded.status,started_at=excluded.started_at,finished_at=NULL,message=excluded.message").run(name,now.toISOString());
  try{
   const result=await execute();
   db.prepare("UPDATE automation_jobs SET status='succeeded',finished_at=?,next_at=?,message=? WHERE name=?").run(new Date().toISOString(),new Date(now.getTime()+interval).toISOString(),result===undefined?'Completed; inspect saved result.':'Completed: '+JSON.stringify(result).slice(0,250),name);
  }catch{
   db.prepare("UPDATE automation_jobs SET status='failed',finished_at=?,next_at=?,message='Job failed. Check credentials, provider permissions, limits and response compatibility. Previous snapshots retained.' WHERE name=?").run(new Date().toISOString(),new Date(now.getTime()+900000).toISOString(),name);
  }
 }}finally{busy.delete(db);}
}
export function automationWorkspace(db){
 const jobs=db.prepare('SELECT * FROM automation_jobs ORDER BY name').all(),deliveries=db.prepare('SELECT * FROM alert_deliveries ORDER BY rowid DESC LIMIT 20').all();
 return `<section><h2>Integration readiness and automation</h2><p>Environment configuration never proves live access. A successful provider job is required; review its timestamp and scope. Unsupported research sources remain blocked. Scheduled jobs run while this server is awake. Enable TRADELENS_AUTOMATION=1 for provider jobs; local recommendation reports run daily regardless. Enable TRADELENS_AUTO_AI=1 separately for paid scheduled AI requests.</p><form method="post" action="/live/cycle"><button>Run configured integrations and report now</button></form><p>Automatic provider jobs: ${process.env.TRADELENS_AUTOMATION==='1'?'enabled':'disabled'}</p><div class="grid">${integrationReadiness().map(([name,configured,requirement])=>`<article><h3>${esc(name)}</h3><p>${configured?'Configured; live access must be tested':'Not ready'}</p><small>${esc(requirement)}</small></article>`).join('')}</div></section><section><h2>Job history</h2><div class="grid">${jobs.map(j=>`<article><h3>${esc(j.name)}</h3><p>${esc(j.status)} · ${esc(j.message)}</p><small>Started ${esc(j.started_at||'never')} · Finished ${esc(j.finished_at||'never')} · Next ${esc(j.next_at||'not scheduled')}</small></article>`).join('')}</div></section><section><h2>Email delivery outbox</h2><p>At most 20 alerts per message, to the single administrator address configured on the server. Provider acceptance does not confirm inbox delivery. Retries reuse the exact stored payload and key for up to 23 hours; older uncertain outcomes require review in provider logs.</p>${deliveries.map(d=>`<article><strong>${esc(d.status)}</strong><p>${esc(d.message)}</p><small>${esc(d.first_attempt)} · Receipt ${esc(d.provider_id||'none')}</small></article>`).join('')||'<p>No deliveries attempted.</p>'}</section>`;
}
