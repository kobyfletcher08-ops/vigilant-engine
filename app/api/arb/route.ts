import {getChatGPTUser} from '../../chatgpt-auth';
import {scan,prepare,diagnostics,receipts,resolveIntent} from '../../../lib/engine';
import {walletRead,broadcastSigned} from '../../../lib/wallet-relay';
import {discoverFactories,discoverPage} from '../../../lib/pair-discovery';
import {validateConfig} from '../../../lib/model';
import {configuredRpc} from '../../../lib/rpc';
import {configuredFetch} from '../../../lib/server-fetch';

export const dynamic='force-dynamic';

export async function POST(request:Request){
 if(!await getChatGPTUser())return Response.json({error:'Sign in to use your private trading console.'},{status:401});
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return Response.json({error:'Cross-origin requests are not allowed.'},{status:403});
 if(request.headers.get('content-type')!=='application/json')return Response.json({error:'JSON required.'},{status:415});
 try{const text=await request.text();if(text.length>48000)throw Error('Request exceeds the size limit.');const body=JSON.parse(text),config=validateConfig(body.config);
  const requestFetch=configuredFetch(config.proxy);
  const rpc=configuredRpc(config, requestFetch);
  let result;
  if(body.action==='scan')result=await scan(config,rpc,body.assets);
  else if(body.action==='discover')result=await discoverFactories(config,rpc);
  else if(body.action==='pairs')result=await discoverPage(config,body.page,rpc);
  else if(body.action==='check')result=await diagnostics(config,body.owner,rpc);
  else if(body.action==='prepare')result=await prepare(config,body.kind,body.input,rpc);
  else if(body.action==='resolve')result=await resolveIntent(config,body.hash,body.transaction,rpc);
  else if(body.action==='rpc')result=await walletRead(config,body.method,body.params,rpc);
  else if(body.action==='broadcast')result=await broadcastSigned(config,body.raw,body.owner,rpc);
  else if(body.action==='receipts')result=await receipts(config,body.items,rpc);
  else throw Error('Unknown action.');
  return Response.json({result},{headers:{'Cache-Control':'no-store'}});
 }catch(e){const error=e as any;const safe=error.code?'Blockchain call failed ('+String(error.code).replace(/[^A-Z0-9_]/g,'').slice(0,40)+').':String(error.message||'Request failed.').replace(/https?:\/\/\S+/g,'[RPC endpoint]').slice(0,280);return Response.json({error:safe},{status:400,headers:{'Cache-Control':'no-store'}});}
}
