import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeBytes32String,parseEther,toQuantity,ZeroAddress} from 'ethers';
import {discoverFactories,discoverPage,PAIR_PAGE_SIZE} from '../lib/pair-discovery.ts';
import {networkDefaults,NETWORKS,scanAssets,same,type NetworkId} from '../lib/model.ts';
import {Rpc,FN} from '../lib/rpc.ts';
import {DEFAULT_RPC_SETTINGS} from '../lib/rpc-settings.ts';
const wrapped='0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',factoryB='0x'+'9'.repeat(40),extra='0x'+'6'.repeat(40);
const poolAddress=(i:number)=>'0x'+(i+100).toString(16).padStart(40,'0');
function setup(network:NetworkId=56){
 const config=networkDefaults(network),wrapped=network===42161?'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1':'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';config.dexes=config.dexes.slice(0,2);config.rpcSettings={...DEFAULT_RPC_SETTINGS,pageSize:32,skipFailedPools:false};const seen:{index:number,block:number}[]=[];
 let incomplete=false,unavailable=false,missingMetadata=false,rateLimited=false,poolFailure=false;
 const answer=(call:any)=>{
  if(call.fn===FN.wrapped)return [wrapped];
  if(call.fn===FN.factory)return [same(call.to,config.dexes[1].address)?factoryB:same(call.to,poolAddress(4))?factoryB:NETWORKS[network].factory];
  if(call.fn===FN.decimals){if(missingMetadata&&same(call.to,extra))throw Error('Optional decimals absent');if(rateLimited&&!same(call.to,wrapped))throw Object.assign(Error('Rate limited'),{retryable:true});return [18n];}
  if(call.fn===FN.allPairsLength){if(unavailable&&same(call.to,factoryB))throw Error('Unsupported factory');return [40n];}
  if(call.fn===FN.allPairs){const index=Number(call.args[0]);seen.push({index,block:call.block});if(incomplete&&index===7)throw Error('RPC partial');return [poolAddress(index)];}
  const index=Number(BigInt(call.to))-100;
  if(call.fn===FN.t0)return [index<2?wrapped:index===2?extra:config.tokens[0].address];
  if(call.fn===FN.t1)return [index<2?config.tokens[index].address:index===2?wrapped:config.tokens[1].address];
  if(call.fn===FN.reserves){if(poolFailure&&index===1)throw Object.assign(Error('RPC call failed (-32005; rate-limit).'),{retryable:true});if(index===6)throw Error('Unavailable reserves');return index===1?[parseEther('1'),100n,0n]:[parseEther('200'),parseEther('400'),0n];}
  if(call.fn===FN.symbol){if(same(call.to,extra))throw Error('Bytes32 symbol');return ['USD<script>'];}
  if(call.fn===FN.symbolBytes)return [encodeBytes32String('NEW')];
  throw Error('Unexpected call '+call.fn);
 };
 const rpc={batch:async(items:any[])=>items.map(i=>({value:i.method==='eth_chainId'?toQuantity(network):i.method==='eth_gasPrice'?'0x1':{number:'0x64',timestamp:toQuantity(Math.floor(Date.now()/1000))}})),call:async(to:string,fn:string,args:any[]=[],block?:number)=>answer({to,fn,args,block}),calls:async(items:any[])=>items.map(x=>{try{return {value:answer(x)};}catch(e){return {error:(e as Error).message,retryable:Boolean((e as any).retryable)};}})} as unknown as Rpc;
 return {config,rpc,seen,wrapped,setIncomplete:()=>{incomplete=true;},setUnavailable:()=>{unavailable=true;},setMissingMetadata:()=>{missingMetadata=true;},setRateLimited:()=>{rateLimited=true;},setPoolFailure:()=>{poolFailure=true;}};
}
test('factory discovery verifies enabled routers, reports every pair count and surfaces unavailable factories',async()=>{
 const {config,rpc,setUnavailable}=setup(),info=await discoverFactories(config,rpc);assert.equal(info.targets.length,2);assert.equal(info.targets[0].total,40);assert.equal(info.wbnb,wrapped);assert.equal(info.block,100);
 setUnavailable();const partial=await discoverFactories(config,rpc);assert.equal(partial.targets.length,1);assert.equal(partial.errors.length,1);assert.equal(partial.errors[0].name,'Biswap');
});
test('pair pages cover every index including the final partial page, pin reads to a block and classify all pools',async()=>{
 const {config,rpc,seen}=setup();const first=await discoverPage(config,{router:config.dexes[0].address,cursor:0},rpc),last=await discoverPage(config,{router:config.dexes[0].address,cursor:first.nextCursor},rpc);
 assert.equal(first.pairs.length,PAIR_PAGE_SIZE);assert.equal(last.pairs.length,8);assert.equal(last.nextCursor,40);
 assert.deepEqual(seen.map(x=>x.index),Array.from({length:40},(_,i)=>i));assert.ok(seen.every(x=>x.block===100));
 assert.equal(first.pairs[0].status,'ready');assert.equal(first.pairs[1].status,'low-liquidity');assert.equal(first.pairs[1].wbnbReserve,'1.0');
 assert.equal(first.pairs[2].asset?.address.toLowerCase(),extra);assert.equal(first.pairs[2].asset?.symbol,'NEW');assert.equal(first.pairs[2].wbnbReserve,'400.0');
 assert.equal(first.pairs[3].status,'catalog-only');assert.equal(first.pairs[4].status,'unreadable');assert.match(first.pairs[4].error!,/factory mismatch/);assert.equal(first.pairs[6].status,'unreadable');
 assert.equal((await discoverPage(config,{router:config.dexes[0].address,cursor:40},rpc)).pairs.length,0);
});
test('failed enumeration cannot advance a page and unconfigured routers or invalid cursors are refused',async()=>{
 const {config,rpc,setIncomplete}=setup();setIncomplete();await assert.rejects(discoverPage(config,{router:config.dexes[0].address,cursor:0},rpc),/Retry resumes at the same pair index/);
 for(const cursor of [-1,1.5,41,Number.MAX_SAFE_INTEGER+1])await assert.rejects(discoverPage(config,{router:config.dexes[0].address,cursor},rpc));
 await assert.rejects(discoverPage(config,{router:extra,cursor:0},rpc),/enabled router/);
});
test('discovered-token scan batches validate addresses, limit work and deduplicate without a manual-list limit',()=>{
 assert.equal(scanAssets([{address:extra,symbol:'<NEW>'}])[0].symbol,'NEW');assert.equal(scanAssets([{address:extra}])[0].address.toLowerCase(),extra);
 for(const input of [[],Array.from({length:5},()=>({address:extra})),[{address:ZeroAddress}],[{address:extra},{address:extra}],null])assert.throws(()=>scanAssets(input));
});
test('optional ERC-20 metadata does not exclude a verified WBNB pool from raw-unit route quotes',async()=>{
 const {config,rpc,setMissingMetadata}=setup();setMissingMetadata();const page=await discoverPage(config,{router:config.dexes[0].address,cursor:0},rpc),pair=page.pairs[2];
 assert.equal(pair.status,'ready');assert.equal(pair.asset?.symbol,'NEW');assert.equal(pair.decimals,undefined);assert.match(pair.metadataError!,/raw token units/);
});
test('transient metadata errors stop the page instead of recording pools as unreadable',async()=>{
 const {config,rpc,setRateLimited}=setup();setRateLimited();await assert.rejects(discoverPage(config,{router:config.dexes[0].address,cursor:0},rpc),/Cursor unchanged/);
});
test('skip mode records an unreadable factory index and continues without shifting pool details',async()=>{
 const {config,rpc,setIncomplete}=setup();config.rpcSettings!.skipFailedPools=true;setIncomplete();const result=await discoverPage(config,{router:config.dexes[0].address,cursor:0},rpc);
 assert.equal(result.nextCursor,32);assert.equal(result.pairs.length,32);assert.equal(result.pairs[7].address,undefined);assert.equal(result.pairs[7].status,'unreadable');assert.match(result.pairs[7].error!,/Factory index lookup/);
 assert.equal(result.pairs[8].index,8);assert.equal(result.pairs[8].address?.toLowerCase(),poolAddress(8));assert.equal(result.pairs[2].asset?.symbol,'NEW');
});
test('skip mode isolates transient pool failures; strict mode keeps the cursor retryable',async()=>{
 const {config,rpc,setPoolFailure}=setup();setPoolFailure();await assert.rejects(discoverPage(config,{router:config.dexes[0].address,cursor:0},rpc),/Cursor unchanged/);
 config.rpcSettings!.skipFailedPools=true;config.rpcSettings!.pageSize=8;const result=await discoverPage(config,{router:config.dexes[0].address,cursor:0},rpc);
 assert.equal(result.nextCursor,8);assert.equal(result.pairs[1].status,'unreadable');assert.equal(result.pairs[1].asset,undefined);assert.match(result.pairs[1].error!,/rate-limit/);assert.equal(result.pairs[0].status,'ready');assert.equal(result.pairs[2].status,'ready');
});

test('Arbitrum all-pairs discovery uses its factories, WETH reserves and network-bound pages',async()=>{
 const {config,rpc,wrapped,seen}=setup(42161),info=await discoverFactories(config,rpc);
 assert.equal(info.chainId,42161);assert.equal(info.wbnb,wrapped);assert.equal(info.targets.length,2);assert.equal(info.targets[0].factory,NETWORKS[42161].factory);
 const page=await discoverPage(config,{router:config.dexes[0].address,cursor:0},rpc);assert.equal(page.factory,NETWORKS[42161].factory);assert.equal(page.nextCursor,32);
 assert.equal(page.pairs[0].token0?.toLowerCase(),wrapped.toLowerCase());assert.equal(page.pairs[0].status,'ready');assert.equal(page.pairs[0].wbnbReserve,'200.0');assert.equal(page.pairs[1].status,'low-liquidity');assert.equal(seen.length,32);
 const batch=rpc.batch.bind(rpc);rpc.batch=async(items)=>{const results=await batch(items);return results.map((r,i)=>items[i].method==='eth_chainId'?{value:'0x38'}:r);};
 await assert.rejects(discoverPage(config,{router:config.dexes[0].address,cursor:32},rpc),/different chain/);
});
