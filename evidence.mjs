import { randomUUID } from 'node:crypto';

const labels = ['Research only','Supplier contacted','Documents reviewed','Sample ordered','Sample passed','Rejected'];
const evidenceKinds = ['Product research','Competitor observation','Supplier document','Shipping quotation','Sample test','Customer review','Other'];
const safe = x => String(x ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const required = (form,key,max=1000) => {
 const v=(form.get(key)||'').trim();
 if(!v || v.length>max)throw new Error('Invalid '+key);
 return v;
};
const url = value => {
 const u=new URL(value);
 if(u.protocol!=='https:' || u.username || u.password || u.hostname==='localhost' || !u.hostname.includes('.'))throw new Error('Use a public HTTPS evidence link.');
 return u.href;
};
export function initializeEvidence(db){
 db.exec(`CREATE TABLE IF NOT EXISTS research_evidence (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, source_name TEXT NOT NULL, source_url TEXT NOT NULL,
 notes TEXT NOT NULL, captured_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS supplier_reviews (
 lead_id TEXT PRIMARY KEY REFERENCES supplier_leads(id) ON DELETE CASCADE,
 status TEXT NOT NULL, reviewer TEXT NOT NULL, notes TEXT NOT NULL,
 checked_at TEXT NOT NULL
 );`);
}
export function recordEvidence(db,route,form){
 if(route==='/research/evidence'){
  const id=required(form,'candidate_id',36);
  if(!db.prepare('SELECT id FROM candidates WHERE id=?').get(id))throw new Error('Unknown product candidate.');
  const kind=required(form,'kind',50);
  if(!evidenceKinds.includes(kind))throw new Error('Unknown evidence category.');
  db.prepare('INSERT INTO research_evidence VALUES (?,?,?,?,?,?,?)').run(randomUUID(),id,kind,required(form,'source_name',120),url(required(form,'source_url',2048)),required(form,'notes',2000),new Date().toISOString());
 } else if(route==='/research/supplier-review'){
  const lead=required(form,'lead_id',36);
  if(!db.prepare('SELECT id FROM supplier_leads WHERE id=?').get(lead))throw new Error('Unknown supplier lead.');
  const status=required(form,'status',40);
  if(!labels.includes(status))throw new Error('Invalid review status.');
  db.prepare(`INSERT INTO supplier_reviews VALUES (?,?,?,?,?)
   ON CONFLICT(lead_id) DO UPDATE SET status=excluded.status,reviewer=excluded.reviewer,
   notes=excluded.notes,checked_at=excluded.checked_at`).run(lead,status,required(form,'reviewer',120),required(form,'notes',2000),new Date().toISOString());
 } else throw new Error('Unknown evidence operation.');
}
export function evidenceWorkspace(db){
 const candidates=db.prepare('SELECT id,name,variant,market FROM candidates ORDER BY created DESC').all();
 const leads=db.prepare('SELECT id,name,provider FROM supplier_leads ORDER BY name').all();
 const evidence=db.prepare(`SELECT e.*,c.name AS product FROM research_evidence e
 JOIN candidates c ON c.id=e.candidate_id ORDER BY e.captured_at DESC LIMIT 100`).all();
 const reviews=db.prepare(`SELECT s.name,s.provider,r.* FROM supplier_reviews r
 JOIN supplier_leads s ON s.id=r.lead_id ORDER BY r.checked_at DESC`).all();
 const select=(items,format)=>items.map(item=>'<option value="'+safe(item.id)+'">'+safe(format(item))+'</option>').join('');
 return '<section><h2>Research evidence ledger</h2><p>Attach traceable product and competitor observations. All records are manually entered; no external sales data is inferred or automatically scraped.</p>'+
 (candidates.length?'<form method="post" action="/research/evidence"><div class="grid"><label>Product candidate<select name="candidate_id">'+select(candidates,x=>x.name+' · '+x.variant+' · '+x.market)+'</select></label><label>Evidence type<select name="kind">'+evidenceKinds.map(x=>'<option>'+safe(x)+'</option>').join('')+'</select></label><label>Source name<input name="source_name" maxlength="120" required></label><label>Source HTTPS link<input type="url" name="source_url" maxlength="2048" required></label><label>What did you observe?<textarea name="notes" maxlength="2000" required></textarea></label></div><button>Record source evidence</button></form>':'<p>Add a candidate in Scout to begin recording evidence.</p>')+
 '<h3>Recent evidence</h3><ul>'+evidence.map(x=>'<li><b>'+safe(x.product)+'</b> · '+safe(x.kind)+' · <a rel="noreferrer noopener" target="_blank" href="'+safe(x.source_url)+'">'+safe(x.source_name)+'</a> · '+safe(x.captured_at.slice(0,10))+'<p>'+safe(x.notes)+'</p></li>').join('')+'</ul></section>'+
 '<section><h2>Supplier verification workflow</h2><p>These statuses document human review only. A “Sample passed” status requires real test notes; it is not a platform-issued certification.</p>'+
 (leads.length?'<form method="post" action="/research/supplier-review"><div class="grid"><label>Supplier lead<select name="lead_id">'+select(leads,x=>x.name+' · '+x.provider)+'</select></label><label>Review status<select name="status">'+labels.map(x=>'<option>'+safe(x)+'</option>').join('')+'</select></label><label>Reviewer<input name="reviewer" maxlength="120" required></label><label>Verification notes / evidence<textarea name="notes" maxlength="2000" required></textarea></label></div><button>Save supplier review</button></form>':'<p>Add a supplier lead in Supply first.</p>')+
 '<h3>Latest reviews</h3><ul>'+reviews.map(x=>'<li><b>'+safe(x.name)+'</b> · '+safe(x.provider)+' · '+safe(x.status)+' · '+safe(x.reviewer)+' · '+safe(x.checked_at.slice(0,10))+'<p>'+safe(x.notes)+'</p></li>').join('')+'</ul></section>';
}
