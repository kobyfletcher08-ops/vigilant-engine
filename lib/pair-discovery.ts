import {decodeBytes32String} from 'ethers';
import {connection} from './engine.ts';
import {Rpc,FN,requireReliable} from './rpc.ts';
import {validateConfig,address,same,amount,bnb,type Asset,type Config} from './model.ts';
import {validateRpcSettings} from './rpc-settings.ts';
import {rpcFailure} from './rpc-errors.ts';

export const PAIR_PAGE_SIZE=32;
export type FactoryTarget={router:string,name:string,factory:string,total:number,cursor:number};
export type DiscoveryInfo={chainId:number,block:number,wbnb:string,targets:FactoryTarget[],errors:{name:string,message:string}[]};
export type PairRecord={index:number,router:string,dex:string,factory:string,address?:string,token0?:string,token1?:string,reserve0?:string,reserve1?:string,wbnbReserve?:string,asset?:Asset,decimals?:number,metadataError?:string,status:'ready'|'low-liquidity'|'catalog-only'|'unreadable',error?:string,block:number};
export type PairPage={router:string,factory:string,cursor:number,nextCursor:number,total:number,block:number,pairs:PairRecord[]};
const count=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw Error('Factory returned an invalid pair count.');return n;};
function label(value:unknown,fallback:string){return String(value??'').replace(/[^a-z0-9_.-]/gi,'').slice(0,12)||fallback;}
// Each request is bounded; the client advances through every factory index.
export async function discoverFactories(value:unknown,injected?:Rpc):Promise<DiscoveryInfo>{
 const c=validateConfig(value),net=await connection(c,injected),defs=c.dexes.filter(d=>d.enabled);
 if(defs.length<2)throw Error('Enable at least two V2 routers before scanning all pairs.');
 const results=await net.rpc.calls(defs.flatMap(d=>[{to:d.address,fn:FN.factory,block:net.block},{to:d.address,fn:FN.wrapped,block:net.block}]));
 requireReliable(results,'router discovery');
 const errors:DiscoveryInfo['errors']=[],checked:{router:string,name:string,factory:string}[]=[];
 defs.forEach((d,i)=>{const [factory,wrapped]=results.slice(i*2,i*2+2);try{
  if(factory.error||wrapped.error||!same(wrapped.value![0],net.wbnb))throw Error(`Router/factory or ${net.n.wrappedSymbol} verification failed.`);
  checked.push({router:d.address,name:d.name,factory:address(factory.value![0],'Factory')});
 }catch(e){errors.push({name:d.name,message:(e as Error).message});}});
 const lengths=await net.rpc.calls(checked.map(d=>({to:d.factory,fn:FN.allPairsLength,block:net.block}))),targets:FactoryTarget[]=[];
 requireReliable(lengths,'factory counts');
 checked.forEach((d,i)=>{try{if(lengths[i].error)throw Error('Factory does not expose a readable V2 pair list.');targets.push({...d,total:count(lengths[i].value![0]),cursor:0});}catch(e){errors.push({name:d.name,message:(e as Error).message});}});
 if(!targets.length)throw Error('No enabled router exposes a verified V2 pair list.');
 return {chainId:c.network,block:net.block,wbnb:net.wbnb,targets,errors};
}
export async function discoverPage(value:unknown,input:unknown,injected?:Rpc):Promise<PairPage>{
 const c=validateConfig(value),p=input as {router:string,cursor:number},router=address(p?.router,'Router'),dex=c.dexes.find(d=>d.enabled&&same(d.address,router));
 if(!dex)throw Error('Pair discovery requires an enabled router.');
 if(!Number.isSafeInteger(p.cursor)||p.cursor<0)throw Error('Pair cursor must be a non-negative safe integer.');
 const {rpc,wbnb,block}=await connection(c,injected);
 const [f,w]=await rpc.calls([{to:router,fn:FN.factory,block},{to:router,fn:FN.wrapped,block}]);
 if(f.error||w.error||!same(w.value![0],wbnb))throw Error('Router/factory verification failed.');
 const factory=address(f.value![0],'Factory'),total=count((await rpc.call(factory,FN.allPairsLength,[],block))[0]);
 if(p.cursor>total)throw Error('Pair cursor exceeds this factory. Restart discovery.');
 const settings=validateRpcSettings(c.rpcSettings),nextCursor=Math.min(p.cursor+settings.pageSize,total),indices=Array.from({length:nextCursor-p.cursor},(_,i)=>p.cursor+i);
 const lookups=await rpc.calls(indices.map(i=>({to:factory,fn:FN.allPairs,args:[i],block})));
 // Do not silently advance past an RPC failure during index enumeration.
 if(!settings.skipFailedPools&&lookups.some(r=>r.error))throw Error('Factory page could not be read completely. Retry resumes at the same pair index.');
 const pairs:PairRecord[]=lookups.map((r,i)=>{const pair:PairRecord={index:indices[i],router,dex:dex.name,factory,status:'unreadable',block};try{if(r.error)throw Error('Factory index lookup: '+r.error);pair.address=address(r.value![0],'Pair');}catch(e){pair.error=(e as Error).message;}return pair;});
 const resolved=pairs.filter(pair=>pair.address);
 const details=await rpc.calls(resolved.flatMap(pair=>[{to:pair.address!,fn:FN.factory,block},{to:pair.address!,fn:FN.t0,block},{to:pair.address!,fn:FN.t1,block},{to:pair.address!,fn:FN.reserves,block}]));
 if(!settings.skipFailedPools&&details.some(r=>r.retryable))throw Error(rpcFailure('pool data',details)+' Cursor unchanged.');
 resolved.forEach((pair,i)=>{const [pf,t0,t1,res]=details.slice(i*4,i*4+4);try{
  const failed=[pf,t0,t1,res].find(r=>r.error);if(failed)throw Error('Pool read failed: '+failed.error);
  if(!same(pf.value![0],factory))throw Error('Pair factory mismatch.');
  pair.token0=address(t0.value![0],'Token 0');pair.token1=address(t1.value![0],'Token 1');
  if(same(pair.token0,pair.token1))throw Error('Pair contains duplicate tokens.');
  pair.reserve0=BigInt(res.value![0]).toString();pair.reserve1=BigInt(res.value![1]).toString();
  if(BigInt(pair.reserve0)<0n||BigInt(pair.reserve1)<0n)throw Error('Invalid pair reserves.');
  if(!same(pair.token0,wbnb)&&!same(pair.token1,wbnb)){pair.status='catalog-only';return;}
  const token=same(pair.token0,wbnb)?pair.token1:pair.token0,reserve=BigInt(same(pair.token0,wbnb)?pair.reserve0:pair.reserve1);
  pair.asset={address:token,symbol:c.tokens.find(t=>same(t.address,token))?.symbol||token.slice(2,10),enabled:true};
  pair.wbnbReserve=bnb(reserve);pair.status=reserve>=amount(c.minReserve)&&BigInt(pair.reserve0)>0n&&BigInt(pair.reserve1)>0n?'ready':'low-liquidity';
 }catch(e){pair.status='unreadable';pair.error=(e as Error).message;}});
 const assets=Array.from(new Map(pairs.filter(p=>p.asset).map(p=>[p.asset!.address.toLowerCase(),p.asset!])).values());
 const metadata=await rpc.calls(assets.flatMap(a=>[{to:a.address,fn:FN.symbol,block},{to:a.address,fn:FN.decimals,block}]));
 if(!settings.skipFailedPools&&metadata.some(r=>r.retryable))throw Error(rpcFailure('token metadata',metadata)+' Cursor unchanged.');
 const missing=assets.flatMap((a,i)=>metadata[i*2].error?[{a,i}]:[]);
 const fallback=await rpc.calls(missing.map(x=>({to:x.a.address,fn:FN.symbolBytes,block})));
 const names=new Map<string,string>();assets.forEach((a,i)=>{if(!metadata[i*2].error)names.set(a.address.toLowerCase(),label(metadata[i*2].value![0],a.symbol));});
 missing.forEach((x,i)=>{if(!fallback[i].error)try{names.set(x.a.address.toLowerCase(),label(decodeBytes32String(fallback[i].value![0]),x.a.symbol));}catch{}});
 pairs.forEach(pair=>{if(!pair.asset)return;const i=assets.findIndex(a=>same(a.address,pair.asset!.address)),d=metadata[i*2+1];
  pair.asset.symbol=names.get(pair.asset.address.toLowerCase())||pair.asset.symbol;
  const decimals=d.error?NaN:Number(d.value![0]);
  // ERC-20 metadata is optional. Router quotes and reserve checks use raw units.
  if(!Number.isInteger(decimals)||decimals<0||decimals>36){pair.metadataError='Token decimals unavailable; quotes use raw token units.';return;}
  pair.decimals=decimals;
 });
 return {router,factory,cursor:p.cursor,nextCursor,total,block,pairs};
}
