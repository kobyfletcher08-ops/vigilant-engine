import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig,DEFAULT_CONFIG,profitBounds,repayment,safeRpc} from '../lib/model.ts';
import {Rpc} from '../lib/rpc.ts';
import {resolveIntent,canonicalRuntime} from '../lib/engine.ts';
import artifact from '../artifacts/FlashArbitrageV2.json' with {type:'json'};
const config=()=>structuredClone(DEFAULT_CONFIG);

test('configuration validates decimals, network, RPC, slippage and duplicate addresses',()=>{
 assert.equal(validateConfig(config()).network,56);
 assert.throws(()=>validateConfig({...config(),network:1}),/BSC/);
 assert.throws(()=>validateConfig({...config(),amount:'1e3'}),/decimal/);
 assert.throws(()=>validateConfig({...config(),amount:'2',maxAmount:'1'}),/maximum/);
 assert.throws(()=>validateConfig({...config(),slippageBps:201}),/Slippage/);
 assert.throws(()=>validateConfig({...config(),dexes:[config().dexes[0],config().dexes[0]]}),/Duplicate/);
 for(const url of ['http://localhost','https://127.0.0.1','https://u:p@example.com','https://10.0.0.1','https://[::1]'])assert.throws(()=>safeRpc(url));
 assert.equal(safeRpc('https://example.com/rpc?key=test'),'https://example.com/rpc?key=test');
});

test('repayment rounds up at the fee-adjusted divisor and profit includes gas/dev fees',()=>{
 assert.equal(repayment(1n),2n);
 assert.equal(repayment(9975n),10000n);
 const bound=profitBounds(12000n,9975n,100n,200n);assert.equal(bound.repay,10000n);assert.equal(bound.dev,40n);assert.equal(bound.net,1860n);assert.equal(bound.qualifies,true);
 const small=profitBounds(10001n,9975n,100n,200n);assert.equal(small.qualifies,false);
 assert.equal(profitBounds(9000n,9975n,100n,200n).net,-1100n);
});

test('RPC batches correlate IDs and contain no broadcasting methods',async()=>{
 const seen:any[]=[];const request=(async(_url:any,options:any)=>{const data=JSON.parse(options.body);seen.push(...data);return Response.json([...data].reverse().map((r:any)=>({id:r.id,jsonrpc:'2.0',result:r.params[0]})));}) as typeof fetch;
 const rpc=new Rpc('https://example.com',request);const result=await rpc.batch([{method:'eth_chainId',params:['0x38']},{method:'eth_blockNumber',params:['0x7']}]);
 assert.equal(result[0].value,'0x38');assert.equal(result[1].value,'0x7');assert.ok(seen.every(x=>x.method.startsWith('eth_')));
 const malformed=new Rpc('https://example.com',async()=>Response.json([{id:0,result:'bad'}]));assert.ok((await malformed.batch([{method:'eth_chainId',params:[]}]))[0].error);
});

test('RPC uses an edge-supported redirect policy and refuses redirect responses',async()=>{
 for(const status of [301,302,303,307,308]){
  let requests=0;
  const request=(async(_url:any,options:any)=>{
   requests++;assert.equal(options.redirect,'manual');
   return new Response(null,{status,headers:{location:'https://other.example/rpc'}});
  }) as typeof fetch;
  await assert.rejects(new Rpc('https://example.com/rpc',request).send('eth_chainId'),/RPC endpoint redirected.*direct HTTPS URL/);
  assert.equal(requests,1);
 }
});
test('RPC distinguishes transient provider errors from contract reverts without exposing upstream messages',async()=>{
 const rpc=new Rpc('https://example.com',async(_url,options)=>{const items=JSON.parse(String(options!.body));return Response.json(items.map((item:any,i:number)=>({id:item.id,error:{code:-32000,message:i===0?'rate limit exceeded; provider credential=secret':'execution reverted'}})));});
 const result=await rpc.batch([{method:'eth_call',params:[]},{method:'eth_call',params:[]}]);assert.equal(result[0].retryable,true);assert.equal(result[1].retryable,false);assert.ok(!JSON.stringify(result).includes('secret'));
});

test('uncertain submission recovery requires the exact owner, nonce, target and calldata',async()=>{
 const request={from:'0x'+'1'.repeat(40),to:'0x'+'2'.repeat(40),nonce:'0x1',data:'0xabcd',value:'0x0'},hash='0x'+'3'.repeat(64);
 const rpc={send:async(method:string)=>method==='eth_chainId'?'0x38':{...request,input:request.data}} as unknown as Rpc;
 assert.equal((await resolveIntent(config(),hash,request,rpc)).hash,hash);
 await assert.rejects(resolveIntent(config(),hash,{...request,nonce:'0x2'},rpc),/match/);
});

test('runtime verification ignores immutable slots and detects changed executable bytes',()=>{
 const hash=canonicalRuntime(artifact.runtime),bytes=Buffer.from(artifact.runtime.slice(2),'hex');
 const refs=Object.values(artifact.immutableReferences).flat() as {start:number,length:number}[];assert.ok(refs.length>0);bytes.fill(1,refs[0].start,refs[0].start+refs[0].length);assert.equal(canonicalRuntime('0x'+bytes.toString('hex')),hash);
 bytes[0]^=1;assert.notEqual(canonicalRuntime('0x'+bytes.toString('hex')),hash);
});
