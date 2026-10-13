import {PublicKey,TransactionInstruction,SYSVAR_INSTRUCTIONS_PUBKEY,ComputeBudgetProgram,TransactionMessage,VersionedTransaction,type AddressLookupTableAccount} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import BN from 'bn.js';
import {flashBorrowReserveLiquidity,DISCRIMINATOR as BORROW} from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/flashBorrowReserveLiquidity.js';
import {flashRepayReserveLiquidity,DISCRIMINATOR as REPAY} from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/flashRepayReserveLiquidity.js';
import {WSOL} from './solana-types.ts';
export const KAMINO_PROGRAM=new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const KAMINO_MARKET=new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
export type LoanState={address:string,market:string,mint:string,supplyVault:string,feeVault:string,feeSf:bigint,available:bigint};
export const feeForLoan=(borrow:bigint,feeSf:bigint)=>feeSf===0n?0n:((borrow*feeSf+(1n<<60n)-1n)/(1n<<60n)||1n);
export function loanBounds(output:bigint,borrow:bigint,feeSf:bigint,budget:bigint,minNet:bigint,rent=0n){const fee=feeForLoan(borrow,feeSf),repayment=borrow+fee,net=output-repayment-budget-rent;return {fee,repayment,net,minimumOut:repayment+budget+minNet+rent,qualifies:net>=minNet};}
export function toWeb3Instruction(ix:any){return new TransactionInstruction({programId:new PublicKey(ix.programAddress),data:Buffer.from(ix.data),keys:ix.accounts.map((a:any)=>({pubkey:new PublicKey(a.address),isSigner:!!(a.role&2),isWritable:!!(a.role&1)}))});}
export function flashInstructions(owner:PublicKey,loan:LoanState,borrow:bigint,borrowIndex:number){
 if(loan.market!==KAMINO_MARKET.toBase58()||loan.mint!==WSOL||borrow<=0n||borrow>loan.available||borrowIndex<0||borrowIndex>255||loan.feeSf===(1n<<64n)-1n)throw Error('Invalid or unavailable SOL flash loan.');
 const authority=PublicKey.findProgramAddressSync([Buffer.from('lma'),KAMINO_MARKET.toBuffer()],KAMINO_PROGRAM)[0],ata=getAssociatedTokenAddressSync(new PublicKey(WSOL),owner);
 const shared:any={userTransferAuthority:{address:owner.toBase58()},lendingMarketAuthority:authority.toBase58(),lendingMarket:loan.market,reserve:loan.address,reserveLiquidityMint:loan.mint,reserveLiquidityFeeReceiver:loan.feeVault,referrerTokenState:{__option:'None'},referrerAccount:{__option:'None'},sysvarInfo:SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(),tokenProgram:TOKEN_PROGRAM_ID.toBase58()},args={liquidityAmount:new BN(borrow.toString())};
 return {borrow:toWeb3Instruction(flashBorrowReserveLiquidity(args,{...shared,reserveSourceLiquidity:loan.supplyVault,userDestinationLiquidity:ata.toBase58()})),repay:toWeb3Instruction(flashRepayReserveLiquidity({...args,borrowInstructionIndex:borrowIndex},{...shared,reserveDestinationLiquidity:loan.supplyVault,userSourceLiquidity:ata.toBase58()}))};
}
export function compileSolTransaction(owner:PublicKey,blockhash:string,instructions:TransactionInstruction[],tables:AddressLookupTableAccount[]=[]){
 const message=new TransactionMessage({payerKey:owner,recentBlockhash:blockhash,instructions}).compileToV0Message(tables);if(message.header.numRequiredSignatures!==1)throw Error('The route requests an unexpected additional signer.');
 const tx=new VersionedTransaction(message);try{if(tx.serialize().length>1232)throw Error();}catch{throw Error('Route exceeds Solana transaction size. Add lookup tables for the selected pools in Solana settings or choose another route.');}return tx;
}
export function validateFlashPlan(instructions:TransactionInstruction[],owner:PublicKey,allowedPrograms:Set<string>,minimumOut:bigint,lastMinimum:(ix:TransactionInstruction)=>bigint){
 const loans=instructions.map((ix,index)=>({ix,index})).filter(x=>x.ix.programId.equals(KAMINO_PROGRAM));if(loans.length!==2||!loans[0].ix.data.subarray(0,8).equals(BORROW)||!loans[1].ix.data.subarray(0,8).equals(REPAY))throw Error('Exactly one flash borrow and matching repayment are required.');
 const [borrow,repay]=loans;if(borrow.ix.data.length!==16||repay.ix.data.length!==17||repay.ix.data[16]!==borrow.index||repay.ix.data.readBigUInt64LE(8)!==borrow.ix.data.readBigUInt64LE(8)||borrow.index>=repay.index)throw Error('Flash repayment does not match the borrow instruction.');
 const ata=getAssociatedTokenAddressSync(new PublicKey(WSOL),owner),authority=PublicKey.findProgramAddressSync([Buffer.from('lma'),KAMINO_MARKET.toBuffer()],KAMINO_PROGRAM)[0];
 for(const x of loans){if(x.ix.keys.length!==12||!x.ix.keys[0].pubkey.equals(owner)||!x.ix.keys[1].pubkey.equals(authority)||!x.ix.keys[2].pubkey.equals(KAMINO_MARKET)||x.ix.keys[4].pubkey.toBase58()!==WSOL||!x.ix.keys[6].pubkey.equals(ata)||!x.ix.keys[8].pubkey.equals(KAMINO_PROGRAM)||!x.ix.keys[9].pubkey.equals(KAMINO_PROGRAM)||!x.ix.keys[10].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)||!x.ix.keys[11].pubkey.equals(TOKEN_PROGRAM_ID))throw Error('Flash-loan accounts do not match this wallet and market.');}
 for(const n of [3,5,7])if(!borrow.ix.keys[n].pubkey.equals(repay.ix.keys[n].pubkey))throw Error('Flash-loan reserve or vault changed.');
 const swaps=instructions.slice(borrow.index+1,repay.index);if(swaps.length!==2||swaps.some(ix=>!allowedPrograms.has(ix.programId.toBase58())))throw Error('Both supported swaps must sit between borrow and repayment.');
 if(lastMinimum(swaps[1])<minimumOut)throw Error('The final swap does not enforce repayment and the net-profit floor.');
 for(let i=0;i<instructions.length;i++){const ix=instructions[i];if(i>borrow.index&&i<repay.index||ix.programId.equals(KAMINO_PROGRAM))continue;
  if(ix.programId.equals(ComputeBudgetProgram.programId)){if(i>borrow.index)throw Error('Compute budget must precede the loan.');continue;}
  if(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)){if(i>borrow.index||ix.keys.length!==6||!ix.keys[0].pubkey.equals(owner)||!ix.keys[2].pubkey.equals(owner)||!ix.keys[5].pubkey.equals(TOKEN_PROGRAM_ID)||ix.data.length!==1||ix.data[0]!==1||!ix.keys[1].pubkey.equals(getAssociatedTokenAddressSync(ix.keys[3].pubkey,owner)))throw Error('Unexpected token-account setup.');continue;}
  if(ix.programId.equals(TOKEN_PROGRAM_ID)){if(i<=repay.index||i!==instructions.length-1||ix.data.length!==1||ix.data[0]!==9||ix.keys.length!==3||!ix.keys[0].pubkey.equals(ata)||!ix.keys[1].pubkey.equals(owner)||!ix.keys[2].pubkey.equals(owner))throw Error('Unexpected token-account authority or transfer.');continue;}
  throw Error('Transaction contains an unsupported instruction.');
 }
 return {borrow:borrow.ix.data.readBigUInt64LE(8),reserve:borrow.ix.keys[3].pubkey,supply:borrow.ix.keys[5].pubkey,feeVault:borrow.ix.keys[7].pubkey};
}
