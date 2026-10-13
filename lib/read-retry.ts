function wait(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
 if(signal.aborted){reject(new DOMException('Scan paused.','AbortError'));return;}
 const abort=()=>{clearTimeout(timer);reject(new DOMException('Scan paused.','AbortError'));};
 const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});
});}
// Used only by discovery/quote reads. Transaction submissions are never retried here.
export async function retryRead<T>(read:()=>Promise<T>,signal:AbortSignal,onRetry:(attempt:number)=>void,delay=1500):Promise<T>{
 for(let attempt=1;attempt<=3;attempt++){
  if(signal.aborted)throw new DOMException('Scan paused.','AbortError');
  try{return await read();}catch(e){
   if(signal.aborted||(e as Error).name==='AbortError')throw e;
   if(attempt===3||!/RPC.*(unavailable|limited|temporar|reliab|not be read|failed)|HTTP (429|502|503|504)|fetch failed|network|timeout|timed out/i.test((e as Error).message))throw e;
   onRetry(attempt+1);await wait(delay*attempt,signal);
  }
 }throw Error('RPC read retries exhausted.');
}
