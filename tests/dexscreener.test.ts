import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePair,dedupePairs,rankedPairs,opportunities,mintKey,intermediate,MARKET_CHAINS} from '../lib/dexscreener.ts';
import {dexFetch,tokenPairs,searchPairs,marketFeed} from '../lib/market-feed.ts';
const addr=(n:string)=>'0x'+n.repeat(40);
const raw=(extra:any={})=>({chainId:'bsc',pairAddress:addr('1'),dexId:'pancakeswap',baseToken:{address:addr('2'),symbol:'USD'},quoteToken:{address:MARKET_CHAINS.bsc.wrapped,symbol:'WBNB'},priceUsd:'2',priceNative:'0.01',liquidity:{usd:50000},volume:{h24:20000},priceChange:{h24:15,m5:-1},txns:{m5:{buys:3,sells:2}},...extra});
const pair=(extra:any={})=>parsePair(raw(extra),'bsc')!;
test('market data excludes malformed prices and preserves unknown changes',()=>{
 const p=pair({url:'javascript:alert(1)',priceChange:{h24:Infinity},liquidity:{usd:-5},volume:{h24:NaN}});assert.equal(p.url,'https://dexscreener.com/bsc/'+addr('1'));assert.equal(p.liquidity,0);assert.equal(p.volume,0);assert.equal(p.changes.h24,undefined);
 for(const priceUsd of ['0','NaN','Infinity',null])assert.equal(parsePair(raw({priceUsd}),'bsc'),null);assert.equal(parsePair(raw({chainId:'arbitrum'}),'bsc'),null);assert.equal(parsePair(raw({baseToken:{address:'fake'}}),'bsc'),null);
});
test('spreads match exact mint, quote asset and chain instead of symbols',()=>{
 assert.equal(mintKey('bsc',addr('a').toUpperCase()),addr('a'));assert.notEqual(mintKey('solana','A'.repeat(32)),mintKey('solana','a'.repeat(32)));
 assert.equal(dedupePairs([pair({pairAddress:addr('a')}),pair({pairAddress:addr('a').toUpperCase()})]).length,1);
 const buy=pair(),sell=pair({pairAddress:addr('3'),priceNative:'0.0103'});assert.ok(Math.abs(opportunities([buy,sell],1000,1000)[0].spread-3)<.00001);
 assert.equal(opportunities([buy,{...sell,base:{...sell.base,address:addr('4')}}],0,0).length,0);assert.equal(opportunities([buy,{...sell,quote:{...sell.quote,address:addr('5')}}],0,0).length,0);assert.equal(opportunities([buy,{...sell,chain:'arbitrum'}],0,0).length,0);assert.equal(opportunities([buy,{...sell,trades5m:0}],0,0).length,0);assert.equal(opportunities([buy,{...sell,trades5m:0}],0,0,false).length,1);
});
test('gainers rank selected timeframe and native intermediates use addresses',()=>{
 const rows=[pair({pairAddress:addr('1'),priceChange:{h24:100,m5:-4}}),pair({pairAddress:addr('2'),priceChange:{h24:2,m5:8}}),pair({pairAddress:addr('3'),priceChange:{}})];assert.equal(rankedPairs(rows,'m5','gainers',10000,10000)[0].id,addr('2'));assert.equal(rankedPairs(rows,'h24','gainers',10000,10000)[0].id,addr('1'));assert.equal(rankedPairs(rows,'m5','gainers',0,0).at(-1)!.id,addr('3'));assert.equal(intermediate(rows[0])!.address,addr('2'));assert.equal(intermediate({...rows[0],quote:{...rows[0].quote,address:addr('a')}}),null);
});
test('market API uses manual redirects, bounded output and sanitized rate limits',async()=>{
 for(const status of [301,302,303,307,308])await assert.rejects(dexFetch('/latest/dex/search?q=x',async(url,options)=>{assert.equal(new URL(String(url)).hostname,'api.dexscreener.com');assert.equal(options!.redirect,'manual');return new Response('',{status,headers:{location:'https://evil.test'}});}),/redirected/);
 await assert.rejects(dexFetch('//evil.test'),/Invalid/);await assert.rejects(dexFetch('/x',async()=>new Response('secret upstream message',{status:429,headers:{'retry-after':'30'}})),/Retry in 30/);await assert.rejects(dexFetch('/x',async()=>new Response('x'.repeat(4000001))),/size limits/);await assert.rejects(dexFetch('/x',async()=>new Response('not json')),/unreadable/);
});
test('feed batches thirty mints, keeps chain boundaries and bounds watchlists',async()=>{
 let calls=0;const fetcher:typeof fetch=async(url)=>{calls++;const path=new URL(String(url)).pathname;if(path.startsWith('/tokens/'))return Response.json([raw(),raw({chainId:'solana'})]);return Response.json([{chainId:'bsc',tokenAddress:addr('e')},{chainId:'solana',tokenAddress:'A'.repeat(32)}]);};
 const feed=await marketFeed('bsc',[addr('f')],fetcher);assert.equal(feed.pairs.length,1);assert.ok(feed.tokenCount<=30);assert.equal(calls,4);assert.equal(feed.failures,0);await assert.rejects(marketFeed('bsc',Array(13).fill(addr('a')),fetcher),/up to 12/);await assert.rejects(tokenPairs('solana',addr('a'),fetcher),/Invalid/);await assert.rejects(marketFeed('bsc',[],async()=>new Response('',{status:503})),/unavailable/);assert.equal((await searchPairs('bsc','USD',async()=>Response.json({pairs:[raw(),raw({chainId:'arbitrum'})]}))).length,1);
});
