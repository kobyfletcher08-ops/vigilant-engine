import test from 'node:test';
import assert from 'node:assert/strict';
import {retryRead} from '../lib/read-retry.ts';
test('scanner reads retry temporary failures at most three times and leave business errors unchanged',async()=>{
 const signal=new AbortController().signal;let calls=0;const retries:number[]=[];
 assert.equal(await retryRead(async()=>{if(++calls<3)throw Error('RPC quotes temporarily unavailable.');return 'ok';},signal,n=>retries.push(n),0),'ok');assert.equal(calls,3);assert.deepEqual(retries,[2,3]);
 calls=0;await assert.rejects(retryRead(async()=>{calls++;throw Error('RPC unavailable (HTTP 429).');},signal,()=>{},0),/HTTP 429/);assert.equal(calls,3);
 calls=0;await assert.rejects(retryRead(async()=>{calls++;throw Error('Invalid router address.');},signal,()=>{},0),/Invalid router/);assert.equal(calls,1);
});
test('pause cancels retry waits before another read is sent',async()=>{
 const abort=new AbortController();let calls=0;
 const promise=retryRead(async()=>{calls++;throw Error('RPC temporarily unavailable.');},abort.signal,()=>setTimeout(()=>abort.abort(),0),100);
 await assert.rejects(promise,e=>(e as Error).name==='AbortError');assert.equal(calls,1);
});
