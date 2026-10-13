export const WSOL='So11111111111111111111111111111111111111112';
export const SOL_MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export type SolConfig={rpc:string,amount:string,minProfit:string,gasBudget:string,slippageBps:number,priorityFee:number,lookupTables:string[]};
export const SOL_DEFAULTS:SolConfig={rpc:'https://api.mainnet-beta.solana.com',amount:'1',minProfit:'0.0001',gasBudget:'0.001',slippageBps:10,priorityFee:25000,lookupTables:[]};
export function solUnits(v:unknown,label='Amount',positive=true):bigint{if(typeof v!=='string'||!/^\d{1,10}(?:\.\d{1,9})?$/.test(v))throw Error(label+' must be a decimal with up to nine places.');const [w,f='']=v.split('.'),n=BigInt(w)*1000000000n+BigInt(f.padEnd(9,'0'));if(positive&&!n)throw Error(label+' must be positive.');return n;}
export function solDecimal(v:bigint){const negative=v<0n,n=negative?-v:v;return (negative?'-':'')+n/1000000000n+'.'+String(n%1000000000n).padStart(9,'0');}
export function validateSolConfig(v:unknown):SolConfig{const c=v as SolConfig;if(!c||typeof c!=='object')throw Error('Invalid Solana settings.');let url:URL;try{url=new URL(c.rpc);}catch{throw Error('Use a public HTTPS RPC.');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||!url.hostname.includes('.')||/^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)|\.local$/i.test(url.hostname))throw Error('Use a public HTTPS RPC.');
 solUnits(c.amount,'Loan size');solUnits(c.minProfit,'Minimum net profit');if(solUnits(c.gasBudget,'Network budget')>1000000000n)throw Error('Network budget must not exceed one SOL.');
 if(!Number.isInteger(c.slippageBps)||c.slippageBps<1||c.slippageBps>200||!Number.isInteger(c.priorityFee)||c.priorityFee<0||c.priorityFee>1000000)throw Error('Use 1–200 bps slippage and 0–1,000,000 priority micro-lamports.');
 if(!Array.isArray(c.lookupTables)||c.lookupTables.length>6||c.lookupTables.some(x=>typeof x!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)))throw Error('Use up to six valid address lookup tables.');
 return {rpc:url.toString(),amount:c.amount,minProfit:c.minProfit,gasBudget:c.gasBudget,slippageBps:c.slippageBps,priorityFee:c.priorityFee,lookupTables:[...new Set(c.lookupTables)]};
}
export type SolRoute={id:string,token:string,symbol:string,buy:string,sell:string,buyPool:string,sellPool:string,amount:string,minAssetOut:string,output:string,repayment:string,fee:string,net:string,profitable:boolean,slot:number,at:number};
export type SolReport={routes:SolRoute[],notes:string[],slot:number,at:number,loanAvailable:string};
export type SolPreview={unsigned:string,owner:string,expires:number,lastValidBlockHeight:number,blockhash:string,route:SolRoute,fee:string,rent:string,minimumNet:string,units:number};
