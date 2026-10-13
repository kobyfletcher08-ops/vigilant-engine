import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteBatch} from '../lib/quote-batches.ts';
import type {Scan} from '../lib/engine.ts';
const tokens=['A','B','C'].map((symbol,i)=>({symbol,address:'0x'+String(i+1).repeat(40),enabled:true}));
const report:Scan={at:'2026-10-12T00:00:00Z',block:1,timestamp:1,chainId:56,wbnb:'0x'+'4'.repeat(40),gasGwei:'1',gasAllowed:true,dexes:[],pools:[],routes:[],notes:[]};
test('failed quote batches are isolated so only the failing token is skipped',async()=>{
 const calls:string[][]=[],quoted:string[]=[],skipped:string[]=[];
 await quoteBatch(tokens,async assets=>{calls.push(assets.map(a=>a.symbol));if(assets.length>1||assets[0].symbol==='B')throw Error('RPC quotes temporarily unavailable.');return report;},true,async assets=>{quoted.push(...assets.map(a=>a.symbol));},async asset=>{skipped.push(asset.symbol);},new AbortController().signal);
 assert.deepEqual(calls,[['A','B','C'],['A'],['B'],['C']]);assert.deepEqual(quoted,['A','C']);assert.deepEqual(skipped,['B']);
});
test('strict mode and wrong-chain errors stop quote processing instead of creating skipped records',async()=>{
 for(const [skip,message] of [[false,'RPC quotes temporarily unavailable.'],[true,'RPC is connected to a different chain.']] as const){let stored=0;await assert.rejects(quoteBatch(tokens,async()=>{throw Error(message);},skip,async()=>{stored++;},async()=>{stored++;},new AbortController().signal));assert.equal(stored,0);}
});
test('pause during isolated quote recovery stops before requesting the next token',async()=>{
 const abort=new AbortController(),calls:string[][]=[];let skipped=0;
 await assert.rejects(quoteBatch(tokens,async assets=>{calls.push(assets.map(a=>a.symbol));if(assets.length>1)throw Error('RPC quotes temporarily unavailable.');return report;},true,async()=>{abort.abort();},async()=>{skipped++;},abort.signal),e=>(e as Error).name==='AbortError');
 assert.deepEqual(calls,[['A','B','C'],['A']]);assert.equal(skipped,0);
});
