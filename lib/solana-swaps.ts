import {PublicKey,type TransactionInstruction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import {sha256,toUtf8Bytes,getBytes} from 'ethers';
import {AMM_V4,AMM_STABLE,CLMM_PROGRAM_ID,CREATE_CPMM_POOL_PROGRAM,Router} from '@raydium-io/raydium-sdk-v2/lib/common/programId.js';
import {WSOL} from './solana-types.ts';
export const PUMP=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const rayPrograms=[AMM_V4,AMM_STABLE,CLMM_PROGRAM_ID,CREATE_CPMM_POOL_PROGRAM,Router];
export const allowedPrograms=new Set([PUMP,...rayPrograms].map(p=>p.toBase58()));
const anchor=(name:string)=>Buffer.from(getBytes(sha256(toUtf8Bytes('global:'+name)))).subarray(0,8);
const isAnchor=(ix:TransactionInstruction,name:string)=>ix.data.subarray(0,8).equals(anchor(name));
export function nativeOutputMinimum(ix:TransactionInstruction,owner:PublicKey):bigint{
 const ata=getAssociatedTokenAddressSync(new PublicKey(WSOL),owner),account=(i:number,p:PublicKey)=>!!ix.keys[i]?.pubkey.equals(p),pid=ix.programId;
 const verify=(ok:boolean)=>{if(!ok)throw Error('Final swap format or wallet output account could not be verified.');};
 if(pid.equals(PUMP)){verify(ix.data.length>=24&&isAnchor(ix,'sell')&&account(6,ata)&&account(1,owner)&&account(4,new PublicKey(WSOL)));return ix.data.readBigUInt64LE(16);}
 if(pid.equals(Router)){verify(ix.data.length>=17&&(ix.data.length-17)%16===0&&ix.data[0]===0&&account(4,owner)&&account(6,ata));return ix.data.readBigUInt64LE(9);}
 if(pid.equals(AMM_V4)||pid.equals(AMM_STABLE)){verify(ix.data.length===17&&(ix.data[0]===9||pid.equals(AMM_V4)&&ix.data[0]===16)&&account(ix.keys.length-2,ata)&&account(ix.keys.length-1,owner));return ix.data.readBigUInt64LE(9);}
 if(pid.equals(CLMM_PROGRAM_ID)){verify(ix.data.length===41&&(isAnchor(ix,'swap')||isAnchor(ix,'swap_v2'))&&ix.data[40]===1&&account(4,ata)&&account(0,owner));return ix.data.readBigUInt64LE(16);}
 if(pid.equals(CREATE_CPMM_POOL_PROGRAM)){verify(ix.data.length===24&&isAnchor(ix,'swap_base_input')&&account(5,ata)&&account(0,owner));return ix.data.readBigUInt64LE(16);}
 throw Error('Unsupported final swap program.');
}
