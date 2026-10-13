import {getChatGPTUser} from '../../chatgpt-auth';
import {solQuote,solPrepare,solSimulate,solBroadcast,solCheck,solStatuses} from '../../../lib/solana-engine';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 if(!await getChatGPTUser())return Response.json({error:'Sign in to use Solana execution.'},{status:401});
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid request origin.'},{status:403});
 if(request.headers.get('content-type')!=='application/json')return Response.json({error:'JSON required.'},{status:415});
 try{const text=await request.text();if(text.length>10000)throw Error('Request too large.');const b=JSON.parse(text);if(['seed','phrase','mnemonic','privateKey','secretKey'].some(k=>k in b))throw Error('Only public addresses and signed transactions are accepted.');let result;
  if(b.action==='quote')result=await solQuote(b.config,b.token,b.symbol);else if(b.action==='prepare')result=await solPrepare(b.config,b.token,b.symbol,b.routeId,b.owner);else if(b.action==='simulate')result=await solSimulate(b.config,b.unsigned,b.owner,b.lastValidBlockHeight);else if(b.action==='broadcast')result=await solBroadcast(b.config,b.raw,b.owner,b.lastValidBlockHeight);else if(b.action==='check')result=await solCheck(b.config,b.owner);else if(b.action==='statuses')result=await solStatuses(b.config,b.items);else throw Error('Unknown Solana action.');return Response.json({result},{headers:{'cache-control':'no-store'}});
 }catch(e){return Response.json({error:String((e as Error).message||'Solana request failed.').replace(/https?:\/\/\S+/g,'[RPC endpoint]').slice(0,280)},{status:400,headers:{'cache-control':'no-store'}});}
}
