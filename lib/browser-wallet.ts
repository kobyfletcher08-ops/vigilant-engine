import {HDNodeWallet,Mnemonic,Wallet,encryptKeystoreJson,keccak256,getAddress} from 'ethers';
import {supportedNetwork} from './model.ts';
export const VAULT_KEY='bsc-arb-local-keystore-v1';
export const DEFAULT_PATH="m/44'/60'/0'/0/0";
export type Vault={version:1,address:string,path:string,keystore:string};
export function deriveImportedWallet(phrase:string,passphrase='',path=DEFAULT_PATH){
 const normalized=phrase.normalize('NFKD').trim().toLowerCase().replace(/\s+/g,' ');
 if(![12,15,18,21,24].includes(normalized.split(' ').length)||!Mnemonic.isValidMnemonic(normalized))throw Error('Enter a valid English BIP-39 phrase with 12, 15, 18, 21 or 24 words.');
 if(!/^m(?:\/(?:0|[1-9]\d*)'?){1,10}$/.test(path)||path.split('/').slice(1).some(x=>BigInt(x.replace("'",''))>=2147483648n))throw Error('Enter a valid derivation path; each index must be below 2³¹.');
 try{const derived=HDNodeWallet.fromPhrase(normalized,passphrase.normalize('NFKD'),path);return new Wallet(derived.privateKey);}catch{throw Error('Cannot derive this wallet. Check the phrase and derivation path.');}
}
export async function encryptImportedWallet(wallet:Wallet,password:string,path:string,progress?:(p:number)=>void):Promise<Vault>{
 if(password.length<12)throw Error('Use a unique encryption password with at least 12 characters.');
 // Serialize ONLY the derived account. Never retain the mnemonic or its passphrase.
 const keystore=await encryptKeystoreJson({address:wallet.address,privateKey:wallet.privateKey},password,{scrypt:{N:65536,r:8,p:1},progressCallback:progress});
 return {version:1,address:wallet.address,path,keystore};
}
export function validateKeystore(json:string){
 if(typeof json!=='string'||json.length>60000)throw Error('Encrypted keystore exceeds the size limit.');
 let data:any;try{data=JSON.parse(json);}catch{throw Error('Invalid encrypted keystore JSON.');}
 const crypto=data.crypto||data.Crypto,kdf=crypto?.kdfparams;
 if(data.version!==3||!/^([a-f0-9]{40})$/i.test(data.address||'')||crypto?.cipher!=='aes-128-ctr'||crypto?.kdf!=='scrypt'||!Number.isInteger(kdf?.n)||kdf.n<16384||kdf.n>262144||(kdf.n&(kdf.n-1))!==0||kdf.r!==8||!Number.isInteger(kdf.p)||kdf.p<1||kdf.p>4||kdf.dklen!==32)throw Error('Use an Ethereum V3 scrypt keystore with bounded encryption settings.');
 return data;
}
export async function unlockImportedWallet(vault:Vault,password:string,progress?:(p:number)=>void){
 const data=validateKeystore(vault.keystore);
 try{const decrypted=await Wallet.fromEncryptedJson(vault.keystore,password,progress),wallet=new Wallet(decrypted.privateKey);if(wallet.address.toLowerCase()!==('0x'+data.address).toLowerCase()||wallet.address.toLowerCase()!==vault.address.toLowerCase())throw Error();return wallet;}catch{throw Error('Cannot unlock: incorrect password or damaged encrypted keystore.');}
}
export function vaultFromBackup(json:string):Vault{const data=validateKeystore(json);return {version:1,address:getAddress('0x'+data.address),path:'Imported encrypted account',keystore:json};}
export class LocalSigner {
 private wallet:Wallet|null;readonly address:string;private rpc:(method:string,params:any[])=>Promise<any>;
 constructor(wallet:Wallet,rpc:(method:string,params:any[])=>Promise<any>){this.wallet=wallet;this.address=wallet.address;this.rpc=rpc;}
 get unlocked(){return this.wallet!==null;}
 lock(){this.wallet=null;}
 async request({method,params=[]}:{method:string,params?:any[]}){
  if(method==='eth_accounts'||method==='eth_requestAccounts')return this.wallet?[this.address]:[];
  if(!['eth_chainId','eth_getTransactionCount','eth_call','eth_estimateGas','eth_getBalance','eth_gasPrice'].includes(method))throw Error('Unsupported local-wallet operation.');
  return this.rpc(method,params);
 }
 async sign(transaction:any,chainId:number){
  const wallet=this.wallet;if(!wallet)throw Error('Unlock the imported wallet first.');
  if(!supportedNetwork(chainId)||Number(transaction.chainId)!==chainId||transaction.from?.toLowerCase()!==this.address.toLowerCase())throw Error('Wallet or chain changed. Prepare a new transaction.');
  const nonce=Number(BigInt(transaction.nonce));if(!Number.isSafeInteger(nonce)||nonce<0)throw Error('Invalid transaction nonce.');
  if(!/^0x[0-9a-f]*$/i.test(transaction.data)||BigInt(transaction.gas)<=0n||BigInt(transaction.gasPrice)<=0n)throw Error('Invalid transaction preview.');
  const raw=await wallet.signTransaction({type:0,chainId,nonce,to:transaction.to||undefined,data:transaction.data,value:BigInt(transaction.value||0),gasLimit:BigInt(transaction.gas),gasPrice:BigInt(transaction.gasPrice)});
  if(this.wallet!==wallet)throw Error('The wallet was locked before signing completed.');
  return {raw,hash:keccak256(raw)};
 }
}
