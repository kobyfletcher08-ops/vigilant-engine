import {Mnemonic,computeHmac,getBytes,toUtf8Bytes} from 'ethers';
import {Keypair,PublicKey,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
export const SOL_VAULT_KEY='dex-arb-solana-vault-v1';
export const SOL_DEFAULT_PATH="m/44'/501'/0'/0'";
export type SolVault={version:1,chain:'solana',address:string,path:string,salt:string,iv:string,ciphertext:string,iterations:number};
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64');
const bytes=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
const validPath=(p:string)=>p.length<=160&&/^m(?:\/(?:0|[1-9]\d*)'){1,10}$/.test(p)&&p.split('/').slice(1).every(x=>BigInt(x.slice(0,-1))<2147483648n);
export function deriveSolanaWallet(phrase:string,passphrase='',path=SOL_DEFAULT_PATH){
 const normalized=phrase.normalize('NFKD').trim().toLowerCase().replace(/\s+/g,' ');
 if(![12,15,18,21,24].includes(normalized.split(' ').length)||!Mnemonic.isValidMnemonic(normalized))throw Error('Enter a valid English BIP-39 recovery phrase.');
 if(!validPath(path))throw Error('Solana requires a fully hardened derivation path with indices below 2³¹.');
 let material=getBytes(computeHmac('sha512',toUtf8Bytes('ed25519 seed'),Mnemonic.fromPhrase(normalized,passphrase.normalize('NFKD')).computeSeed()));
 for(const index of path.split('/').slice(1)){const data=new Uint8Array(37);data.set(material.slice(0,32),1);new DataView(data.buffer).setUint32(33,Number(index.slice(0,-1))+2147483648,false);const next=getBytes(computeHmac('sha512',material.slice(32),data));material.fill(0);data.fill(0);material=next;}
 const seed=material.slice(0,32);material.fill(0);try{return Keypair.fromSeed(seed);}finally{seed.fill(0);}
}
async function encryptionKey(password:string,salt:Uint8Array,iterations:number){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:salt as BufferSource,iterations},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
export function validateSolVault(value:unknown):SolVault{
 const v=value as SolVault;if(!v||v.version!==1||v.chain!=='solana'||!Number.isInteger(v.iterations)||v.iterations<310000||v.iterations>1000000||typeof v.path!=='string'||!validPath(v.path))throw Error('Invalid Solana encrypted backup.');
 try{if(!PublicKey.isOnCurve(new PublicKey(v.address).toBytes()))throw Error();for(const [field,size]of [[v.salt,16],[v.iv,12],[v.ciphertext,48]] as const){if(typeof field!=='string'||field.length>100||!/^[-A-Za-z0-9+/]+={0,2}$/.test(field)||bytes(field).length!==size||b64(bytes(field))!==field)throw Error();}}catch{throw Error('Invalid Solana encrypted backup.');}
 return {version:1,chain:'solana',address:v.address,path:v.path,salt:v.salt,iv:v.iv,ciphertext:v.ciphertext,iterations:v.iterations};
}
export async function encryptSolanaWallet(wallet:Keypair,password:string,path:string):Promise<SolVault>{
 if(password.length<12)throw Error('Use an encryption password with at least 12 characters.');if(!validPath(path))throw Error('Invalid hardened derivation path.');const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),iterations=310000,key=await encryptionKey(password,salt,iterations),seed=wallet.secretKey.slice(0,32);
 try{const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,seed);return {version:1,chain:'solana',address:wallet.publicKey.toBase58(),path,salt:b64(salt),iv:b64(iv),ciphertext:b64(new Uint8Array(encrypted)),iterations};}finally{seed.fill(0);}
}
export async function unlockSolanaWallet(value:unknown,password:string){const v=validateSolVault(value);try{const key=await encryptionKey(password,bytes(v.salt),v.iterations),seed=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(v.iv) as BufferSource},key,bytes(v.ciphertext) as BufferSource));try{const wallet=Keypair.fromSeed(seed);if(wallet.publicKey.toBase58()!==v.address)throw Error();return wallet;}finally{seed.fill(0);}}catch{throw Error('Cannot unlock: incorrect password or damaged Solana backup.');}}
export class SolanaLocalSigner{
 private seed:Uint8Array|null;readonly address:string;
 constructor(wallet:Keypair){this.seed=wallet.secretKey.slice(0,32);this.address=wallet.publicKey.toBase58();}
 get unlocked(){return this.seed!==null;}
 lock(){this.seed?.fill(0);this.seed=null;}
 sign(unsigned:string,owner:string,expires:number){if(!this.seed)throw Error('Unlock the Solana wallet first.');if(owner!==this.address||!Number.isSafeInteger(expires)||Date.now()>expires)throw Error('The wallet changed or the review expired.');if(typeof unsigned!=='string'||unsigned.length>2000)throw Error('Invalid Solana transaction.');
  const tx=VersionedTransaction.deserialize(Buffer.from(unsigned,'base64'));if(tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==owner||tx.signatures.some(s=>s.some(b=>b!==0)))throw Error('Unexpected Solana transaction signer.');
  const keypair=Keypair.fromSeed(this.seed);try{tx.sign([keypair]);return {raw:Buffer.from(tx.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0])};}finally{keypair.secretKey.fill(0);}
 }
}
