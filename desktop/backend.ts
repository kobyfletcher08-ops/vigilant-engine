import {POST as arb} from '../app/api/arb/route.ts';
import {POST as markets} from '../app/api/markets/route.ts';
import {POST as solana} from '../app/api/solana/route.ts';
import {withDesktopIdentity} from './auth.ts';
import {installDesktopFetch} from '../lib/server-fetch.ts';
import {desktopFetch,transportStats,closeTransport} from './transport.ts';
export const APP_ORIGIN = 'https://vigilant.local';
installDesktopFetch(desktopFetch);
const routes: Record<string,(request:Request)=>Promise<Response>> = {'/api/arb':arb,'/api/markets':markets,'/api/solana':solana};
export async function dispatch(request:Request):Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== APP_ORIGIN || request.headers.get('origin') !== APP_ORIGIN) return Response.json({error:'Invalid desktop origin.'},{status:403});
  if (url.pathname === '/api/desktop/health' && request.method === 'GET') return Response.json({version:'0.2.0',runtime:'local-desktop',network:transportStats()});
  const route = routes[url.pathname];
  if (!route) return Response.json({error:'Unknown desktop endpoint.'},{status:404});
  if (request.method !== 'POST') return Response.json({error:'POST required.'},{status:405});
  const started = performance.now();
  const response = await withDesktopIdentity(()=>route(request));
  response.headers.set('x-vigilant-duration-ms',String(Math.round(performance.now()-started)));
  return response;
}
export {closeTransport};
