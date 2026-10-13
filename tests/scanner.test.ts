import test from 'node:test';
import assert from 'node:assert/strict';
import {AbiCoder,Interface,parseEther,parseUnits,toQuantity} from 'ethers';
import {scan,prepare,receipts} from '../lib/engine.ts';
import {networkDefaults,NETWORKS,DEV_ADDRESS,same,type NetworkId} from '../lib/model.ts';
import {Rpc,FN} from '../lib/rpc.ts';
import artifact from '../artifacts/FlashArbitrageV2.json' with {type:'json'};
const factoryB='0x'+'9'.repeat(40);
const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40),c='0x'+'3'.repeat(40),d='0x'+'4'.repeat(40);
const owner='0x'+'8'.repeat(40);
function mock(network:NetworkId=56){
 const config=networkDefaults(network),net=NETWORKS[network],wrapped=network===42161?'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1':'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';config.tokens=config.tokens.slice(0,2);config.dexes=config.dexes.slice(0,2);
 const assets=structuredClone(config.tokens),pools=[{address:a,token:assets[0].address},{address:b,token:assets[1].address},{address:c,token:assets[0].address},{address:d,token:assets[1].address}];
 const answer=(call:any)=>{if(call.fn===FN.wrapped)return [wrapped];if(call.fn===FN.factory)return [same(call.to,net.router)?net.factory:factoryB];if(call.fn===FN.decimals)return [18n];if(call.fn===FN.pair){const token=call.args[1],index=assets.findIndex(t=>same(t.address,token));return [pools[index+(same(call.to,net.factory)?0:2)].address];}
 const verified:{[fn:string]:unknown[]}={'function owner() view returns(address)':[owner],'function wbnb() view returns(address)':[wrapped],'function pancakeFactory() view returns(address)':[net.factory],'function DEV_ADDRESS() view returns(address)':[DEV_ADDRESS],'function DEV_FEE_BPS() view returns(uint256)':[200n],'function tradesExecuted() view returns(uint256)':[0n],'function totalProfit() view returns(uint256)':[0n],'function totalDevFees() view returns(uint256)':[0n],'function allowedRouter(address) view returns(bool)':[true]};if(verified[call.fn])return verified[call.fn];
 const pool=pools.find(p=>same(p.address,call.to));if(call.fn===FN.t0)return [wrapped];if(call.fn===FN.t1)return [pool!.token];if(call.fn===FN.reserves)return [parseEther('200'),parseUnits('400000',network===42161?6:18),0n];
 if(call.fn===FN.out){const input=BigInt(call.args[0]),path=call.args[1],rate=same(call.to,net.router)?2000n:2100n,scale=network===42161?10n**12n:1n;return [[input,same(path[0],wrapped)?input*rate/scale:input*scale/rate]];}
 throw Error('Unexpected mock call '+call.fn);
 };
 const rpc={send:async(method:string)=>{if(method==='eth_getCode')return artifact.runtime;if(method==='eth_call')return '0x';if(method==='eth_estimateGas')return '0x186a0';throw Error('Unexpected mock method '+method);},batch:async(items:any[])=>items.map(i=>({value:i.method==='eth_chainId'?toQuantity(network):i.method==='eth_gasPrice'?(network===42161?'0x989680':'0x1'):i.method==='eth_getTransactionCount'?'0x0':i.method==='eth_getBalance'?toQuantity(parseEther('1')):{number:'0x64',timestamp:toQuantity(Math.floor(Date.now()/1000))}})),call:async(to:string,fn:string,args:any[]=[])=>answer({to,fn,args}),calls:async(items:any[])=>items.map(x=>({value:answer(x)}))} as unknown as Rpc;
 return {config,rpc,wrapped};
}
test('scanner calculates both round-trip directions and uses a lender distinct from both trading pools',async()=>{
 const {config,rpc}=mock(),result=await scan(config,rpc);
 assert.equal(result.routes.length,4);assert.ok(result.routes.some(r=>r.profitable));assert.ok(result.routes.some(r=>Number(r.net)<0));
 assert.ok(result.routes.every(r=>!same(r.loanPair,r.buyPair)&&!same(r.loanPair,r.sellPair)));
 assert.equal(result.block,100);assert.ok(Number(result.routes[0].net)>=Number(result.routes[3].net));
 for(const route of result.routes){assert.equal(route.amount,parseEther(config.amount).toString());assert.equal(route.gasBudget,config.gasBudget);assert.ok(BigInt(route.minAssetOut)<BigInt(route.assetOut));}
});
test('reserve-share cap excludes routes rather than manufacturing quotes',async()=>{
 const {config,rpc}=mock();config.amount='4';config.maxAmount='5';const result=await scan(config,rpc);assert.equal(result.routes.length,0);assert.ok(result.notes.some(n=>n.includes('reserve limits')));
});
test('discovered tokens outside the manual list receive fresh round-trip quotes with a separate lender',async()=>{
 const {config,rpc}=mock(),discovered=config.tokens[0];config.tokens=config.tokens.slice(1);const result=await scan(config,rpc,[discovered]);
 assert.equal(result.routes.length,2);assert.ok(result.routes.some(r=>r.profitable));assert.ok(result.routes.every(r=>same(r.token,discovered.address)&&!same(r.loanPair,r.buyPair)&&!same(r.loanPair,r.sellPair)));
 assert.equal(config.tokens.length,1);assert.ok(!config.tokens.some(t=>same(t.address,discovered.address)));
});
test('transaction preparation re-quotes a discovered token and rejects routes after limits change',async()=>{
 const {config,rpc}=mock(),discovered=config.tokens[0];config.tokens=config.tokens.slice(1);config.contract='0x'+'7'.repeat(40);
 const quoted=await scan(config,rpc,[discovered]),route=quoted.routes.find(r=>r.profitable)!;
 const preview=await prepare(config,'trade',{owner,routeId:route.id,symbol:discovered.symbol},rpc);
 assert.equal(preview.kind,'trade');assert.ok('route' in preview);assert.equal(preview.route.token.toLowerCase(),discovered.address.toLowerCase());
 const trade=new Interface(artifact.abi).decodeFunctionData('startArb',preview.transaction.data)[0];assert.equal(trade.token.toLowerCase(),discovered.address.toLowerCase());assert.equal(trade.amount,parseEther(config.amount));
 config.minProfit='1';await assert.rejects(prepare(config,'trade',{owner,routeId:route.id},rpc),/no longer meets/);
 await assert.rejects(prepare(config,'trade',{owner,routeId:'invalid'},rpc),/Invalid route identifier/);
});
test('transient quote failures stop a batch so its token queue can be retried',async()=>{
 const {config,rpc}=mock(),calls=rpc.calls.bind(rpc);rpc.calls=async(items)=>items.some(i=>i.fn===FN.out)?items.map(()=>({error:'RPC call failed (-32005).',retryable:true})):calls(items);
 await assert.rejects(scan(config,rpc),/buy quotes temporarily unavailable/);
});
test('Arbitrum quotes WETH against six-decimal assets and prepares chain-specific deployment and trade calldata',async()=>{
 const {config,rpc,wrapped}=mock(42161),report=await scan(config,rpc);
 assert.equal(report.chainId,42161);assert.equal(report.wbnb,wrapped);assert.equal(report.routes.length,4);
 const route=report.routes.find(r=>r.profitable)!;assert.ok(route);assert.ok(BigInt(route.assetOut)<parseUnits('30',6));
 assert.ok(!same(route.loanPair,route.buyPair)&&!same(route.loanPair,route.sellPair));
 const deployment=await prepare(config,'deploy',{owner},rpc);
 assert.equal(Number(deployment.transaction.chainId),42161);assert.match(deployment.description,/Arbitrum One.*WETH/);
 const args=AbiCoder.defaultAbiCoder().decode(['address','address','address[]'],'0x'+deployment.transaction.data.slice(artifact.bytecode.length));
 assert.ok(same(args[0],wrapped));assert.ok(same(args[1],NETWORKS[42161].factory));assert.deepEqual(Array.from(args[2],String).map(x=>x.toLowerCase()),config.dexes.map(d=>d.address.toLowerCase()));
 config.contract='0x'+'7'.repeat(40);const trade=await prepare(config,'trade',{owner,routeId:route.id},rpc);
 assert.equal(Number(trade.transaction.chainId),42161);assert.match(trade.description,/WETH borrowed.*ETH/);assert.doesNotMatch(trade.description,/BNB/);
 const decoded=new Interface(artifact.abi).decodeFunctionData('startArb',trade.transaction.data)[0];assert.equal(decoded.amount,parseEther(config.amount));assert.ok(same(decoded.loanPair,route.loanPair));
 const withdraw=await prepare(config,'withdraw',{owner,token:'native',recipient:owner,amount:'0.001'},rpc);assert.match(withdraw.description,/0\.001 ETH/);
 const batch=rpc.batch.bind(rpc);rpc.batch=async(items)=>{const results=await batch(items);return results.map((r,i)=>items[i].method==='eth_chainId'?{value:'0x38'}:r);};
 await assert.rejects(scan(config,rpc),/different chain/);await assert.rejects(prepare(config,'deploy',{owner},rpc),/different chain/);
});
test('Arbitrum previews budget the full RPC gas estimate and reject insufficient ETH',async()=>{
 const {config,rpc}=mock(42161),send=rpc.send.bind(rpc),price=10000000n,estimate=1234567n;
 rpc.send=async(method,params)=>method==='eth_estimateGas'?toQuantity(estimate):send(method,params);
 const preview=await prepare(config,'deploy',{owner},rpc),limit=(estimate*125n+99n)/100n;
 assert.equal(BigInt(preview.transaction.gas),limit);assert.equal(parseEther(preview.cost),limit*price);
 config.gasBudget='0.00000001';await assert.rejects(prepare(config,'deploy',{owner},rpc),/fee budget/);
 config.gasBudget='0.00005';const batch=rpc.batch.bind(rpc);rpc.batch=async(items)=>{const results=await batch(items);return results.map((r,i)=>items[i].method==='eth_getBalance'?{value:'0x0'}:r);};
 await assert.rejects(prepare(config,'deploy',{owner},rpc),/more ETH for gas/);
});
test('Arbitrum receipt tracking uses total gas used and keeps network checks',async()=>{
 const {config,rpc}=mock(42161),hash='0x'+'a'.repeat(64),used=345678n,price=10000000n;
 rpc.send=async(method)=>method==='eth_chainId'?'0xa4b1':method==='eth_blockNumber'?'0x65':Promise.reject(Error('Unexpected receipt method'));
 rpc.batch=async()=>[{value:{blockNumber:'0x64',status:'0x1',gasUsed:toQuantity(used),effectiveGasPrice:toQuantity(price),contractAddress:null,logs:[]}}];
 const result=(await receipts(config,[{hash}],rpc))[0];assert.equal(result.status,'confirmed');assert.equal(result.confirmations,2);assert.equal(parseEther(result.cost!),used*price);
 rpc.send=async()=> '0x38';await assert.rejects(receipts(config,[{hash}],rpc),/chain mismatch/);
});
