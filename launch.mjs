const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const countries = {US:'United States',UK:'United Kingdom'};
const currency = {US:'USD',UK:'GBP'};
const money = n => (n/100).toFixed(2);
const fields=['selling','supplier','shipping','advertising','fees','duties','refunds'];
export function initializeLaunch(db){
 db.exec(`CREATE TABLE IF NOT EXISTS launch_scenarios(
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
 destination TEXT NOT NULL CHECK(destination IN ('US','UK')),
 selling INTEGER NOT NULL, supplier INTEGER NOT NULL, shipping INTEGER NOT NULL,
 advertising INTEGER NOT NULL, fees INTEGER NOT NULL, duties INTEGER NOT NULL,
 refunds INTEGER NOT NULL, source_url TEXT NOT NULL, assumptions TEXT NOT NULL,
 updated_at TEXT NOT NULL, UNIQUE(candidate_id,destination)
 );`);
}
export function saveLaunchScenario(db,form){
 const id=String(form.get('candidate_id')||'');
 if(!db.prepare('SELECT id FROM candidates WHERE id=?').get(id))throw new Error('Unknown candidate.');
 const destination=String(form.get('destination')||'');
 if(!Object.hasOwn(countries,destination))throw new Error('Select US or UK.');
 const values=fields.map(field=>{
  const raw=String(form.get(field)||'');
  if(!/^\d+(?:\.\d{1,2})?$/.test(raw))throw new Error('Enter a valid nonnegative '+field+' amount.');
  const cents=Math.round(Number(raw)*100);
  if(!Number.isSafeInteger(cents)||cents>1000000000)throw new Error('Amount exceeds permitted range.');
  return cents;
 });
 if(values[0]===0)throw new Error('Selling price must be greater than zero.');
 const source=String(form.get('source_url')||'').trim();
 let parsed;try{parsed=new URL(source);}catch{throw new Error('Supply an HTTPS cost evidence URL.');}
 if(parsed.protocol!=='https:'||!parsed.hostname.includes('.')||parsed.username||parsed.password)throw new Error('Supply a public HTTPS evidence URL.');
 const assumptions=String(form.get('assumptions')||'').trim();
 if(!assumptions||assumptions.length>1500)throw new Error('Describe your assumptions (up to 1500 characters).');
 db.prepare(`INSERT INTO launch_scenarios VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(candidate_id,destination) DO UPDATE SET
 selling=excluded.selling,supplier=excluded.supplier,shipping=excluded.shipping,
 advertising=excluded.advertising,fees=excluded.fees,duties=excluded.duties,
 refunds=excluded.refunds,source_url=excluded.source_url,
 assumptions=excluded.assumptions,updated_at=excluded.updated_at`).run(
 id+'-'+destination,id,destination,...values,parsed.href,assumptions,new Date().toISOString());
}
export function launchWorkspace(db){
 const candidates=db.prepare('SELECT id,name,variant FROM candidates ORDER BY created DESC').all();
 const scenarios=db.prepare(`SELECT s.*,c.name FROM launch_scenarios s JOIN candidates c ON c.id=s.candidate_id ORDER BY updated_at DESC`).all();
 const input=(field)=>'<label>'+esc(field.charAt(0).toUpperCase()+field.slice(1))+' (destination currency)<input name="'+field+'" type="number" step="0.01" min="0" max="10000000" required></label>';
 return '<section><h2>US / UK landed profitability</h2><p>Save a scenario in the destination currency. Enter your own evidence-based costs; this tool does not fetch live FX, taxes or shipping quotes. Tax and duty values are merchant assumptions, not legal advice.</p>'+
 (candidates.length?'<form method="post" action="/launch/scenario"><div class="grid"><label>Product<select name="candidate_id">'+candidates.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+' — '+esc(c.variant)+'</option>').join('')+'</select></label><label>Destination<select name="destination"><option value="US">US · USD</option><option value="UK">UK · GBP</option></select></label>'+fields.map(input).join('')+'<label>Cost evidence HTTPS URL<input name="source_url" type="url" maxlength="2048" required></label><label>Cost assumptions<textarea name="assumptions" maxlength="1500" required></textarea></label></div><button>Save profitability scenario</button></form>':'<p>Create a product candidate first.</p>')+
 '<h3>Recorded scenarios</h3><div class="grid">'+scenarios.map(s=>{
 const costs=s.supplier+s.shipping+s.advertising+s.fees+s.duties+s.refunds;
 const profit=s.selling-costs;const margin=(profit/s.selling*100).toFixed(1);
 const quote=db.prepare(`SELECT e.* FROM supplier_shipping_evidence e JOIN catalog_mappings m ON m.candidate_id=e.candidate_id WHERE e.candidate_id=? AND e.destination=? AND e.provider=m.provider AND e.supplier_sku=m.sku ORDER BY e.verified_at DESC LIMIT 1`).get(s.candidate_id,s.destination);
 const fresh=quote&&Date.now()-Date.parse(quote.verified_at)<=7*86400000;
 const quotedProfit=fresh?profit+s.shipping-quote.shipping_cents:null;
 return '<article><h3>'+esc(s.name)+' · '+esc(s.destination)+'</h3><p>Price: '+esc(currency[s.destination])+' '+money(s.selling)+' · Total estimated costs: '+money(costs)+'</p><strong>Estimated contribution: '+esc(currency[s.destination])+' '+money(profit)+' ('+margin+'%)</strong><p>Assumptions: '+esc(s.assumptions)+'</p><a href="'+esc(s.source_url)+'" target="_blank" rel="noopener noreferrer">Source evidence</a><p>Updated '+esc(s.updated_at.slice(0,10))+'</p></article>';
 }).join('')+'</div></section>';
}
