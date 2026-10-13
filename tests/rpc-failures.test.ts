import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRpcError,rpcFailure,skippableRead} from '../lib/rpc-errors.ts';
import {validateRpcSettings} from '../lib/rpc-settings.ts';
import {configuredRpc} from '../lib/rpc.ts';
import {DEFAULT_CONFIG,validateConfig} from '../lib/model.ts';
test('internal contract reverts are not mislabeled as transient provider failures and diagnostic text is redacted',()=>{
 const reverted=classifyRpcError({code:-32603,message:'execution reverted; secret=fixture'});assert.equal(reverted.retryable,false);assert.equal(reverted.reason,'contract-revert');assert.ok(!JSON.stringify(reverted).includes('fixture'));
 const limited=classifyRpcError({code:-32005,message:'credential=hidden'}),block=classifyRpcError({code:-32000,message:'header not found'});assert.equal(limited.retryable,true);assert.equal(block.reason,'block-unavailable');assert.match(rpcFailure('pool data',[limited]),/slower pacing/);assert.match(rpcFailure('pool data',[block]),/pinned block/);
 assert.equal(skippableRead(Error('RPC pool data temporarily unavailable.')),true);assert.equal(skippableRead(Error('RPC is connected to a different chain.')),false);assert.equal(skippableRead(new DOMException('Scan paused','AbortError')),false);assert.equal(skippableRead(Error('Sign in required.')),false);
});
test('RPC settings migrate old configs, enable skipping and validate pacing limits',()=>{
 const s=validateRpcSettings(undefined);assert.equal(s.skipFailedPools,true);assert.equal(s.batchSize,8);assert.equal(s.pageSize,16);assert.equal(validateConfig(DEFAULT_CONFIG).rpcSettings?.skipFailedPools,true);
 for(const value of [{batchSize:1},{pageSize:1000},{delayMs:2001},{skipFailedPools:'yes'}])assert.throws(()=>validateRpcSettings(value));
 assert.equal(validateRpcSettings({skipFailedPools:false}).skipFailedPools,false);
});
test('configured RPC respects the smaller batch size and keeps all correlated results',async()=>{
 const config=validateConfig(DEFAULT_CONFIG);config.rpcSettings={...config.rpcSettings!,batchSize:4,delayMs:0};const chunks:number[]=[];
 const rpc=configuredRpc(config,async(_url,options)=>{const items=JSON.parse(String(options!.body));chunks.push(items.length);return Response.json(items.slice().reverse().map((i:any)=>({id:i.id,result:i.params[0]})));});
 const result=await rpc.batch(Array.from({length:10},(_,i)=>({method:'eth_blockNumber',params:[i]})));assert.deepEqual(chunks,[4,4,2]);assert.deepEqual(result.map(r=>r.value),Array.from({length:10},(_,i)=>i));
});
