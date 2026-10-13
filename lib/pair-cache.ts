// A bounded UI view over an IndexedDB catalog; factory records never need to fit in memory.
import {parseUnits} from 'ethers';
import type {Config,Asset} from './model';
import type {Scan} from './engine';
import type {DiscoveryInfo,FactoryTarget,PairRecord,PairPage} from './pair-discovery';
export type CatalogState={scope:string,cycle:string,phase:'scanning'|'paused'|'complete',targets:FactoryTarget[],errors:DiscoveryInfo['errors'],discovered:number,assets:number,unreadable:number,quoteFailures?:number,quoted:number,routeCount:number,qualifying:number,updatedAt:string,report:Scan|null};
export type QuoteFailure=Asset&{scope:string,message:string,at:string};
type StoredPair=PairRecord&{scope:string};
type StoredAsset=Asset&{scope:string};
let dbPromise:Promise<IDBDatabase>|undefined;
export function catalogScope(c:Config){return JSON.stringify([c.network,c.rpc,c.minReserve,c.dexes.filter(d=>d.enabled).map(d=>d.address.toLowerCase()).sort(),c.tokens.map(t=>t.address.toLowerCase()).sort(),c.amount,c.maxAmount,c.minProfit,c.maxGasGwei,c.gasBudget,c.slippageBps,c.reserveShareBps]);}
const result=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error||Error('Pair cache request failed.'));});
const finished=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||Error('Pair cache transaction was cancelled.'));tx.onerror=()=>reject(tx.error||Error('Pair cache could not be saved.'));});
async function database(){
 if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
  if(!globalThis.indexedDB){reject(Error('IndexedDB is unavailable. Enable browser storage for resumable all-pairs scans.'));return;}
  const r=indexedDB.open('bsc-arb-pair-catalog',2);
  r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('state'))db.createObjectStore('state',{keyPath:'scope'});
   if(!db.objectStoreNames.contains('pairs')){const pairs=db.createObjectStore('pairs',{keyPath:['scope','router','index']});pairs.createIndex('scope','scope');}
   for(const name of ['assets','queue','failures'])if(!db.objectStoreNames.contains(name)){const s=db.createObjectStore(name,{keyPath:['scope','address']});s.createIndex('scope','scope');}
  };
  r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();dbPromise=undefined;};resolve(r.result);};
  r.onerror=()=>{dbPromise=undefined;reject(r.error||Error('Pair cache could not be opened.'));};
  r.onblocked=()=>reject(Error('Close older app tabs to open the pair cache.'));
 });return dbPromise;
}
export async function readCatalog(scope:string):Promise<CatalogState|null>{const db=await database();return (await result(db.transaction('state').objectStore('state').get(scope)))||null;}
export async function saveCatalog(state:CatalogState){const db=await database(),tx=db.transaction('state','readwrite'),done=finished(tx);tx.objectStore('state').put(state);await done;return state;}
export function reconcileCatalog(scope:string,info:DiscoveryInfo,previous:CatalogState|null):CatalogState{
 const targets=info.targets.map(t=>{const old=previous?.targets.find(o=>o.router.toLowerCase()===t.router.toLowerCase());
  if(old&&(old.factory.toLowerCase()!==t.factory.toLowerCase()||old.cursor>t.total))throw Error('Factory changed or its pair count shrank. Rebuild the catalog.');
  return {...t,router:t.router.toLowerCase(),cursor:old?.cursor||0};
 });
 return previous?{...previous,targets,errors:info.errors,phase:'scanning',updatedAt:new Date().toISOString()}:{scope,cycle:crypto.randomUUID(),phase:'scanning',targets,errors:info.errors,discovered:0,assets:0,unreadable:0,quoted:0,routeCount:0,qualifying:0,updatedAt:new Date().toISOString(),report:null};
}
export async function refreshCatalog(state:CatalogState){
 const db=await database(),tx=db.transaction(['state','assets','queue','failures'],'readwrite'),done=finished(tx);
 const next:CatalogState={...state,cycle:crypto.randomUUID(),phase:'scanning',quoted:0,quoteFailures:0,routeCount:0,qualifying:0,report:null,updatedAt:new Date().toISOString()};
 const failures=tx.objectStore('failures').index('scope').openCursor(IDBKeyRange.only(state.scope));failures.onsuccess=()=>{const c=failures.result;if(c){c.delete();c.continue();}};
 const cursor=tx.objectStore('assets').index('scope').openCursor(IDBKeyRange.only(state.scope));
 cursor.onsuccess=()=>{const c=cursor.result;if(c){tx.objectStore('queue').put(c.value);c.continue();}else tx.objectStore('state').put(next);};
 await done;return next;
}
export async function savePairPage(state:CatalogState,page:PairPage,repair=false){
 const target=state.targets.find(t=>t.router===page.router.toLowerCase());
 if(!target||(!repair&&target.cursor!==page.cursor)||(repair&&(page.cursor>=target.cursor||page.nextCursor>target.cursor))||target.factory.toLowerCase()!==page.factory.toLowerCase())throw Error('Factory page no longer matches the saved scan cursor.');
 const db=await database(),tx=db.transaction(['state','pairs','assets','queue'],'readwrite'),done=finished(tx),pairs=tx.objectStore('pairs'),assets=tx.objectStore('assets'),queue=tx.objectStore('queue');
 const next={...state,targets:state.targets.map(t=>t===target?{...t,cursor:repair?t.cursor:page.nextCursor,total:page.total}:t),updatedAt:new Date().toISOString()};
 try{for(const p of page.pairs){const stored:StoredPair={...p,router:p.router.toLowerCase(),scope:state.scope},previous=await result<StoredPair|undefined>(pairs.get([state.scope,stored.router,p.index]));
   if(!previous)next.discovered++;next.unreadable+=(p.status==='unreadable'?1:0)-(previous?.status==='unreadable'?1:0);pairs.put(stored);
   if(p.asset){const key=[state.scope,p.asset.address.toLowerCase()],old=await result<StoredAsset|undefined>(assets.get(key)),asset:StoredAsset={...p.asset,address:p.asset.address.toLowerCase(),scope:state.scope};
    assets.put(asset);if(!old){next.assets++;queue.put(asset);}
   }
  }tx.objectStore('state').put(next);await done;return next;
 }catch(e){try{tx.abort();}catch{}await done.catch(()=>{});throw e;}
}
export async function nextQuoteBatch(scope:string,limit=4):Promise<Asset[]>{const db=await database();const rows=await result<StoredAsset[]>(db.transaction('queue').objectStore('queue').index('scope').getAll(IDBKeyRange.only(scope),limit));return rows.map(({scope,...asset})=>asset);}
export function mergeQuotes(state:CatalogState,assets:Asset[],report:Scan):CatalogState{
 const replaced=new Set(assets.map(a=>a.address.toLowerCase()));
 const routes=[...(state.report?.routes||[]).filter(r=>!replaced.has(r.token.toLowerCase())),...report.routes.map(r=>({...r,quotedAt:report.at,quoteBlock:report.block}))];
 routes.sort((a,b)=>{const x=parseUnits(a.net,18),y=parseUnits(b.net,18);return x>y?-1:x<y?1:0;});
 return {...state,quoted:state.quoted+assets.length,routeCount:state.routeCount+report.routes.length,qualifying:state.qualifying+report.routes.filter(r=>r.profitable).length,updatedAt:new Date().toISOString(),report:{...report,routes:routes.slice(0,200),notes:report.notes.slice(0,20)}};
}
export async function saveQuotes(state:CatalogState,assets:Asset[],report:Scan){const next=mergeQuotes(state,assets,report),db=await database(),tx=db.transaction(['state','queue','failures'],'readwrite'),done=finished(tx);for(const a of assets){const key=[state.scope,a.address.toLowerCase()];if(await result(tx.objectStore('failures').get(key)))next.quoteFailures=Math.max(0,(next.quoteFailures||0)-1);tx.objectStore('failures').delete(key);tx.objectStore('queue').delete(key);}tx.objectStore('state').put(next);await done;return next;}
export async function skipQuotes(state:CatalogState,assets:Asset[],message:string){
 const failed=new Set(assets.map(a=>a.address.toLowerCase())),next={...state,report:state.report?{...state.report,routes:state.report.routes.filter(r=>!failed.has(r.token.toLowerCase()))}:null,quoteFailures:state.quoteFailures||0,updatedAt:new Date().toISOString()},db=await database(),tx=db.transaction(['state','queue','failures'],'readwrite'),done=finished(tx);
 for(const a of assets){const key=[state.scope,a.address.toLowerCase()];if(!await result(tx.objectStore('failures').get(key)))next.quoteFailures++;tx.objectStore('failures').put({...a,address:a.address.toLowerCase(),scope:state.scope,message:message.slice(0,280),at:next.updatedAt});tx.objectStore('queue').delete(key);}tx.objectStore('state').put(next);await done;return next;
}
export async function readQuoteFailures(scope:string):Promise<QuoteFailure[]>{const db=await database();return result(db.transaction('failures').objectStore('failures').index('scope').getAll(IDBKeyRange.only(scope),50));}
export async function retryQuoteFailures(state:CatalogState){const next={...state,phase:'paused' as const,updatedAt:new Date().toISOString()},db=await database(),tx=db.transaction(['state','failures','queue'],'readwrite'),done=finished(tx);const cursor=tx.objectStore('failures').index('scope').openCursor(IDBKeyRange.only(state.scope));cursor.onsuccess=()=>{const c=cursor.result;if(c){const {scope,message,at,...asset}=c.value;tx.objectStore('queue').put({...asset,scope});c.continue();}else tx.objectStore('state').put(next);};await done;return next;}
export async function readPairPage(scope:string,router:string,offset:number,limit=32):Promise<PairRecord[]>{const db=await database();return result(db.transaction('pairs').objectStore('pairs').getAll(IDBKeyRange.bound([scope,router.toLowerCase(),offset],[scope,router.toLowerCase(),offset+limit-1])));}
export async function clearCatalog(scope:string){
 const db=await database(),tx=db.transaction(['state','pairs','assets','queue','failures'],'readwrite'),done=finished(tx);tx.objectStore('state').delete(scope);
 for(const name of ['pairs','assets','queue','failures']){const cursor=tx.objectStore(name).index('scope').openCursor(IDBKeyRange.only(scope));cursor.onsuccess=()=>{const c=cursor.result;if(c){c.delete();c.continue();}};}
 await done;
}
