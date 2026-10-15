import {getChatGPTUser} from '../../chatgpt-auth';
import {marketFeed,searchPairs,tokenPairs} from '../../../lib/market-feed';
import {withConfiguredFetch} from '../../../lib/server-fetch';
export async function POST(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to use market discovery.'},{status:401});
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid request origin.'},{status:403});
 if(!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'JSON required.'},{status:415});
 try{const text=await request.text();if(text.length>8000)throw Error('Request too large.');const b=JSON.parse(text);let result;
  result=await withConfiguredFetch(b.proxy,async()=>{if(b.action==='feed')return marketFeed(b.chain,b.watchlist);if(b.action==='search')return searchPairs(b.chain,b.query);if(b.action==='token')return tokenPairs(b.chain,b.mint);throw Error('Unknown market action.');});
  return Response.json({result},{headers:{'cache-control':'no-store'}});
 }catch(e){return Response.json({error:(e as Error).message.slice(0,250)},{status:400,headers:{'cache-control':'no-store'}});}
}
