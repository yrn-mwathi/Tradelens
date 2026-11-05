export function cents(value){
 const text=String(value??'');
 if(!/^\d{1,9}(\.\d{1,2})?$/.test(text))throw new Error('Provider money must be a nonnegative decimal with at most two places.');
 const [whole,fraction='']=text.split('.');const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(!Number.isSafeInteger(result))throw new Error('Provider money out of range.');return result;
}
export async function providerJSON(url,options={},fetcher=fetch){
 const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('Provider request failed (HTTP '+response.status+').');
 // Bound even a chunked response; a provider error body must never leak credentials into logs/UI.
 if(!response.body?.getReader){return response.json();}
 const reader=response.body.getReader();let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4000000)throw new Error('Provider response exceeds 4 MB limit.');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function requireText(form,key,max=2000){const value=String(form.get(key)||'').trim();if(!value||value.length>max)throw new Error('Invalid '+key);return value;}
export function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
