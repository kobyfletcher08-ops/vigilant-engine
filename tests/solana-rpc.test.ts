import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSolanaRpc,runWithSolanaRpc} from '../lib/solana-rpc.ts';
import {SOL_DEFAULTS,validateSolConfig} from '../lib/solana-types.ts';

test('private hosted RPC replaces only the canonical public default and stays out of config',()=>{
 const config=validateSolConfig(SOL_DEFAULTS),privateRpc='https://rpc.example.com/private-test-token';
 assert.equal(resolveSolanaRpc(config,privateRpc),privateRpc);
 assert.equal(resolveSolanaRpc(SOL_DEFAULTS,privateRpc),privateRpc);
 assert.equal(resolveSolanaRpc(config,''),config.rpc);
 const custom=validateSolConfig({...config,rpc:'https://custom.example.com/rpc'});
 assert.equal(resolveSolanaRpc(custom,privateRpc),custom.rpc);
 assert.ok(!JSON.stringify(config).includes('private-test-token'));
 assert.throws(()=>resolveSolanaRpc(config,'https://127.0.0.1/private-test-token'),/public HTTPS/);
});
test('hosted RPC bindings stay isolated across concurrent asynchronous requests',async()=>{
 const a='https://a.example.com/rpc',b='https://b.example.com/rpc';
 const result=await Promise.all([a,b].map(url=>runWithSolanaRpc(url,async()=>{await Promise.resolve();return resolveSolanaRpc(SOL_DEFAULTS);})));assert.deepEqual(result,[a,b]);
 assert.equal(runWithSolanaRpc(undefined,()=>resolveSolanaRpc(SOL_DEFAULTS,'')),SOL_DEFAULTS.rpc);
});
