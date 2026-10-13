import {AsyncLocalStorage} from 'node:async_hooks';
import {SOL_DEFAULTS,validateSolConfig,type SolConfig} from './solana-types.ts';

// Runtime credentials are supplied by the Worker, never by a browser bundle.
const hostedRpc=new AsyncLocalStorage<{url:string|undefined}>();
export function runWithSolanaRpc<T>(url:string|undefined,run:()=>T):T{return hostedRpc.run({url},run);}
export function resolveSolanaRpc(config:SolConfig,override=hostedRpc.getStore()?.url||process.env.SOLANA_RPC_URL):string{
 if(!override||new URL(config.rpc).toString()!==new URL(SOL_DEFAULTS.rpc).toString())return config.rpc;
 return validateSolConfig({...config,rpc:override}).rpc;
}
