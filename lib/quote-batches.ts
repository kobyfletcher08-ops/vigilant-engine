import type {Asset} from './model';
import type {Scan} from './engine';
import {skippableRead} from './rpc-errors.ts';
export async function quoteBatch(assets:Asset[],read:(assets:Asset[])=>Promise<Scan>,skip:boolean,success:(assets:Asset[],report:Scan)=>Promise<void>,failure:(asset:Asset,message:string)=>Promise<void>,signal:AbortSignal){
 const check=()=>{if(signal.aborted)throw new DOMException('Scan paused.','AbortError');};
 check();let report:Scan|undefined,batchError:unknown;
 try{report=await read(assets);}catch(e){check();if(!skip||!skippableRead(e))throw e;batchError=e;}
 check();if(report){await success(assets,report);return;}
 for(const asset of assets){check();let result:Scan|undefined,error=batchError;
  if(assets.length>1)try{result=await read([asset]);}catch(e){check();if(!skippableRead(e))throw e;error=e;}
  check();if(result)await success([asset],result);else await failure(asset,(error as Error).message);
 }
}
