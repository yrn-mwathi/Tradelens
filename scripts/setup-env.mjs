import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const target=new URL('../.env',import.meta.url);
const template=await readFile(new URL('../.env.example',import.meta.url),'utf8');
try{
 await writeFile(target,template.replace('TRADELENS_PASSWORD=','TRADELENS_PASSWORD='+randomBytes(24).toString('base64url')),{flag:'wx',mode:0o600});
 console.log('Created .env with a strong admin password. Configure your merchant credentials there or in host secrets, then run npm start. Admin username: admin. Read your local .env for the password.');
}catch(error){if(error.code==='EEXIST')console.log('Existing .env retained. Run npm start, or npm run demo for synthetic preview.');else throw error;}
