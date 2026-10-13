export type RpcReason='rate-limit'|'block-unavailable'|'timeout'|'contract-revert'|'provider'|'invalid-response';
export function classifyRpcError(error:any){
 const code=Number(error?.code),message=String(error?.message||'');let reason:RpcReason;
 if(/rate.?limit|too many|quota|request limit/i.test(message)||[-32005,-32016].includes(code))reason='rate-limit';
 else if(/header not found|missing trie|unknown block|archive|state.*(unavailable|missing)|block.*not found/i.test(message))reason='block-unavailable';
 else if(/timed?\s*out|timeout/i.test(message)||code===-32002)reason='timeout';
 else if(/execution reverted|revert(ed)?|invalid opcode|out of gas|VM execution error/i.test(message))reason='contract-revert';
 else reason='provider';
 return {error:'RPC call failed ('+(Number.isFinite(code)?code:'unknown')+'; '+reason+').',reason,retryable:reason!=='contract-revert'&&(reason!=='provider'||code===-32603||/temporar|unavailable/i.test(message))};
}
export function rpcFailure(label:string,results:{error?:string,reason?:RpcReason,retryable?:boolean}[]){
 const failed=results.filter(r=>r.retryable),codes=Array.from(new Set(failed.map(r=>r.error||'Invalid response'))).slice(0,2).join(' ');
 const reason=failed[0]?.reason,hint=reason==='block-unavailable'?'RPC cannot serve the pinned block; use a state-capable endpoint.':reason==='rate-limit'?'Use slower pacing or a higher-capacity RPC.':reason==='timeout'?'Use smaller batches or another RPC.':'Try smaller RPC batches or another endpoint.';
 return 'RPC '+label+' temporarily unavailable. '+codes+' '+hint;
}
export function skippableRead(error:unknown){const e=error as Error;return e.name!=='AbortError'&&/RPC.*(temporar|unavailable|rate.?limit|read.*failed|call.*failed)|HTTP (429|502|503|504)|fetch failed|network error|timed out|timeout/i.test(e.message||'');}
