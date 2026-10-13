export const MARKET_CHAINS={
 bsc:{name:'BNB Chain',short:'BSC',network:56,native:'BNB',wrapped:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'},
 arbitrum:{name:'Arbitrum One',short:'Arbitrum',network:42161,native:'ETH',wrapped:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'},
 solana:{name:'Solana',short:'Solana',network:0,native:'SOL',wrapped:'So11111111111111111111111111111111111111112'},
} as const;
export type MarketChain=keyof typeof MARKET_CHAINS;
export type Timeframe='m5'|'h1'|'h6'|'h24';
export type Pair={chain:MarketChain,id:string,dex:string,labels:string[],base:{address:string,symbol:string,name:string},quote:{address:string,symbol:string,name:string},price:number,priceNative:number,liquidity:number,volume:number,changes:Partial<Record<Timeframe,number>>,trades5m:number,url:string};
export type MarketFeed={chain:MarketChain,pairs:Pair[],fetchedAt:number,tokenCount:number,failures:number};
export const PRESET_MINTS:Record<MarketChain,string[]>={
 bsc:[MARKET_CHAINS.bsc.wrapped,'0x55d398326f99059fF775485246999027B3197955','0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d','0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82','0x2170Ed0880ac9A755fd29B2688956BD959F933F8','0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c'],
 arbitrum:[MARKET_CHAINS.arbitrum.wrapped,'0xaf88d065e77c8cC2239327C5EDb3A432268e5831','0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9','0x912CE59144191C1204E64559FE8253a0e49E6548','0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f','0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a'],
 solana:[MARKET_CHAINS.solana.wrapped,'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN','DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R','orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'],
};
export function marketChain(v:unknown):MarketChain{if(v!=='bsc'&&v!=='arbitrum'&&v!=='solana')throw Error('Choose Solana, BSC or Arbitrum One.');return v;}
export const mintKey=(chain:MarketChain,address:string)=>chain==='solana'?address:address.toLowerCase();
export function validMint(chain:MarketChain,v:unknown):v is string{return typeof v==='string'&&(chain==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v):/^0x[0-9a-f]{40}$/i.test(v));}
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:0;
export function parsePair(raw:any,chain:MarketChain):Pair|null{
 if(raw?.chainId!==chain||!validMint(chain,raw.pairAddress)||!validMint(chain,raw.baseToken?.address)||!validMint(chain,raw.quoteToken?.address))return null;
 const price=Number(raw.priceUsd),priceNative=Number(raw.priceNative);if(!Number.isFinite(price)||price<=0||!Number.isFinite(priceNative)||priceNative<=0)return null;
 const token=(v:any)=>({address:v.address,symbol:typeof v.symbol==='string'?v.symbol.slice(0,16):'TOKEN',name:typeof v.name==='string'?v.name.slice(0,64):''});
 const changes:Pair['changes']={};for(const frame of ['m5','h1','h6','h24'] as const)if(typeof raw.priceChange?.[frame]==='number'&&Number.isFinite(raw.priceChange[frame]))changes[frame]=raw.priceChange[frame];
 return {chain,id:raw.pairAddress,dex:String(raw.dexId||'').slice(0,28),labels:Array.isArray(raw.labels)?raw.labels.filter((v:unknown)=>typeof v==='string').slice(0,4):[],base:token(raw.baseToken),quote:token(raw.quoteToken),price,priceNative,liquidity:Math.max(0,finite(raw.liquidity?.usd)),volume:Math.max(0,finite(raw.volume?.h24)),changes,trades5m:Math.max(0,finite(raw.txns?.m5?.buys)+finite(raw.txns?.m5?.sells)),url:`https://dexscreener.com/${chain}/${raw.pairAddress}`};
}
export function dedupePairs(rows:Pair[]){return [...new Map(rows.map(p=>[p.chain+':'+mintKey(p.chain,p.id),p])).values()];}
export function rankedPairs(rows:Pair[],frame:Timeframe,mode:'gainers'|'volume'|'liquidity',minLiquidity:number,minVolume:number){return rows.filter(p=>p.liquidity>=minLiquidity&&p.volume>=minVolume).sort((a,b)=>mode==='gainers'?(b.changes[frame]??-Infinity)-(a.changes[frame]??-Infinity)||b.volume-a.volume:mode==='volume'?b.volume-a.volume:b.liquidity-a.liquidity);}
export function opportunities(rows:Pair[],minLiquidity:number,minVolume:number,activeOnly=true){
 const groups=new Map<string,Pair[]>();for(const p of dedupePairs(rows)){if(p.liquidity<minLiquidity||p.volume<minVolume||activeOnly&&!p.trades5m)continue;const k=p.chain+':'+mintKey(p.chain,p.base.address)+':'+mintKey(p.chain,p.quote.address);groups.set(k,[...(groups.get(k)||[]),p]);}
 return [...groups].flatMap(([id,pools])=>{if(pools.length<2)return [];const sorted=[...pools].sort((a,b)=>a.priceNative-b.priceNative),buy=sorted[0],sell=sorted.at(-1)!,spread=(sell.priceNative/buy.priceNative-1)*100;return spread>0&&Number.isFinite(spread)?[{id,buy,sell,spread,count:pools.length}]:[];}).sort((a,b)=>b.spread-a.spread);
}
export function intermediate(pair:Pair){const native=mintKey(pair.chain,MARKET_CHAINS[pair.chain].wrapped);if(mintKey(pair.chain,pair.quote.address)===native)return pair.base;if(mintKey(pair.chain,pair.base.address)===native)return pair.quote;return null;}
