import test from 'node:test';
import assert from 'node:assert/strict';
import {Mnemonic,Transaction,Wallet,keccak256} from 'ethers';
import {deriveImportedWallet,encryptImportedWallet,unlockImportedWallet,vaultFromBackup,validateKeystore,LocalSigner,DEFAULT_PATH} from '../lib/browser-wallet.ts';
import {walletRead,broadcastSigned} from '../lib/wallet-relay.ts';
import {DEFAULT_CONFIG,networkDefaults} from '../lib/model.ts';
import {Rpc} from '../lib/rpc.ts';
import artifact from '../artifacts/FlashArbitrageV2.json' with {type:'json'};
// Public, unfunded BIP-39 test vector. Never use this account for actual funds.
const phrase='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('imports all five BIP-39 lengths, normalizes whitespace/case and derives the selected account',()=>{
 const wallet=deriveImportedWallet(phrase);assert.equal(wallet.address,'0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
 assert.equal(deriveImportedWallet('  '+phrase.toUpperCase().replaceAll(' ',' \n')+' ').address,wallet.address);
 for(const bytes of [16,20,24,28,32])assert.ok(deriveImportedWallet(Mnemonic.fromEntropy('0x'+'00'.repeat(bytes)).phrase).address);
 assert.notEqual(deriveImportedWallet(phrase,'extra').address,wallet.address);
 assert.notEqual(deriveImportedWallet(phrase,'',"m/44'/60'/0'/0/1").address,wallet.address);
 assert.throws(()=>deriveImportedWallet('abandon '.repeat(12)),/valid English/);
 assert.throws(()=>deriveImportedWallet(phrase,'',"m/44'/60'/2147483648'/0/0"),/derivation path/);
});

test('encrypted vault contains no phrase/key/password; backup restores and wrong passwords fail',async()=>{
 const wallet=deriveImportedWallet(phrase),password='browser-local-test-password';
 const vault=await encryptImportedWallet(wallet,password,DEFAULT_PATH);
 const serialized=JSON.stringify(vault);assert.ok(!serialized.includes(phrase));assert.ok(!serialized.includes(wallet.privateKey.slice(2)));assert.ok(!serialized.includes(password));
 const encrypted=JSON.parse(vault.keystore),crypto=encrypted.crypto||encrypted.Crypto;assert.equal(crypto.kdfparams.n,65536);assert.ok(!encrypted['x-ethers']);
 const restored=vaultFromBackup(vault.keystore),unlocked=await unlockImportedWallet(restored,password);assert.equal(unlocked.address,wallet.address);
 await assert.rejects(unlockImportedWallet(vault,'wrong password'),/incorrect password/);
 await assert.rejects(encryptImportedWallet(wallet,'short',DEFAULT_PATH),/12 characters/);
 crypto.kdfparams.n=2**30;assert.throws(()=>validateKeystore(JSON.stringify(encrypted)),/bounded/);
});

test('local signer signs only reviewed owner/chain and locking disables further signatures',async()=>{
 const wallet=deriveImportedWallet(phrase),requests:any[]=[];
 const signer=new LocalSigner(wallet,async(method,params)=>{requests.push({method,params});return method==='eth_chainId'?'0x38':'0x0';});
 assert.deepEqual(await signer.request({method:'eth_accounts'}),[wallet.address]);assert.equal(await signer.request({method:'eth_chainId'}),'0x38');
 const tx={from:wallet.address,chainId:'0x38',nonce:'0x0',to:'0x'+'1'.repeat(40),data:'0x',value:'0x0',gas:'0x5208',gasPrice:'0x3b9aca00'};
 const signed=await signer.sign(tx,56),parsed=Transaction.from(signed.raw);assert.equal(parsed.from,wallet.address);assert.equal(parsed.chainId,56n);assert.equal(signed.hash,keccak256(signed.raw));
 assert.ok(!JSON.stringify(requests).includes(phrase));assert.ok(!JSON.stringify(requests).includes(wallet.privateKey));
 await assert.rejects(signer.sign(tx,97),/chain changed/);
 await assert.rejects(signer.request({method:'eth_sendRawTransaction',params:[signed.raw]}),/Unsupported/);
 signer.lock();assert.equal(signer.unlocked,false);assert.deepEqual(await signer.request({method:'eth_accounts'}),[]);await assert.rejects(signer.sign(tx,56),/Unlock/);
});

test('wallet RPC proxy rejects signing/broadcast methods and verifies selected chain',async()=>{
 const rpc={send:async()=> '0x38'} as unknown as Rpc;
 await assert.rejects(walletRead(DEFAULT_CONFIG,'eth_sendRawTransaction',[],rpc),/Unsupported/);
 await assert.rejects(walletRead(DEFAULT_CONFIG,'personal_sign',[],rpc),/Unsupported/);
 assert.equal(await walletRead(DEFAULT_CONFIG,'eth_chainId',[],rpc),'0x38');
 await assert.rejects(walletRead(DEFAULT_CONFIG,'eth_chainId',[],{send:async()=> '0x61'} as unknown as Rpc),/mismatch/);
});

