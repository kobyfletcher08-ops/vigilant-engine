import {marketChain,validMint,mintKey,parsePair,dedupePairs,PRESET_MINTS,type Pair,type MarketChain,type MarketFeed} from './dexscreener.ts';
const cache=new Map<string,{expires:number,promise:Promise<any>}>();
export async function dexFetch(path:string,fetcher:typeof fetch=fetch){
 if(!path.startsWith('/')||path.startsWith('//'))throw Error('Invalid market request.');
 const r=await fetcher('https://api.dexscreener.com'+path,{redirect:'manual',signal:AbortSignal.timeout(12000),headers:{accept:'application/json'}});
 if(r.status===429)throw Error('DEX Screener rate limit. Retry in '+Math.min(300,Math.max(1,Number(r.headers.get('retry-after'))||60))+' seconds.');
 if(r.status>=300&&r.status<400)throw Error('DEX Screener redirected. Retry later.');if(!r.ok)throw Error('DEX Screener unavailable (HTTP '+r.status+').');
 const body=await r.text();if(body.length>4000000)throw Error('Market response exceeds size limits.');try{return JSON.parse(body);}catch{throw Error('Market API returned unreadable data.');}
}
async function cached(path:string,ttl:number,fetcher:typeof fetch){if(fetcher!==fetch)return dexFetch(path,fetcher);const found=cache.get(path);if(found&&found.expires>Date.now())return found.promise;if(cache.size>120)cache.clear();const promise=dexFetch(path).catch(e=>{cache.delete(path);throw e;});cache.set(path,{expires:Date.now()+ttl,promise});return promise;}
const parsed=(data:any,chain:MarketChain)=>dedupePairs((Array.isArray(data)?data:[]).map(p=>parsePair(p,chain)).filter((p):p is Pair=>p!==null));
export async function tokenPairs(chainValue:unknown,mint:unknown,fetcher:typeof fetch=fetch){const chain=marketChain(chainValue);if(!validMint(chain,mint))throw Error('Invalid token address.');const data=await cached(`/token-pairs/v1/${chain}/${mint}`,15000,fetcher);if(!Array.isArray(data))throw Error('Invalid pool response.');return parsed(data,chain);}
export async function searchPairs(chainValue:unknown,query:unknown,fetcher:typeof fetch=fetch){const chain=marketChain(chainValue);if(typeof query!=='string'||!query.trim()||query.length>100)throw Error('Search a token name, mint or pair address.');return parsed((await cached('/latest/dex/search?q='+encodeURIComponent(query.trim()),15000,fetcher)).pairs,chain);}
export async function marketFeed(chainValue:unknown,watchlist:unknown=[],fetcher:typeof fetch=fetch):Promise<MarketFeed>{
 const chain=marketChain(chainValue);if(!Array.isArray(watchlist)||watchlist.length>12||watchlist.some(m=>!validMint(chain,m)))throw Error('Watch up to 12 valid mints per chain.');
 const snapshots=await Promise.allSettled(['/token-boosts/top/v1','/token-boosts/latest/v1','/token-profiles/latest/v1'].map(p=>cached(p,60000,fetcher)));
 const discovered=snapshots.flatMap(r=>r.status==='fulfilled'&&Array.isArray(r.value)?r.value.filter((v:any)=>v.chainId===chain&&validMint(chain,v.tokenAddress)).map((v:any)=>v.tokenAddress):[]);
 const mints=[...new Map([...watchlist,...PRESET_MINTS[chain],...discovered].map(m=>[mintKey(chain,m),m])).values()].slice(0,30);
 const rows=await cached(`/tokens/v1/${chain}/${mints.join(',')}`,15000,fetcher);if(!Array.isArray(rows))throw Error('Invalid market response.');
 return {chain,pairs:parsed(rows,chain),fetchedAt:Date.now(),tokenCount:mints.length,failures:snapshots.filter(r=>r.status==='rejected').length};
}
