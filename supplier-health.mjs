const escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function initializeSupplierHealth(db){
 db.exec(`CREATE TABLE IF NOT EXISTS supplier_connection_checks(
 provider TEXT PRIMARY KEY, checked_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('connected','failed')),
 message TEXT NOT NULL
 );`);
}
export async function checkSupplierConnection(db,form){
 const provider=String(form.get('provider')||'');
 let url,headers;
 if(provider==='Printify'){
  const token=process.env.PRINTIFY_API_TOKEN;
  if(!token)throw new Error('Set PRINTIFY_API_TOKEN before checking Printify.');
  url='https://api.printify.com/v1/shops.json';
  headers={'Authorization':'Bearer '+token};
 }else if(provider==='CJDropshipping'){
  const token=process.env.CJ_ACCESS_TOKEN;
  if(!token)throw new Error('Set CJ_ACCESS_TOKEN before checking CJ.');
  url='https://developers.cjdropshipping.com/api2.0/v1/product/list?pageNum=1&pageSize=1';
  headers={'CJ-Access-Token':token};
 }else throw new Error('Unsupported supplier.');
 let status='failed',message='Connection failed';
 try{
  const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('Provider returned HTTP '+response.status);
  const body=await response.json();
  if(provider==='Printify'&&!Array.isArray(body))throw new Error('Unexpected Printify shops response');
  if(provider==='CJDropshipping'&&(body.code!==200&&body.code!=='200'))throw new Error('CJ rejected the request or token');
  status='connected';message=provider==='Printify'?'Authenticated; '+body.length+' shop(s) visible':'CJ token accepted for product read';
 }catch(error){message=String(error.message||'Provider request failed').slice(0,200);}
 db.prepare(`INSERT INTO supplier_connection_checks VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,message=excluded.message`).run(provider,new Date().toISOString(),status,message);
 if(status!=='connected')throw new Error(message);
}
export function supplierHealthWorkspace(db){
 const checks=new Map(db.prepare('SELECT * FROM supplier_connection_checks').all().map(x=>[x.provider,x]));
 return '<section><h2>Supplier connection health</h2><p>Read-only credential checks. Credentials remain in server environment variables and are never stored in the database. This does not submit orders, reserve stock, or authorize payments.</p><div class="grid">'+['Printify','CJDropshipping'].map(provider=>{
 const row=checks.get(provider);
 return '<article><h3>'+provider+'</h3><p>Credentials: '+(provider==='Printify'?(process.env.PRINTIFY_API_TOKEN?'configured':'missing'):(process.env.CJ_ACCESS_TOKEN?'configured':'missing'))+'</p><p>Last check: '+escape(row?.checked_at||'Never')+'</p><p>Result: '+escape(row?.status||'Not checked')+'</p><p>'+escape(row?.message||'')+'</p><form method="post" action="/suppliers/check"><input type="hidden" name="provider" value="'+provider+'"><button>Check read-only connection</button></form></article>';
 }).join('')+'</div></section>';
}