test('signed relay verifies owner, chain, fee cap and nonce; rejects unrelated deployments',async()=>{
 const wallet=deriveImportedWallet(phrase);let broadcasts=0;
 const rpc={send:async(method:string,params:any[])=>{if(method==='eth_chainId')return '0x38';if(method==='eth_call')return '0x';if(method==='eth_sendRawTransaction'){broadcasts++;return keccak256(params[0]);}throw Error('Unexpected method');},batch:async()=>[{value:'0x0'},{value:'0x0'},{value:'0xde0b6b3a7640000'}]} as unknown as Rpc;
 const raw=await wallet.signTransaction({type:0,chainId:56,nonce:0,gasLimit:1000000,gasPrice:1000000000,data:artifact.bytecode});
 assert.equal((await broadcastSigned(DEFAULT_CONFIG,raw,wallet.address,rpc)).hash,keccak256(raw));assert.equal(broadcasts,1);
 await assert.rejects(broadcastSigned(DEFAULT_CONFIG,raw,Wallet.createRandom().address,rpc),/owner/);
 await assert.rejects(broadcastSigned({...DEFAULT_CONFIG,network:97,rpc:'https://example.com'},raw,wallet.address,rpc),/network/);
 const other=await wallet.signTransaction({type:0,chainId:56,nonce:0,gasLimit:100000,gasPrice:1000000000,data:'0x1234'});await assert.rejects(broadcastSigned(DEFAULT_CONFIG,other,wallet.address,rpc),/included GUI/);
 const highFee=await wallet.signTransaction({type:0,chainId:56,nonce:0,gasLimit:1000000,gasPrice:6000000000,data:artifact.bytecode});await assert.rejects(broadcastSigned(DEFAULT_CONFIG,highFee,wallet.address,rpc),/gas parameters/);
 const badNonce={...rpc,batch:async()=>[{value:'0x1'},{value:'0x0'},{value:'0xde0b6b3a7640000'}]} as unknown as Rpc;await assert.rejects(broadcastSigned(DEFAULT_CONFIG,raw,wallet.address,badNonce),/nonce changed/);
 assert.equal(broadcasts,1);
});
test('local signer binds Arbitrum signatures to chain 42161 and rejects network substitution',async()=>{
 const wallet=deriveImportedWallet(phrase),signer=new LocalSigner(wallet,async()=> '0xa4b1');
 const tx={from:wallet.address,chainId:'0xa4b1',nonce:'0x0',to:'0x'+'1'.repeat(40),data:'0x',value:'0x0',gas:'0x5208',gasPrice:'0x989680'};
 const signed=await signer.sign(tx,42161),parsed=Transaction.from(signed.raw);assert.equal(parsed.chainId,42161n);assert.equal(parsed.from,wallet.address);assert.equal(signed.hash,keccak256(signed.raw));
 await assert.rejects(signer.sign(tx,56),/chain changed/);await assert.rejects(signer.sign({...tx,chainId:'0x38'},42161),/chain changed/);
 await assert.rejects(signer.sign({...tx,chainId:'0x1'},1),/chain changed/);signer.lock();await assert.rejects(signer.sign(tx,42161),/Unlock/);
});
test('Arbitrum wallet reads and signed relay enforce network, ETH budget, owner and nonce',async()=>{
 const wallet=deriveImportedWallet(phrase),config=networkDefaults(42161);let broadcasts=0;
 const rpc={send:async(method:string,params:any[])=>{if(method==='eth_chainId')return '0xa4b1';if(method==='eth_call')return '0x';if(method==='eth_sendRawTransaction'){broadcasts++;return keccak256(params[0]);}throw Error('Unexpected method');},batch:async()=>[{value:'0x0'},{value:'0x0'},{value:'0xde0b6b3a7640000'}]} as unknown as Rpc;
 const raw=await wallet.signTransaction({type:0,chainId:42161,nonce:0,gasLimit:1000000,gasPrice:10000000,data:artifact.bytecode});
 assert.equal(await walletRead(config,'eth_chainId',[],rpc),'0xa4b1');assert.equal((await broadcastSigned(config,raw,wallet.address,rpc)).hash,keccak256(raw));
 await assert.rejects(broadcastSigned(DEFAULT_CONFIG,raw,wallet.address,rpc),/network/);
 await assert.rejects(broadcastSigned(config,raw,Wallet.createRandom().address,rpc),/owner/);
 await assert.rejects(broadcastSigned({...config,gasBudget:'0.00000001'},raw,wallet.address,rpc),/fee budget/);
 const poor={...rpc,batch:async()=>[{value:'0x0'},{value:'0x0'},{value:'0x0'}]} as unknown as Rpc;await assert.rejects(broadcastSigned(config,raw,wallet.address,poor),/insufficient ETH/);
 const stale={...rpc,batch:async()=>[{value:'0x1'},{value:'0x0'},{value:'0xde0b6b3a7640000'}]} as unknown as Rpc;await assert.rejects(broadcastSigned(config,raw,wallet.address,stale),/nonce changed/);
 const wrong={...rpc,send:async()=> '0x38'} as unknown as Rpc;await assert.rejects(walletRead(config,'eth_chainId',[],wrong),/chain mismatch/);await assert.rejects(broadcastSigned(config,raw,wallet.address,wrong),/chain mismatch/);
 assert.equal(broadcasts,1);
});
