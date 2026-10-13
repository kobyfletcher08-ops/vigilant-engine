import {PublicKey,Connection,TransactionInstruction,VersionedTransaction,TransactionMessage,ComputeBudgetProgram} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createCloseAccountInstruction,unpackAccount,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {rayVenue,pumpVenue} from './solana-plan';
import {lender,loanBounds,flashInstructions,validateFlashPlan,nativeOutputMinimum,solDecimal,solUnits,allowedPrograms,KAMINO_PROGRAM} from './solana-math';
import {tokenPairs} from './market-feed';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { HttpsProxyAgent } from 'https-proxy-agent';
export type SolConfig={rpc:string,proxy?:string,amount:string,maxAmount:string,minProfit:string,gasBudget:string,slippageBps:number,priorityFee:number,lookupTables:string[]};
export type SolLoan={address:string,supplyVault:string,feeVault:string,feeSf:bigint,available:bigint};
export type SolRoute={id:string,token:string,symbol:string,buy:string,sell:string,buyPool:string,sellPool:string,amount:string,minAssetOut:string,output:string,repayment:string,fee:string,net:string,profitable:boolean,slot:number,at:number};
export type SolReport={routes:SolRoute[],notes:string[],slot:number,at:number,loanAvailable:string};
export type SolPreview={unsigned:string,owner:string,expires:number,blockhash:string,lastValidBlockHeight:number,route:SolRoute,fee:string,rent:string,minimumNet:string,units:number};
export type Quote={pools:string[],out:bigint,buyPath?:any[],sellPath?:any[]};
export type Venue={name:string,id:string,quote:(mint:string,amount:bigint)=>Promise<Quote>,build:(mint:string,amount:bigint,minOut:bigint,q:Quote,owner:PublicKey)=>Promise<{instructions:TransactionInstruction[],tables:PublicKey[]}>};
const WSOL='So11111111111111111111111111111111111111112';
function key(value:unknown,signer=false){try{const k=new PublicKey(String(value));if(signer&&!PublicKey.isOnCurve(k))throw Error();return k;}catch{throw Error('Invalid wallet address.');}}
export function validateSolConfig(value:unknown):SolConfig{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Configuration must be an object.');const c=value as SolConfig;
 let u:URL;try{u=new URL(String(c.rpc));}catch{throw Error('Enter a valid RPC URL.');}if(!['http:','https:'].includes(u.protocol))throw Error('Use an HTTP or HTTPS RPC URL.');
 let p=undefined;if(c.proxy){try{const pu=new URL(String(c.proxy));if(!['http:','https:'].includes(pu.protocol))throw Error();p=pu.toString();}catch{throw Error('Use an HTTP or HTTPS proxy URL.');}}
 const num=(v:unknown,name:string,max:number,places=9)=>{if(typeof v!=='string'||!/^\d+(\.\d+)?$/.test(v))throw Error(name+' must be a decimal.');const p=v.split('.')[1]?.length||0;if(p>places)throw Error(name+' must not exceed '+places+' decimal places.');const f=parseFloat(v);if(f<=0||f>max)throw Error(name+' must be 0–'+max+'.');return v;};
 const size=solUnits(num(c.amount,'Trade size',1000)),max=solUnits(num(c.maxAmount,'Maximum size',1000));if(size>max)throw Error('Trade size must be within the maximum.');
 num(c.minProfit,'Minimum net profit',1000);num(c.gasBudget,'Gas budget',0.5);
 const int=(v:unknown,label:string,min:number,max:number)=>{if(!Number.isInteger(v)||Number(v)<min||Number(v)>max)throw Error(`${label} must be ${min}–${max}.`);return Number(v);};
 if(!Array.isArray(c.lookupTables)||c.lookupTables.length>10||c.lookupTables.some(t=>typeof t!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)))throw Error('Configure up to 10 valid lookup table addresses.');
 return {rpc:u.toString(),proxy:p,amount:c.amount,maxAmount:c.maxAmount,minProfit:c.minProfit,gasBudget:c.gasBudget,slippageBps:int(c.slippageBps,'Slippage (bps)',1,1000),priorityFee:int(c.priorityFee,'Priority fee (microLamports)',0,1000000000),lookupTables:c.lookupTables.slice()};
}
export function solFetch(c:SolConfig){
    return (url:RequestInfo|URL,init?:RequestInit)=>{
        const options:RequestInit={...init,redirect:'manual',signal:AbortSignal.timeout(12000)};
        if(c.proxy)options.dispatcher=new HttpsProxyAgent(c.proxy);
        return fetch(url,options);
    };
}
export function solConnection(c:SolConfig){return new Connection(c.rpc,{commitment:'confirmed',disableRetryOnRateLimit:true,httpAgent:false,fetch:solFetch(c)});}
async function chainCheck(c:Connection){const height=await c.getSlot('confirmed');if(height<100000000)throw Error('RPC is connected to a different network.');return height;}
const lookupCache=new Map<string,{expires:number,promise:Promise<PublicKey[]>}>();
async function lookupTables(c:Connection,addresses:string[]){
 const resolve=async(address:string)=>{const acc=await c.getAddressLookupTable(new PublicKey(address));if(acc.value)return acc.value.state.addresses;throw Error('Lookup table not found.');};
 return(await Promise.all(addresses.map(async address=>{const found=lookupCache.get(address);if(found&&found.expires>Date.now())return found.promise;if(lookupCache.size>100)lookupCache.clear();
  const promise=resolve(address).catch(e=>{lookupCache.delete(address);throw e;});lookupCache.set(address,{expires:Date.now()+180000,promise});return promise;}))).flat();
}
async function load(configValue:unknown,tokenValue:unknown,symbolValue:unknown,ownerValue?:unknown){
 const config=validateSolConfig(configValue),c=solConnection(config),token=key(tokenValue),owner=ownerValue?key(ownerValue,true):null,borrow=solUnits(config.amount);
 if(token.toBase58()===WSOL)throw Error('Enter a token other than SOL.');
 const slot=await chainCheck(c),loan=await lender(c,borrow),at=Date.now();
 const pairs=(await tokenPairs('solana',token.toBase58(),solFetch(config))).filter(p=>[p.base.address,p.quote.address].includes(WSOL)&&p.liquidity>=1000).sort((a,b)=>b.liquidity-a.liquidity),venues:Venue[]=[],notes:string[]=[];
 if(pairs.some(p=>p.dex==='raydium'))venues.push(rayVenue(c,token));for(const p of pairs.filter(p=>p.dex==='pumpswap').slice(0,2)){try{venues.push(await pumpVenue(c,p.id,token,owner));}catch{notes.push('PumpSwap '+p.id.slice(0,8)+': pool data unavailable.');}}
 const routes:SolRoute[]=[],details=new Map<string,{buy:Venue,sell:Venue,bq:Quote,sq:Quote}>();
 for(const buy of venues){let bq:Quote;try{bq=await buy.quote(WSOL,borrow);}catch{notes.push(buy.name+': buy quote unavailable at this size.');continue;}const asset=bq.out*BigInt(10000-config.slippageBps)/10000n;if(!asset)continue;
  for(const sell of venues){if(buy.id===sell.id)continue;try{const sq=await sell.quote(token.toBase58(),asset);if(bq.pools.some(p=>sq.pools.includes(p)))continue;const output=sq.out*BigInt(10000-config.slippageBps)/10000n,bounds=loanBounds(output,borrow,loan.feeSf,solUnits(config.gasBudget),solUnits(config.minProfit)),id=bq.pools.join(',')+'|'+sq.pools.join(',');
   routes.push({id,token:token.toBase58(),symbol:String(symbolValue||'TOKEN').replace(/[^a-z0-9_.-]/gi,'').slice(0,16),buy:buy.name,sell:sell.name,buyPool:bq.pools[0],sellPool:sq.pools[0],amount:config.amount,minAssetOut:asset.toString(),output:solDecimal(output),repayment:solDecimal(bounds.repayment),fee:solDecimal(bounds.fee),net:solDecimal(bounds.net),profitable:bounds.qualifies,slot,at});details.set(id,{buy,sell,bq,sq});
  }catch{notes.push(sell.name+': sell quote unavailable at this size.');}}
 }
 if(Date.now()-at>45000)throw Error('Quotes took over 45 seconds. Choose a faster RPC and retry.');const signed=(n:string)=>solUnits(n.replace('-',''),'Net',false)*(n.startsWith('-')?-1n:1n);routes.sort((a,b)=>signed(a.net)>signed(b.net)?-1:signed(a.net)<signed(b.net)?1:0);
 notes.push('Execution supports direct standard-SPL routes through Raydium and PumpSwap with different pools. Quotes include Kamino fees and your network budget. Preparation also covers new token-account rent.');if(venues.length<2)notes.push('At least two supported venues with different pools are required.');
 const report:SolReport={routes,notes:[...new Set(notes)],slot,at,loanAvailable:solDecimal(loan.available)};return {config,c,token,loan,report,details};
}
export async function solQuote(v:unknown,token:unknown,symbol:unknown){return (await load(v,token,symbol)).report;}
export async function solPrepare(v:unknown,token:unknown,symbol:unknown,routeId:unknown,ownerValue:unknown):Promise<SolPreview>{
 const owner=key(ownerValue,true),l=await load(v,token,symbol,owner),route=l.report.routes.find(r=>r.id===routeId);if(!route?.profitable)throw Error('The refreshed route is below your net-profit floor.');const native=getAssociatedTokenAddressSync(new PublicKey(WSOL),owner),asset=getAssociatedTokenAddressSync(l.token,owner),accounts=await l.c.getMultipleAccountsInfo([native,asset]),setup:TransactionInstruction[]=[];let rent=0n,cash=0n;
 for(let i=0;i<2;i++){const mint=i===0?new PublicKey(WSOL):l.token,ata=i===0?native:asset;if(accounts[i]){const a=unpackAccount(ata,accounts[i]!,TOKEN_PROGRAM_ID);if(!a.owner.equals(owner)||!a.mint.equals(mint))throw Error('Unexpected wallet token account.');}else{setup.push(createAssociatedTokenAccountIdempotentInstruction(owner,ata,owner,mint));const cost=BigInt(await l.c.getMinimumBalanceForRentExemption(165));cash+=cost;if(i===1)rent+=cost;}}
 const borrow=solUnits(l.config.amount),bounds=loanBounds(solUnits(route.output),borrow,l.loan.feeSf,solUnits(l.config.gasBudget),solUnits(l.config.minProfit),rent);if(!bounds.qualifies)throw Error('Quote cannot cover token-account rent and minimum net profit.');const d=l.details.get(route.id)!,buy=await d.buy.build(WSOL,borrow,BigInt(route.minAssetOut),d.bq,owner),sell=await d.sell.build(l.token.toBase58(),BigInt(route.minAssetOut),bounds.minimumOut,d.sq,owner),prefix=[ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:l.config.priorityFee}),...setup],flash=flashInstructions(owner,l.loan,borrow,prefix.length),instructions=[...prefix,flash.borrow,...buy.instructions,...sell.instructions,flash.repay];if(!accounts[0])instructions.push(createCloseAccountInstruction(native,owner,owner));
 validateFlashPlan(instructions,owner,allowedPrograms,bounds.minimumOut,ix=>nativeOutputMinimum(ix,owner));const configured=await lookupTables(l.c,l.config.lookupTables),tables=[...new Map([...configured,...buy.tables,...sell.tables].map(t=>[t.key.toBase58(),t])).values()],latest=await l.c.getLatestBlockhash('confirmed'),tx=compileSolTransaction(owner,latest.blockhash,instructions,tables),fee=await l.c.getFeeForMessage(tx.message,'confirmed');
 if(fee.value===null||BigInt(fee.value)>solUnits(l.config.gasBudget))throw Error('Network fee exceeds budget.');if(BigInt(await l.c.getBalance(owner))<BigInt(fee.value)+cash)throw Error('The wallet needs native SOL for fees and token-account rent. Kamino supplies the loan principal.');const sim=await l.c.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed'});if(sim.value.err)throw Error('Atomic flash-loan simulation failed: '+JSON.stringify(sim.value.err).slice(0,150));
 return {unsigned:Buffer.from(tx.serialize()).toString('base64'),owner:owner.toBase58(),expires:Date.now()+30000,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,route,fee:solDecimal(BigInt(fee.value)),rent:solDecimal(rent),minimumNet:l.config.minProfit,units:sim.value.unitsConsumed||0};
}
function compileSolTransaction(owner:PublicKey,blockhash:string,instructions:TransactionInstruction[],tables:PublicKey[]){
 const msg=new TransactionMessage({payerKey:owner,recentBlockhash:blockhash,instructions}).compileToV0Message();return new VersionedTransaction(msg);
}
async function validateTx(c:Connection,tx:VersionedTransaction,config:SolConfig,owner:PublicKey,lastValid:unknown){
 if(tx.message.header.numRequiredSignatures!==1||!tx.message.staticAccountKeys[0].equals(owner)||!Number.isSafeInteger(lastValid))throw Error('Invalid transaction owner or lifetime.');if(await c.getBlockHeight('confirmed')>Number(lastValid))throw Error('Transaction expired. Prepare again.');
 const tables=await lookupTables(c,'addressTableLookups'in tx.message?tx.message.addressTableLookups.map(t=>t.accountKey.toBase58()):[]),instructions=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables}).instructions,borrowIx=instructions.find(ix=>ix.programId.equals(KAMINO_PROGRAM));if(!borrowIx||borrowIx.data.length<16)throw Error('Missing flash borrow.');const borrow=borrowIx.data.readBigUInt64LE(8);if(borrow!==solUnits(config.amount))throw Error('Flash-loan size changed.');const loan=await lender(c,borrow);let rent=0n;
 for(const ix of instructions){if(ix.keys.length===6&&ix.data.length===1&&ix.data[0]===1&&ix.keys[3].pubkey.toBase58()!==WSOL&&!await c.getAccountInfo(ix.keys[1].pubkey))rent+=BigInt(await c.getMinimumBalanceForRentExemption(165));}
 const minimum=loanBounds(0n,borrow,loan.feeSf,solUnits(config.gasBudget),solUnits(config.minProfit),rent).minimumOut,checked=validateFlashPlan(instructions,owner,allowedPrograms,minimum,ix=>nativeOutputMinimum(ix,owner));if(checked.reserve.toBase58()!==loan.address||checked.supply.toBase58()!==loan.supplyVault||checked.feeVault.toBase58()!==loan.feeVault)throw Error('Lender reserve or vault changed.');const fee=await c.getFeeForMessage(tx.message);if(fee.value===null||BigInt(fee.value)>solUnits(config.gasBudget))throw Error('Network fee exceeds budget.');
}
export async function solSimulate(v:unknown,unsigned:unknown,ownerValue:unknown,lastValid:unknown){const config=validateSolConfig(v),c=solConnection(config),owner=key(ownerValue,true);await chainCheck(c);if(typeof unsigned!=='string'||unsigned.length>2000)throw Error('Invalid transaction.');const tx=VersionedTransaction.deserialize(Buffer.from(unsigned,'base64'));await validateTx(c,tx,config,owner,lastValid);const sim=await c.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed'});if(sim.value.err)throw Error('Fresh simulation failed: '+JSON.stringify(sim.value.err).slice(0,150));return {ok:true};}
export async function solBroadcast(v:unknown,raw:unknown,ownerValue:unknown,lastValid:unknown){const config=validateSolConfig(v),c=solConnection(config),owner=key(ownerValue,true);await chainCheck(c);if(typeof raw!=='string'||raw.length>2000)throw Error('Invalid signed transaction.');const tx=VersionedTransaction.deserialize(Buffer.from(raw,'base64'));if(!nacl.sign.detached.verify(tx.message.serialize(),tx.signatures[0],owner.toBytes()))throw Error('Invalid wallet signature.');await validateTx(c,tx,config,owner,lastValid);const sim=await c.simulateTransaction(tx,{sigVerify:true,commitment:'confirmed'});if(sim.value.err)throw Error('Signed simulation failed before broadcast.');const signature=bs58.encode(tx.signatures[0]),returned=await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});if(returned!==signature)throw Error('Unexpected RPC signature.');return {signature};}
export async function solCheck(v:unknown,ownerValue:unknown){const config=validateSolConfig(v),c=solConnection(config),slot=await chainCheck(c);return {slot,balance:ownerValue?solDecimal(BigInt(await c.getBalance(key(ownerValue,true)))):null};}
export async function solStatuses(v:unknown,items:unknown){const c=solConnection(validateSolConfig(v));await chainCheck(c);if(!Array.isArray(items)||items.length>20||items.some(i=>typeof i.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(i.signature)||!Number.isSafeInteger(i.lastValidBlockHeight)))throw Error('Invalid signature list.');const rows=await c.getSignatureStatuses(items.map(i=>i.signature),{searchTransactionHistory:true}),height=await c.getBlockHeight('confirmed');return items.map((item,i)=>{const s=rows.value[i];return {signature:item.signature,status:s?.err?'failed':s?.confirmationStatus==='confirmed'||s?.confirmationStatus==='finalized'?'confirmed':s?'pending':height>item.lastValidBlockHeight?'expired':'unknown'};});}
