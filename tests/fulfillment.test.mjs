import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeFulfillment,stageFulfillment} from '../fulfillment.mjs';
import {initializeDispatch,previewSupplierDispatch} from '../supplier-dispatch.mjs';
import {initializeSupplierCatalog} from '../printify-catalog.mjs';
import {initializeCjCatalog} from '../cj-catalog.mjs';

function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE candidates(id TEXT PRIMARY KEY,approved TEXT);
 CREATE TABLE shopify_paid_orders(shop TEXT,order_gid TEXT,line_count INTEGER);
 CREATE TABLE store_listings(candidate_id TEXT,shop TEXT,variant_id TEXT);
 CREATE TABLE catalog_mappings(candidate_id TEXT,provider TEXT,sku TEXT,stock INTEGER);`);
 initializeFulfillment(db);initializeDispatch(db);initializeSupplierCatalog(db);initializeCjCatalog(db);
 db.prepare('INSERT INTO candidates VALUES (?,?)').run('candidate','yes');
 db.prepare('INSERT INTO shopify_paid_orders VALUES (?,?,?)').run('shop.myshopify.com','gid://shopify/Order/55',1);
 db.prepare('INSERT INTO store_listings VALUES (?,?,?)').run('candidate','shop.myshopify.com','gid://shopify/ProductVariant/77');
 db.prepare('INSERT INTO catalog_mappings VALUES (?,?,?,?)').run('candidate','Printify','SKU-123',10);
 db.prepare('INSERT INTO printify_catalog_snapshot VALUES (?,?,?,?,?,?,?,?,?)').run('123','p1','Test product','v1','SKU-123',2000,1,1,new Date().toISOString());
 return db;
}
const stageForm=new FormData();
stageForm.set('order_gid','gid://shopify/Order/55');
stageForm.set('candidate_id','candidate');
stageForm.set('provider','Printify');
stageForm.set('notes','Test verified order');
test('numeric webhook variant IDs are migrated to GIDs and stage successfully',()=>{
 const db=setup();
 db.prepare('INSERT INTO shopify_paid_order_lines VALUES (?,?,?,?,?)').run('shop.myshopify.com','gid://shopify/Order/55','1','77',2);
 db.prepare("UPDATE shopify_paid_order_lines SET variant_id='gid://shopify/ProductVariant/' || variant_id WHERE variant_id GLOB '[1-9]*' AND variant_id NOT GLOB '*[^0-9]*'").run();
 assert.equal(db.prepare('SELECT variant_id FROM shopify_paid_order_lines').get().variant_id,'gid://shopify/ProductVariant/77');
 stageFulfillment(db,stageForm,'shop.myshopify.com');
 const queue=db.prepare('SELECT * FROM fulfillment_queue').get();
 assert.equal(queue.status,'needs_review');
 const form=new FormData();form.set('queue_id',queue.id);
 previewSupplierDispatch(db,form,'shop.myshopify.com');
 const preview=db.prepare('SELECT * FROM supplier_dispatch_previews').get();
 assert.equal(preview.quantity,2);
 assert.equal(JSON.parse(preview.payload).shipping_address,null);
 db.close();
});
test('wrong variant cannot stage supplier fulfillment',()=>{
 const db=setup();
 db.prepare('INSERT INTO shopify_paid_order_lines VALUES (?,?,?,?,?)').run('shop.myshopify.com','gid://shopify/Order/55','1','gid://shopify/ProductVariant/999',2);
 assert.throws(()=>stageFulfillment(db,stageForm,'shop.myshopify.com'),/does not contain/);
 db.close();
});
test('supplier stock lower than verified paid quantity blocks staging',()=>{
 const db=setup();
 db.prepare('INSERT INTO shopify_paid_order_lines VALUES (?,?,?,?,?)').run('shop.myshopify.com','gid://shopify/Order/55','1','gid://shopify/ProductVariant/77',12);
 assert.throws(()=>stageFulfillment(db,stageForm,'shop.myshopify.com'),/enough stock/);
 db.close();
});
test('missing fresh supplier catalog evidence blocks staging',()=>{
 const db=setup();
 db.prepare('INSERT INTO shopify_paid_order_lines VALUES (?,?,?,?,?)').run('shop.myshopify.com','gid://shopify/Order/55','1','gid://shopify/ProductVariant/77',1);
 db.exec('DELETE FROM printify_catalog_snapshot');
 assert.throws(()=>stageFulfillment(db,stageForm,'shop.myshopify.com'),/Printify supplier SKU/);
 db.close();
});
