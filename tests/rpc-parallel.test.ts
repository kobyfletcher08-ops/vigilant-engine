import test from 'node:test';
import assert from 'node:assert/strict';
import {Rpc} from '../lib/rpc.ts';
test('parallel read batches preserve request order with a bounded in-flight count',async()=>{
  let active=0,max=0;
  const rpc=new Rpc('http://localhost:8545',async(_url,options)=>{
    const payload=JSON.parse(String(options!.body));active++;max=Math.max(max,active);
    await new Promise(r=>setTimeout(r,30-payload[0].params[0]));active--;
    return Response.json(payload.reverse().map((p:any)=>({id:p.id,result:p.params[0]})));
  },{batchSize:4,concurrency:2});
  const results=await rpc.batch(Array.from({length:12},(_,i)=>({method:'eth_blockNumber',params:[i]})));
  assert.deepEqual(results.map(r=>r.value),Array.from({length:12},(_,i)=>i));assert.equal(max,2);
});
test('broadcast batches stay sequential and are never retried by the RPC batcher',async()=>{
  let active=0,max=0,calls=0;
  const rpc=new Rpc('http://localhost:8545',async(_url,options)=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;return Response.json(JSON.parse(String(options!.body)).map((p:any)=>({id:p.id,result:'0xhash'})));},{batchSize:1,concurrency:4});
  await rpc.batch(Array.from({length:3},()=>({method:'eth_sendRawTransaction',params:['0xfixture']})));assert.equal(max,1);assert.equal(calls,3);
});
