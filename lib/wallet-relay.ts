import {Transaction,keccak256,parseUnits} from 'ethers';
import artifact from '../artifacts/FlashArbitrageV2.json' with {type:'json'};
import {Rpc} from './rpc.ts';
import {NETWORKS,validateConfig,amount,address,same} from './model.ts';
import {verifyContract} from './engine.ts';
const READ_METHODS=new Set(['eth_chainId','eth_getTransactionCount','eth_call','eth_estimateGas','eth_getBalance','eth_gasPrice']);
export async function walletRead(value:unknown,method:string,params:unknown[],injected?:Rpc){
 const c=validateConfig(value);if(!READ_METHODS.has(method)||!Array.isArray(params)||params.length>2||JSON.stringify(params).length>32000)throw Error('Unsupported wallet RPC request.');
 const rpc=injected||new Rpc(c.rpc);const chain=await rpc.send('eth_chainId');if(Number(chain)!==c.network)throw Error('RPC chain mismatch.');if(method==='eth_chainId')return chain;return rpc.send(method,params);
}
export async function broadcastSigned(value:unknown,raw:string,owner:string,injected?:Rpc){
 const c=validateConfig(value),expectedOwner=address(owner,'Wallet');if(typeof raw!=='string'||!/^0x[0-9a-f]+$/i.test(raw)||raw.length>38000)throw Error('Invalid signed transaction.');
 let tx:Transaction;try{tx=Transaction.from(raw);}catch{throw Error('Invalid signed transaction.');}
 if(!tx.signature||!tx.from||!same(tx.from,expectedOwner)||tx.chainId!==BigInt(c.network)||tx.type!==0||tx.value!==0n)throw Error('Signed transaction owner, network or type does not match the review.');
 if(tx.gasLimit<=0n||tx.gasLimit>10000000n||!tx.gasPrice||tx.gasPrice>parseUnits(c.maxGasGwei,9))throw Error('Signed transaction gas parameters exceed the configured limits.');
 const rpc=injected||new Rpc(c.rpc);if(Number(await rpc.send('eth_chainId'))!==c.network)throw Error('RPC chain mismatch.');
 if(tx.to){if(!c.contract||!same(tx.to,c.contract))throw Error('Only the configured GUI executor may be called by the local wallet.');await verifyContract(c,expectedOwner,rpc);}
 else if(!tx.data.toLowerCase().startsWith(artifact.bytecode.toLowerCase()))throw Error('Only the included GUI executor may be deployed.');
 const budget=amount(c.gasBudget)*(tx.to?1n:10n);if(tx.gasLimit*tx.gasPrice>budget)throw Error('Signed transaction exceeds its fee budget.');
 const [pending,confirmed,balance]=await rpc.batch([{method:'eth_getTransactionCount',params:[expectedOwner,'pending']},{method:'eth_getTransactionCount',params:[expectedOwner,'latest']},{method:'eth_getBalance',params:[expectedOwner,'latest']}]);
 if([pending,confirmed,balance].some(r=>r.error)||BigInt(pending.value)!==BigInt(confirmed.value)||BigInt(pending.value)!==BigInt(tx.nonce))throw Error('Wallet nonce changed or another transaction is pending.');
 if(BigInt(balance.value)<tx.gasLimit*tx.gasPrice)throw Error('Wallet has insufficient '+NETWORKS[c.network].nativeSymbol+' for the fee reserve.');
 await rpc.send('eth_call',[{from:expectedOwner,to:tx.to||undefined,data:tx.data,value:'0x0',gas: '0x'+tx.gasLimit.toString(16),gasPrice:'0x'+tx.gasPrice.toString(16)},'latest']);
 const hash=keccak256(raw),result=await rpc.send('eth_sendRawTransaction',[raw]);if(typeof result!=='string'||result.toLowerCase()!==hash.toLowerCase())throw Error('Submission result is uncertain. Keep the saved intended hash and check receipts.');
 return {hash};
}
