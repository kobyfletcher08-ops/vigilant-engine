export type RpcSettings={batchSize:number,delayMs:number,pageSize:number,skipFailedPools:boolean};
export const DEFAULT_RPC_SETTINGS:RpcSettings={batchSize:8,delayMs:200,pageSize:16,skipFailedPools:true};
export function validateRpcSettings(value:unknown):RpcSettings{
 const p={...DEFAULT_RPC_SETTINGS,...(value&&typeof value==='object'&&!Array.isArray(value)?value:{})} as RpcSettings;
 if(![4,8,16].includes(p.batchSize))throw Error('RPC batch size must be 4, 8 or 16.');
 if(!Number.isInteger(p.delayMs)||p.delayMs<0||p.delayMs>2000)throw Error('RPC batch delay must be 0–2000 ms.');
 if(![8,16,32].includes(p.pageSize))throw Error('Discovery page size must be 8, 16 or 32.');
 if(typeof p.skipFailedPools!=='boolean')throw Error('Choose whether failed pools should be skipped.');
 return {batchSize:p.batchSize,delayMs:p.delayMs,pageSize:p.pageSize,skipFailedPools:p.skipFailedPools};
}
