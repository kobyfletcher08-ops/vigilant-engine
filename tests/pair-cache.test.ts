import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogScope,reconcileCatalog,readCatalog,saveCatalog,savePairPage,nextQuoteBatch,saveQuotes,skipQuotes,readQuoteFailures,retryQuoteFailures,readPairPage,refreshCatalog,clearCatalog,mergeQuotes} from '../lib/pair-cache.ts';
import {DEFAULT_CONFIG,networkDefaults} from '../lib/model.ts';
import type {Scan,Route} from '../lib/engine.ts';
import type {PairPage,PairRecord,DiscoveryInfo} from '../lib/pair-discovery.ts';
const router='0x'+'1'.repeat(40),factory='0x'+'2'.repeat(40),a='0x'+'3'.repeat(40),b='0x'+'4'.repeat(40);
const asset=(address:string)=>({address,symbol:address===a?'A':'B',enabled:true});
const info:DiscoveryInfo={chainId:56,block:100,wbnb:'0x'+'5'.repeat(40),targets:[{router,factory,name:'DEX',total:40,cursor:0}],errors:[]};
function page(cursor:number,nextCursor:number):PairPage{return {router,factory,cursor,nextCursor,total:40,block:100,pairs:Array.from({length:nextCursor-cursor},(_,i)=>({index:cursor+i,router,dex:'DEX',factory,address:'0x'+(cursor+i+100).toString(16).padStart(40,'0'),status:'ready',asset:asset(i%2?a:b),wbnbReserve:'100.0',block:100} as PairRecord))};}
function route(token:string,net:string):Route{return {id:token+':'+router+':'+factory,symbol:asset(token).symbol,token,buyName:'DEX',sellName:'Other',buyRouter:router,sellRouter:factory,buyPair:router,sellPair:factory,loanPair:a,amount:'1',assetOut:'2',minAssetOut:'1',wbnbOut:'3',net,gross:net,devFee:'0',flashFee:'0',gasBudget:'0.002',profitable:Number(net)>0,minProfit:'1',minWbnbOut:'1'};}
const report=(routes:Route[]):Scan=>({at:new Date().toISOString(),block:100,timestamp:100,chainId:56,wbnb:info.wbnb,gasGwei:'1',gasAllowed:true,dexes:[],pools:[],routes,notes:[]});
test('catalog upgrades preserve version-1 cursors and pair records',async()=>{
 const scope=crypto.randomUUID(),old=reconcileCatalog(scope,info,null);old.targets[0].cursor=16;old.discovered=1;
 await new Promise<void>((resolve,reject)=>{const open=indexedDB.open('bsc-arb-pair-catalog',1);open.onupgradeneeded=()=>{const db=open.result;db.createObjectStore('state',{keyPath:'scope'});const pairs=db.createObjectStore('pairs',{keyPath:['scope','router','index']});pairs.createIndex('scope','scope');for(const name of ['assets','queue']){const s=db.createObjectStore(name,{keyPath:['scope','address']});s.createIndex('scope','scope');}};open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction(['state','pairs'],'readwrite');tx.objectStore('state').put(old);tx.objectStore('pairs').put({...page(0,1).pairs[0],scope});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
 assert.equal((await readCatalog(scope))?.targets[0].cursor,16);assert.equal((await readPairPage(scope,router,0))[0].index,0);assert.deepEqual(await readQuoteFailures(scope),[]);await clearCatalog(scope);
});
test('catalog persists resumable pages, deduplicates assets, commits quote progress and refreshes every cached token',async()=>{
 const scope=crypto.randomUUID();let state=await saveCatalog(reconcileCatalog(scope,info,null));state=await savePairPage(state,page(0,32));
 const saved=await readCatalog(scope);assert.equal(saved?.targets[0].cursor,32);assert.equal(saved?.discovered,32);assert.equal(saved?.assets,2);assert.equal((await readPairPage(scope,router,0)).length,32);
 const queued=await nextQuoteBatch(scope);assert.equal(queued.length,2);
 state=await saveQuotes(state,[queued[0]],report([route(queued[0].address,'-0.00586574')]));assert.equal((await nextQuoteBatch(scope)).length,1);assert.equal((await readCatalog(scope))?.quoted,1);
 await assert.rejects(savePairPage(state,page(0,32)),/saved scan cursor/);assert.equal((await readCatalog(scope))?.targets[0].cursor,32);
 state=await savePairPage(state,page(32,40));assert.equal(state.assets,2);assert.equal(state.discovered,40);assert.equal((await readPairPage(scope,router,32)).length,8);
 state=await saveQuotes(state,[queued[1]],report([route(queued[1].address,'0.001')]));assert.equal((await nextQuoteBatch(scope)).length,0);assert.equal(state.report?.routes[0].net,'0.001');
 const cycle=state.cycle;state=await refreshCatalog({...state,phase:'complete'});assert.notEqual(state.cycle,cycle);assert.equal(state.quoted,0);assert.equal(state.report,null);assert.equal(state.targets[0].cursor,40);assert.equal((await nextQuoteBatch(scope)).length,2);
 await clearCatalog(scope);assert.equal(await readCatalog(scope),null);assert.deepEqual(await nextQuoteBatch(scope),[]);assert.deepEqual(await readPairPage(scope,router,0),[]);
});
test('failed IndexedDB writes roll back records and the cursor together',async()=>{
 const scope=crypto.randomUUID(),state=await saveCatalog(reconcileCatalog(scope,info,null)),bad=page(0,32);
 (bad.pairs[1] as any).invalid=()=>{};
 await assert.rejects(savePairPage(state,bad));assert.equal((await readCatalog(scope))?.targets[0].cursor,0);assert.deepEqual(await readPairPage(scope,router,0),[]);assert.deepEqual(await nextQuoteBatch(scope),[]);await clearCatalog(scope);
});
test('rechecking an earlier page repairs unreadable pools without moving the discovery cursor',async()=>{
 const scope=crypto.randomUUID(),first=page(0,32);first.pairs[0].status='unreadable';delete first.pairs[0].asset;
 let state=await savePairPage(await saveCatalog(reconcileCatalog(scope,info,null)),first);assert.equal(state.unreadable,1);
 state=await savePairPage(state,page(0,32),true);assert.equal(state.unreadable,0);assert.equal(state.targets[0].cursor,32);assert.equal(state.discovered,32);assert.equal((await readPairPage(scope,router,0))[0].status,'ready');
 await clearCatalog(scope);
});
test('catalog scopes isolate networks/settings; append-only factory growth preserves cursors and factory changes require a rebuild',()=>{
 const c=structuredClone(DEFAULT_CONFIG);assert.notEqual(catalogScope(c),catalogScope({...c,network:97}));assert.notEqual(catalogScope(c),catalogScope({...c,minReserve:'1'}));
 assert.notEqual(catalogScope(c),catalogScope({...c,amount:'0.2'}));assert.notEqual(catalogScope(c),catalogScope({...c,gasBudget:'0.005'}));
 const old=reconcileCatalog('scope',info,null);old.targets[0].cursor=40;
 const appended={...info,targets:[{...info.targets[0],total:42}]};assert.equal(reconcileCatalog('scope',appended,old).targets[0].cursor,40);
 assert.throws(()=>reconcileCatalog('scope',{...info,targets:[{...info.targets[0],factory:a}]},old),/Rebuild/);
 assert.throws(()=>reconcileCatalog('scope',{...info,targets:[{...info.targets[0],total:39}]},old),/Rebuild/);
});
test('quote aggregation bounds UI memory, orders losses correctly and removes routes missing from a fresh batch',()=>{
 const state=reconcileCatalog('scope',info,null),many=Array.from({length:250},(_,i)=>route('0x'+(i+100).toString(16).padStart(40,'0'),'-'+(i+1).toString()));
 const merged=mergeQuotes(state,[],report(many));assert.equal(merged.report?.routes.length,200);assert.equal(merged.report?.routes[0].net,'-1');assert.equal(merged.routeCount,250);assert.equal(merged.qualifying,0);
 const token=merged.report!.routes[0].token,next=mergeQuotes(merged,[asset(token)],report([]));assert.ok(!next.report?.routes.some(r=>r.token===token));assert.equal(next.report?.routes[0].net,'-2');assert.ok(next.report?.routes.every(r=>r.quotedAt&&r.quoteBlock===100));
});
test('failed token quotes are saved once, excluded from success counts and requeued for recovery',async()=>{
 const scope=crypto.randomUUID();let state=await savePairPage(await saveCatalog(reconcileCatalog(scope,info,null)),page(0,32));
 state={...state,report:report([route(a,'0.01'),route(b,'0.02')])};state=await skipQuotes(state,[asset(a)],'RPC quotes temporarily unavailable.');assert.equal(state.quoted,0);assert.equal(state.quoteFailures,1);assert.ok(!state.report?.routes.some(r=>r.token===a));
 state=await skipQuotes(state,[asset(a)],'RPC quotes temporarily unavailable again.');assert.equal(state.quoteFailures,1);assert.equal((await readQuoteFailures(scope)).length,1);assert.equal((await readCatalog(scope))?.quoteFailures,1);
 state=await saveQuotes(state,[asset(b)],report([route(b,'0.02')]));assert.deepEqual(await nextQuoteBatch(scope),[]);
 state=await retryQuoteFailures({...state,phase:'complete'});assert.equal(state.phase,'paused');assert.equal((await nextQuoteBatch(scope))[0].address,a);
 state=await saveQuotes(state,[asset(a)],report([route(a,'0.01')]));assert.equal(state.quoteFailures,0);assert.equal(state.quoted,2);assert.deepEqual(await readQuoteFailures(scope),[]);await clearCatalog(scope);
});
test('refresh and clear remove only the current scope failed-quote list',async()=>{
 const scope=crypto.randomUUID(),other=crypto.randomUUID();let state=await savePairPage(await saveCatalog(reconcileCatalog(scope,info,null)),page(0,32)),second=await savePairPage(await saveCatalog(reconcileCatalog(other,info,null)),page(0,32));
 state=await skipQuotes(state,[asset(a)],'RPC failed');await skipQuotes(second,[asset(b)],'RPC failed');state=await refreshCatalog(state);assert.equal(state.quoteFailures,0);assert.deepEqual(await readQuoteFailures(scope),[]);assert.equal((await readQuoteFailures(other)).length,1);await clearCatalog(scope);await clearCatalog(other);
});
test('BSC and Arbitrum catalogs preserve separate cursors, pool records and quote queues',async()=>{
 const bsc=networkDefaults(56),arb=networkDefaults(42161),bscScope=catalogScope(bsc),arbScope=catalogScope(arb);assert.notEqual(bscScope,arbScope);
 let bscState=await saveCatalog(reconcileCatalog(bscScope,info,null)),arbState=await saveCatalog(reconcileCatalog(arbScope,{...info,chainId:42161,wbnb:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'},null));
 bscState=await savePairPage(bscState,page(0,32));arbState=await savePairPage(arbState,page(0,8));
 await skipQuotes(arbState,[asset(a)],'Arbitrum quote failed');assert.equal((await readCatalog(bscScope))?.targets[0].cursor,32);assert.equal((await readCatalog(arbScope))?.targets[0].cursor,8);
 assert.equal((await readPairPage(bscScope,router,16)).length,16);assert.equal((await readPairPage(arbScope,router,16)).length,0);
 assert.equal((await nextQuoteBatch(bscScope)).length,2);assert.equal((await nextQuoteBatch(arbScope)).length,1);assert.equal((await readQuoteFailures(bscScope)).length,0);
 await clearCatalog(arbScope);assert.equal((await readCatalog(bscScope))?.targets[0].cursor,32);assert.equal((await nextQuoteBatch(bscScope)).length,2);await clearCatalog(bscScope);
});
