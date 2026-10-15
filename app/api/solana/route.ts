import {getChatGPTUser} from '../../chatgpt-auth';
import {solQuote,solPrepare,solSimulate,solBroadcast,solCheck,solStatuses} from '../../../lib/solana-engine';
import {withConfiguredFetch} from '../../../lib/server-fetch';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 if(!await getChatGPTUser())return Response.json({error:'Sign in to use Solana execution.'},{status:401});
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid request origin.'},{status:403});
 if(request.headers.get('content-type')!=='application/json')return Response.json({error:'JSON required.'},{status:415});
 try{const text=await request.text();if(text.length>10000)throw Error('Request too large.');const b=JSON.parse(text);if(['seed','phrase','mnemonic','privateKey','secretKey'].some(k=>k in b))throw Error('Only public addresses and signed transactions are accepted.');let result;
  result=await withConfiguredFetch(b.config?.proxy,async()=>{if(b.action==='quote')return solQuote(b.config,b.token,b.symbol);if(b.action==='prepare')return solPrepare(b.config,b.token,b.symbol,b.routeId,b.owner);if(b.action==='simulate')return solSimulate(b.config,b.unsigned,b.owner,b.lastValidBlockHeight);if(b.action==='broadcast')return solBroadcast(b.config,b.raw,b.owner,b.lastValidBlockHeight);if(b.action==='check')return solCheck(b.config,b.owner);if(b.action==='statuses')return solStatuses(b.config,b.items);throw Error('Unknown Solana action.');});return Response.json({result},{headers:{'cache-control':'no-store'}});
 }catch(e){return Response.json({error:String((e as Error).message||'Solana request failed.').replace(/https?:\/\/\S+/g,'[RPC endpoint]').slice(0,280)},{status:400,headers:{'cache-control':'no-store'}});}
}
