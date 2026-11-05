import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const password='test-only-long-random-password';
async function launch(env){
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,TRADELENS_AUTOMATION:'0',HOST:'127.0.0.1',PORT:'0',TRADELENS_PASSWORD:password,...env},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{let stdout='',stderr='';const timeout=setTimeout(()=>{child.kill();reject(new Error('Server startup timed out: '+stderr));},10000);child.stdout.on('data',chunk=>{stdout+=chunk;const m=stdout.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timeout);resolve(m[0]);}});child.stderr.on('data',x=>stderr+=x);child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code+': '+stderr));});});
 const headers={Authorization:'Basic '+Buffer.from('admin:'+password).toString('base64')};
 const get=path=>fetch(origin+path,{headers});
 const post=(path,fields,custom={})=>fetch(origin+path,{method:'POST',redirect:'manual',headers:{...headers,Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...custom},body:new URLSearchParams(fields)});
 const stop=async()=>{const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;};return {origin,get,post,stop};
}
test('merchant routes, setup gaps, forms and explicit physical testing work over HTTP',async()=>{
 const app=await launch({TRADELENS_DEMO:'1',CJ_ACCESS_TOKEN:'',SHOPIFY_SHOP:'',SHOPIFY_ADMIN_TOKEN:'',META_ADS_TOKEN:'',RESEND_API_KEY:''});
 try{
  for(const [path,label] of [['/admin/connections','Integration readiness'],['/admin/discovery','Live product discovery'],['/admin/performance','Live sales and advertising'],['/admin/intelligence','Winning Product Intelligence']]){const res=await app.get(path);assert.equal(res.status,200);assert.match(await res.text(),new RegExp(label));}
  assert.equal((await fetch(app.origin+'/admin/connections')).status,401);
  assert.equal((await app.post('/live/cycle',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await app.post('/live/cycle',{})).status,303);
  assert.equal((await app.post('/live/discover',{})).status,400);
  const validation={id:'demo-hub',badge:'Physically Tested',reviewer:'Human tester',evidence:'Sample passed actual hardware tests'};
  assert.equal((await app.post('/scout/validation',validation)).status,400);
  assert.equal((await app.post('/scout/validation',{...validation,physical_confirm:'yes',test_date:'2000-01-01'})).status,303);
  assert.match(await (await app.get('/admin')).text(),/Sample test date 2000-01-01/);
  assert.equal((await app.post('/intelligence/signal',{candidate_id:'demo-hub',metric:'search_interest',value:'65',observed_at:'2000-01-01',source_url:'https://example.com'})).status,303);
  assert.equal((await app.post('/intelligence/run',{})).status,303);
 }finally{await app.stop();}
});
test('real-mode paid order webhook accepts numeric IDs, deduplicates retries, rejects forged signatures',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'tradelens-test-')),dbPath=join(temp,'orders.sqlite');
 const secret='test-only-webhook-secret',shop='test.myshopify.com';const app=await launch({TRADELENS_DEMO:'0',TRADELENS_DB:dbPath,SHOPIFY_SHOP:shop,SHOPIFY_WEBHOOK_SECRET:secret,SHOPIFY_ADMIN_TOKEN:''});
 try{
  const body=JSON.stringify({admin_graphql_api_id:'gid://shopify/Order/123',line_items:[{id:456,variant_id:789,quantity:2}]});
  const headers={'x-shopify-hmac-sha256':createHmac('sha256',secret).update(body).digest('base64'),'x-shopify-shop-domain':shop,'x-shopify-topic':'orders/paid','Content-Type':'application/json'};
  for(let i=0;i<2;i++)assert.equal((await fetch(app.origin+'/shopify/webhooks/orders-paid',{method:'POST',headers,body})).status,204);
  assert.equal((await fetch(app.origin+'/shopify/webhooks/orders-paid',{method:'POST',headers:{...headers,'x-shopify-hmac-sha256':'forged'},body})).status,401);
  const db=new DatabaseSync(dbPath);assert.equal(db.prepare('SELECT COUNT(*) n FROM shopify_paid_orders').get().n,1);assert.equal(db.prepare('SELECT variant_id FROM shopify_paid_order_lines').get().variant_id,'gid://shopify/ProductVariant/789');db.close();
 }finally{await app.stop();await rm(temp,{recursive:true,force:true});}
});
