'use client';
import {useEffect,useRef,useState} from 'react';
import {Layers,Pause,Play,RefreshCw,Loader2,ExternalLink,TriangleAlert,Download} from 'lucide-react';
import {NETWORKS,type Config} from '../lib/model';
import type {Scan} from '../lib/engine';
import type {DiscoveryInfo,PairPage,PairRecord} from '../lib/pair-discovery';
import {catalogScope,readCatalog,saveCatalog,reconcileCatalog,refreshCatalog,savePairPage,nextQuoteBatch,saveQuotes,skipQuotes,readQuoteFailures,retryQuoteFailures,readPairPage,clearCatalog,type CatalogState,type QuoteFailure} from '../lib/pair-cache';
import {retryRead} from '../lib/read-retry';
import {validateRpcSettings} from '../lib/rpc-settings';
import {quoteBatch} from '../lib/quote-batches';
type Props={config:Config,startNonce:number,stopNonce:number,blocked:boolean,onPause:()=>void,onSettings:()=>void,onRunning:(running:boolean)=>void,onReport:(report:Scan|null)=>void,onNotice:(text:string,error?:boolean)=>void,request:(action:string,config:Config,other?:any,signal?:AbortSignal)=>Promise<any>};
const short=(s?:string)=>s?s.slice(0,6)+'…'+s.slice(-4):'—';
const format=(n:number)=>n.toLocaleString('en-GB');
export default function AllPairs(props:Props){
 const wrapped=NETWORKS[props.config.network].wrappedSymbol,scope=catalogScope(props.config),callbacks=useRef(props);callbacks.current=props;
 const settings=validateRpcSettings(props.config.rpcSettings),pageSize=settings.pageSize;
 const scopeRef=useRef(scope);scopeRef.current=scope;
 const [state,setState]=useState<CatalogState|null>(null),[running,setRunning]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[activity,setActivity]=useState(''),[router,setRouter]=useState(''),[offset,setOffset]=useState(0),[pairs,setPairs]=useState<PairRecord[]>([]);
 const [failures,setFailures]=useState<QuoteFailure[]>([]);
 const controller=useRef<AbortController|null>(null),runningRef=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 useEffect(()=>{controller.current?.abort();let cancelled=false;setState(null);setPairs([]);setOffset(0);setRouter('');setLoading(true);setError('');
  readCatalog(scope).then(saved=>{if(cancelled)return;setState(saved);if(saved?.targets[0])setRouter(saved.targets[0].router);if(saved?.report)callbacks.current.onReport(saved.report);}).catch(e=>{if(!cancelled)setError(e.message);}).finally(()=>{if(!cancelled)setLoading(false);});
  return()=>{cancelled=true;};
 },[scope]);
 useEffect(()=>{let cancelled=false;if(!router){setPairs([]);return;}
  readPairPage(scope,router,offset,pageSize).then(rows=>{if(!cancelled)setPairs(rows);}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};
 },[scope,router,offset,pageSize,state?.updatedAt]);
 useEffect(()=>{let cancelled=false;readQuoteFailures(scope).then(rows=>{if(!cancelled)setFailures(rows);}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[scope,state?.updatedAt]);
 useEffect(()=>{if(props.startNonce)void run();},[props.startNonce]);
 useEffect(()=>{if(props.stopNonce)controller.current?.abort();},[props.stopNonce]);
 const publish=(next:CatalogState)=>{if(alive.current&&scopeRef.current===next.scope){setState(next);setRouter(old=>old||next.targets[0]?.router||'');}};
 async function run(rebuild=false,retryFailed=false){
  if(runningRef.current||callbacks.current.blocked)return;
  const config=callbacks.current.config,runScope=catalogScope(config),abort=new AbortController();controller.current=abort;runningRef.current=true;setRunning(true);setError('');callbacks.current.onRunning(true);
  let current:CatalogState|null=null;
  const check=()=>{if(abort.signal.aborted||!alive.current||scopeRef.current!==runScope)throw new DOMException('Scan paused.','AbortError');};
  const read=(action:string,other:any={})=>action==='scan'&&settings.skipFailedPools?callbacks.current.request(action,config,other,abort.signal):retryRead(()=>callbacks.current.request(action,config,other,abort.signal),abort.signal,attempt=>setActivity('RPC busy · retry '+attempt+' of 3 · saved cursor retained'));
  try{
   if(rebuild){await clearCatalog(runScope);check();setState(null);setPairs([]);setOffset(0);callbacks.current.onReport(null);}
   current=await readCatalog(runScope);check();if(current&&retryFailed)current=await retryQuoteFailures(current);setActivity('Checking enabled V2 factories');
   const info=await read('discover') as DiscoveryInfo;check();
   const completed=current?.phase==='complete',fresh=!current;current=reconcileCatalog(runScope,info,current);
   current=completed?await refreshCatalog(current):await saveCatalog(current);check();publish(current);
   if(completed||rebuild||fresh)callbacks.current.onReport(null);
   while(true){
    check();const limit=settings.batchSize===4||config.dexes.filter(d=>d.enabled).length>4?1:4,assets=await nextQuoteBatch(runScope,limit);check();
    if(assets.length){setActivity('Quoting '+assets.map(a=>a.symbol).join(', ')+' across enabled DEXs');
     await quoteBatch(assets,tokens=>read('scan',{assets:tokens}),settings.skipFailedPools,async(tokens,report)=>{check();current=await saveQuotes(current!,tokens,report);},async(asset,message)=>{check();current=await skipQuotes(current!,[asset],message);},abort.signal);
     check();publish(current);callbacks.current.onReport(current.report);continue;
    }
    const target=current.targets.filter(t=>t.cursor<t.total).sort((a,b)=>a.cursor-b.cursor)[0];
    if(!target)break;
    setActivity(target.name+': reading pair indices '+format(target.cursor)+'–'+format(Math.min(target.cursor+pageSize-1,target.total-1)));
    const page=await read('pairs',{page:{router:target.router,cursor:target.cursor}}) as PairPage;check();
    current=await savePairPage(current,page);check();publish(current);
   }
   current=await saveCatalog({...current,phase:'complete',updatedAt:new Date().toISOString()});check();publish(current);setActivity('Scan complete');
   callbacks.current.onNotice(`All-pairs pass completed: ${format(current.discovered)} indexed pools, ${format(current.quoted)} ${NETWORKS[config.network].wrappedSymbol} tokens quoted, ${format(current.qualifying)} qualifying routes.${current.errors.length||current.unreadable||current.quoteFailures?' Skipped/failed entries remain available for retry.':''}`);
  }catch(e){const cancelled=abort.signal.aborted||(e as Error).name==='AbortError';
   if(current){try{current=await saveCatalog({...current,phase:'paused',updatedAt:new Date().toISOString()});publish(current);}catch{if(alive.current)setError('Pair cache could not be saved. Free browser storage and retry.');}}
   if(alive.current&&scopeRef.current===runScope){setActivity(cancelled?'Paused · saved cursor retained':'Stopped · retry continues from the saved cursor');if(!cancelled){setError((e as Error).message);callbacks.current.onNotice((e as Error).message,true);}}
  }finally{runningRef.current=false;controller.current=null;if(alive.current)setRunning(false);callbacks.current.onRunning(false);}
 }
 const total=state?.targets.reduce((n,t)=>n+t.total,0)||0,done=state?.targets.reduce((n,t)=>n+t.cursor,0)||0,percent=total?Math.min(100,done/total*100):0,target=state?.targets.find(t=>t.router===router);
 async function repairPage(){
  if(!state||!target||runningRef.current||props.blocked||offset>=target.cursor)return;
  const current=state,config=props.config,abort=new AbortController();controller.current=abort;runningRef.current=true;setRunning(true);callbacks.current.onRunning(true);setError('');setActivity('Rechecking the displayed factory page');
  try{const page=await callbacks.current.request('pairs',config,{page:{router,cursor:offset}},abort.signal) as PairPage;
   if(abort.signal.aborted||scopeRef.current!==current.scope)return;
   const end=Math.min(page.nextCursor,target.cursor),next=await savePairPage({...current,phase:'paused'},{...page,nextCursor:end,pairs:page.pairs.filter(p=>p.index<end)},true);
   publish(next);setActivity('Page refreshed · resume to quote newly recovered tokens');
  }catch(e){if(!abort.signal.aborted&&scopeRef.current===current.scope)setError((e as Error).message);}finally{runningRef.current=false;controller.current=null;if(alive.current)setRunning(false);callbacks.current.onRunning(false);}
 }
 const status=(p:PairRecord)=>p.status==='ready'?`${wrapped} pair`:p.status==='low-liquidity'?'Below reserve limit':p.status==='catalog-only'?'Token / token':'Unreadable';
 function exportReport(){if(!state?.report)return;const url=URL.createObjectURL(new Blob([JSON.stringify({network:props.config.network,updatedAt:state.updatedAt,quotedTokens:state.quoted,routeCount:state.routeCount,qualifying:state.qualifying,report:state.report},null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`arb-${props.config.network}-all-pairs-quotes.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <>
  <section className="panel padded all-pairs-controls"><div className="panel-top"><div><h2>Scan every factory pair</h2><p>All enabled V2 DEXs · resumable discovery · live {wrapped} route quotes</p></div><span className={'tag '+(running?'green-tag':'gray-tag')}>{running?'SCANNING':state?.phase==='complete'?state.errors.length||state.unreadable||state.quoteFailures?'COMPLETE WITH EXCLUSIONS':'COMPLETE':state?'PAUSED':'READY'}</span></div>
   <p>Every factory index is checked in batches of {pageSize}. Discovered {wrapped} tokens are quoted across your enabled DEXs, including tokens outside your manual list. Token-to-token pools are cataloged; the current executor supports {wrapped} round trips.</p>
   <div className="banner"><TriangleAlert size={17}/><span>{settings.skipFailedPools?'Skip failed pools is enabled. Failed reads/quotes are recorded and scanning continues.':'Strict mode: temporary pool-read or quote errors pause the scan.'}</span><button disabled={running} onClick={props.onSettings}>RPC settings</button></div>
   <div className="button-row"><button className="primary" disabled={loading||props.blocked||running} onClick={()=>void run()}>{loading?<Loader2 className="spin" size={15}/>:state?.phase==='complete'?<RefreshCw size={15}/>:<Play size={15}/>} {state?.phase==='complete'?'Refresh all quotes':state?'Resume all-pairs scan':'Scan all pairs'}</button><button disabled={!running} onClick={()=>{callbacks.current.onPause();controller.current?.abort();}}><Pause size={15}/> Pause</button><button disabled={running||loading||props.blocked} onClick={()=>void run(true)}><Layers size={15}/> Rebuild catalog</button><button disabled={!state?.report} onClick={exportReport}><Download size={15}/> Export best quotes</button></div>
   <p className="hint">Keep this tab open. Public RPC rate limits can make a full crawl take a long time. Pausing or reloading preserves the last saved page. Refresh re-quotes cached {wrapped} tokens and discovers newly appended pairs; rebuild revisits every pool. The route table retains the best 200 quotes. Simulation rechecks the selected route before signing.</p>
   {(error||state?.errors.length)&&<div className="banner warning"><TriangleAlert size={17}/><div>{error&&<p>{error}</p>}{state?.errors.map(e=><p key={e.name}>{e.name}: {e.message}</p>)}</div></div>}
   <div className="pair-stats"><div><strong>{format(done)} / {format(total)}</strong><span>Factory indices checked</span></div><div><strong>{format(state?.assets||0)}</strong><span>Unique {wrapped} tokens</span></div><div><strong>{format(state?.quoted||0)}</strong><span>Tokens quoted this pass</span></div><div><strong>{format(state?.qualifying||0)}</strong><span>Qualifying route quotes</span></div><div><strong>{format(state?.unreadable||0)}</strong><span>Skipped / unreadable pools</span></div><div><strong>{format(state?.quoteFailures||0)}</strong><span>Failed token quotes</span></div></div>
   <progress aria-label="Factory discovery progress" value={done} max={Math.max(total,1)}/><div className="pair-progress-note"><span role="status">{activity||'Ready to discover all factory pairs'}</span><span>{percent.toFixed(1)}% indexed</span></div>
   {state?.targets.map(t=><div key={t.router} className="factory-progress"><b>{t.name}</b><span>{format(t.cursor)} / {format(t.total)} pools</span><progress aria-label={t.name+' discovery progress'} value={t.cursor} max={Math.max(t.total,1)}/></div>)}
  </section>
  {failures.length>0&&<section className="panel padded"><div className="panel-top"><div><h2>Failed token quotes</h2><p>Showing up to 50 saved failures. These tokens are excluded from the opportunity summary until a quote succeeds.</p></div><button disabled={running||props.blocked} onClick={()=>void run(false,true)}><RefreshCw size={14}/> Retry failed quotes</button></div><div className="log-list">{failures.map(f=><div key={f.address}><b>{f.symbol}</b><p>{short(f.address)} · {f.message}</p></div>)}</div></section>}
  <section className="panel"><div className="panel-top"><div><h2>Discovered pool catalog</h2><p>Browse saved factory indices. {wrapped} reserves are displayed in {wrapped}; other reserves use raw token units.</p></div></div>
   <div className="pair-catalog-tools"><label>DEX<select value={router} onChange={e=>{setRouter(e.target.value);setOffset(0);}}>{state?.targets.map(t=><option key={t.router} value={t.router}>{t.name}</option>)}</select></label><label>First pair index<input type="number" min={0} max={Math.max((target?.total||1)-1,0)} value={offset} onChange={e=>{const n=Number(e.target.value);if(Number.isSafeInteger(n)&&n>=0)setOffset(n);}}/></label><div className="button-row"><button disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-pageSize))}>Previous</button><button disabled={!target||offset+pageSize>=target.cursor} onClick={()=>setOffset(offset+pageSize)}>Next</button><button disabled={running||props.blocked||!target||offset>=target.cursor} onClick={()=>void repairPage()}><RefreshCw size={14}/> Recheck page</button></div></div>
   <div className="table-wrap"><table><thead><tr><th>INDEX / PAIR</th><th>TOKENS</th><th>{wrapped} RESERVE</th><th>STATUS</th><th>CHECKED BLOCK</th></tr></thead><tbody>{pairs.map(p=><tr key={p.index}><td><b>#{format(p.index)} {p.asset?.symbol||''}</b><small>{p.address?<a href={NETWORKS[props.config.network].explorer+'/address/'+p.address} target="_blank" rel="noreferrer">{short(p.address)} <ExternalLink size={11}/></a>:'Pair address unreadable'}</small></td><td><small>{short(p.token0)} / {short(p.token1)}</small>{p.status==='catalog-only'&&<small title={'Raw reserves: '+p.reserve0+' / '+p.reserve1}>Raw: {p.reserve0} / {p.reserve1}</small>}</td><td>{p.wbnbReserve===undefined?'—':Number(p.wbnbReserve).toLocaleString('en-GB',{maximumFractionDigits:6})}</td><td><span className={'tag '+(p.status==='ready'?'green-tag':p.status==='catalog-only'?'gray-tag':'amber-tag')}>{status(p)}</span>{p.error&&<small>{p.error}</small>}{p.metadataError&&<small>{p.metadataError}</small>}</td><td>#{format(p.block)}</td></tr>)}</tbody></table>{!pairs.length&&<div className="empty"><Layers size={27}/><h3>{state?'This range has not been indexed yet':'Build your pool catalog'}</h3><p>Start or resume discovery to populate this factory range.</p></div>}</div>
  </section>
 </>;
}
