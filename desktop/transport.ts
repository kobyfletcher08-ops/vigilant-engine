import {Agent,ProxyAgent,fetch as nodeFetch,type Dispatcher} from 'undici';
import {proxyUrl} from '../lib/proxy-config.ts';
type Entry = {dispatcher: Dispatcher,request: typeof fetch};
const agents = new Map<string,Entry>();
let count = 0,failed = 0,totalMs = 0,active = 0;
export function desktopFetch(proxy = ''): typeof fetch {
  const key = proxyUrl(proxy),cached = agents.get(key);
  if (cached) { agents.delete(key); agents.set(key,cached); return cached.request; }
  let dispatcher: Dispatcher;
  if (key) {
    const url = new URL(key),credentials = url.username || url.password ? Buffer.from(decodeURIComponent(url.username)+':'+decodeURIComponent(url.password)).toString('base64') : '';
    url.username = ''; url.password = '';
    dispatcher = new ProxyAgent({uri:url.toString(),...(credentials?{token:'Basic '+credentials}:{}),connections:16,pipelining:1,keepAliveTimeout:30000,connect:{timeout:10000}});
  } else dispatcher = new Agent({connections:16,pipelining:1,keepAliveTimeout:30000,connect:{timeout:10000}});
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now(); active++;
    try {
      const signal = init?.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const response = await nodeFetch(input as Parameters<typeof nodeFetch>[0],{...init,signal,redirect:'manual',dispatcher} as Parameters<typeof nodeFetch>[1]);
      count++; totalMs += performance.now()-started;
      return response as unknown as Response;
    } catch { failed++; throw Error(key?'Proxy request failed. Check proxy credentials and connectivity.':'Network request failed. Check the endpoint and connectivity.'); }
    finally { active--; }
  }) as typeof fetch;
  agents.set(key,{dispatcher,request});
  if (agents.size > 16) { const oldest = agents.keys().next().value!; const entry = agents.get(oldest)!; agents.delete(oldest); void entry.dispatcher.close().catch(()=>{}); }
  return request;
}
export function transportStats() { return {requests:count,failed,active,averageMs:count?Math.round(totalMs/count):0,pools:agents.size}; }
export async function closeTransport() { await Promise.allSettled([...agents.values()].map(e=>e.dispatcher.close())); agents.clear(); }
