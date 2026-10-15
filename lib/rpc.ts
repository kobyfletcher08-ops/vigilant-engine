import {Interface,toQuantity} from 'ethers';
import {safeRpc,type Config} from './model.ts';
import {validateRpcSettings} from './rpc-settings.ts';
import {classifyRpcError,rpcFailure,type RpcReason} from './rpc-errors.ts';
export type RequestItem={method:string,params:unknown[]};
export type RpcResult={value?:any,error?:string,retryable?:boolean,reason?:RpcReason};
export function requireReliable(results:RpcResult[],label:string){if(results.some(r=>r.retryable))throw Error(rpcFailure(label,results));}
export type Call={to:string,fn:string,args?:unknown[],block?:number};
export class Rpc {
 url:string;request:typeof fetch;nextId=1;batchSize:number;delayMs:number;concurrency:number;nextStart=0;
 constructor(url:string,request:typeof fetch=fetch,options:{batchSize?:number,delayMs?:number,concurrency?:number}={}){this.url=safeRpc(url);this.request=request;this.batchSize=options.batchSize||16;this.delayMs=options.delayMs||0;this.concurrency=options.concurrency||1;}
 async batch(items:RequestItem[]):Promise<RpcResult[]>{
  const chunks:RequestItem[][]=[];for(let offset=0;offset<items.length;offset+=this.batchSize)chunks.push(items.slice(offset,offset+this.batchSize));
  const ordered:RpcResult[][]=[];let cursor=0;
  const workers=items.every(i=>/^eth_(?:get|call|estimate|chainId|blockNumber|gasPrice|feeHistory|maxPriorityFeePerGas)/.test(i.method))?this.concurrency:1;
  const read=async()=>{while(cursor<chunks.length){const index=cursor++,chunk=chunks[index],payload=chunk.map(x=>({...x,jsonrpc:'2.0',id:this.nextId++})),results:RpcResult[]=[];
   const start=Math.max(Date.now(),this.nextStart);this.nextStart=start+this.delayMs;const wait=start-Date.now();if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
   const response=await this.request(this.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000),redirect:'manual'});
   if(response.status>=300&&response.status<400)throw Error('RPC endpoint redirected (HTTP '+response.status+'). Configure its direct HTTPS URL.');
   if(!response.ok)throw Error('RPC unavailable (HTTP '+response.status+').');const text=await response.text();if(text.length>2000000)throw Error('RPC response exceeds limit.');const data=JSON.parse(text);if(!Array.isArray(data))throw Error('This RPC does not support JSON-RPC batches. Choose another endpoint.');
   for(const p of payload){const matches=data.filter(x=>x&&x.id===p.id);if(matches.length!==1){results.push({error:'Incomplete RPC response.',retryable:true,reason:'invalid-response'});continue;}const item=matches[0];results.push(item.error?classifyRpcError(item.error):Object.hasOwn(item,'result')?{value:item.result}:{error:'Missing RPC result.',retryable:true,reason:'invalid-response'});}
   ordered[index]=results;
  }};await Promise.all(Array.from({length:Math.min(workers,chunks.length)},read));return ordered.flat();
 }
 async send(method:string,params:unknown[]=[]){const [item]=await this.batch([{method,params}]);if(item.error)throw Error(item.error);return item.value;}
 async calls(calls:Call[]):Promise<RpcResult[]>{const prepared=calls.map(c=>{const iface=new Interface([c.fn]);return {c,iface,name:/^function\s+(\w+)/.exec(c.fn)![1]};});
  const results=await this.batch(prepared.map(({c,iface,name})=>({method:'eth_call',params:[{to:c.to,data:iface.encodeFunctionData(name,c.args||[])},c.block===undefined?'latest':toQuantity(c.block)]})));
  return results.map((r,i)=>{if(r.error)return r;try{return {value:Array.from(prepared[i].iface.decodeFunctionResult(prepared[i].name,r.value))};}catch{return {error:'Invalid contract response.'};}});
 }
 async call(to:string,fn:string,args:unknown[]=[],block?:number){const [r]=await this.calls([{to,fn,args,block}]);if(r.error)throw Error(r.error);return r.value!;}
}
export function configuredRpc(c:Config,request:typeof fetch=fetch){const settings=validateRpcSettings(c.rpcSettings);return new Rpc(c.rpc,request,{batchSize:settings.batchSize,delayMs:settings.delayMs,concurrency:settings.concurrency});}
export const FN={factory:'function factory() view returns(address)',wrapped:'function WETH() view returns(address)',pair:'function getPair(address,address) view returns(address)',allPairs:'function allPairs(uint256) view returns(address)',allPairsLength:'function allPairsLength() view returns(uint256)',symbol:'function symbol() view returns(string)',symbolBytes:'function symbol() view returns(bytes32)',t0:'function token0() view returns(address)',t1:'function token1() view returns(address)',reserves:'function getReserves() view returns(uint112,uint112,uint32)',out:'function getAmountsOut(uint256,address[]) view returns(uint256[])',decimals:'function decimals() view returns(uint8)',balance:'function balanceOf(address) view returns(uint256)'};
