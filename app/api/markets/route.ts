import {getChatGPTUser} from '../../chatgpt-auth';
import {marketFeed,searchPairs,tokenPairs} from '../../../lib/market-feed';
export async function POST(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to use market discovery.'},{status:401});
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid request origin.'},{status:403});
 if(!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'JSON required.'},{status:415});
 try{const text=await request.text();if(text.length>8000)throw Error('Request too large.');const b=JSON.parse(text);let result;
  if(b.action==='feed')result=await marketFeed(b.chain,b.watchlist);else if(b.action==='search')result=await searchPairs(b.chain,b.query);else if(b.action==='token')result=await tokenPairs(b.chain,b.mint);else throw Error('Unknown market action.');
  return Response.json({result},{headers:{'cache-control':'no-store'}});
 }catch(e){return Response.json({error:(e as Error).message.slice(0,250)},{status:400,headers:{'cache-control':'no-store'}});}
}
