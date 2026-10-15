import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG,NETWORKS,networkDefaults,supportedNetwork,validateConfig,same} from '../lib/model.ts';
import {validateProfiles,selectNetwork,profileBackup} from '../lib/network-profiles.ts';

test('Arbitrum One has independent ETH/WETH defaults with V2 routers and chain-specific assets',()=>{
 const c=validateConfig(networkDefaults(42161));assert.equal(c.network,42161);assert.equal(c.contract,'');
 assert.equal(NETWORKS[c.network].nativeSymbol,'ETH');assert.equal(NETWORKS[c.network].wrappedSymbol,'WETH');
 assert.equal(c.rpc,'https://arb1.arbitrum.io/rpc');assert.equal(NETWORKS[c.network].explorer,'https://arbiscan.io');
 assert.deepEqual(c.dexes.map(d=>d.name),['PancakeSwap V2','Uniswap V2']);assert.ok(same(c.dexes[0].address,NETWORKS[c.network].router));
 assert.deepEqual(c.tokens.map(t=>t.symbol),['USDC','USDT0','ARB']);assert.ok(c.tokens.every(a=>!DEFAULT_CONFIG.tokens.some(b=>same(a.address,b.address))));
 assert.ok(c.dexes.every(a=>!DEFAULT_CONFIG.dexes.some(b=>same(a.address,b.address))));
 c.tokens[0].enabled=false;assert.equal(networkDefaults(42161).tokens[0].enabled,true);assert.equal(DEFAULT_CONFIG.network,56);
});
test('unsupported chains cannot enter network profiles or masquerade as Arbitrum One',()=>{
 for(const network of [1,421614,42170,'42161',undefined]){assert.equal(supportedNetwork(network),false);assert.throws(()=>validateConfig({...networkDefaults(42161),network}),/Choose/);}
 assert.throws(()=>validateProfiles({42161:networkDefaults(56)},networkDefaults(56)),/does not match its chain/);
 assert.throws(()=>validateProfiles({42161:{...networkDefaults(42161),gasBudget:'2'}},networkDefaults(56)),/1 ETH/);
});
test('switching networks restores RPC, limits, routers and separate executor addresses',()=>{
 const bsc=validateConfig({...networkDefaults(56),contract:'0x'+'1'.repeat(40),rpc:'https://rpc.example.com/bsc-token',amount:'0.3'});
 let selected=selectNetwork({},bsc,42161);assert.equal(selected.config.contract,'');assert.equal(selected.config.network,42161);
 const arb=validateConfig({...selected.config,contract:'0x'+'2'.repeat(40),rpc:'https://rpc.example.com/arb-token',amount:'0.02',dexes:selected.config.dexes.map(d=>({...d,enabled:false}))});
 selected=selectNetwork(selected.profiles,arb,56);assert.deepEqual(selected.config,bsc);
 selected=selectNetwork(selected.profiles,selected.config,42161);assert.deepEqual(selected.config,arb);assert.ok(!same(selected.profiles[56]!.contract,selected.config.contract));
});
test('legacy settings migrate to the selected profile and survive a multi-network reload',()=>{
 const bsc=validateConfig({...networkDefaults(56),contract:'0x'+'3'.repeat(40)}),old=validateProfiles(undefined,bsc);assert.deepEqual(Object.keys(old),['56']);
 const switched=selectNetwork(old,bsc,42161),saved=JSON.parse(JSON.stringify({config:switched.config,profiles:switched.profiles}));
 const reloaded=validateProfiles(saved.profiles,validateConfig(saved.config)),back=selectNetwork(reloaded,saved.config,56);assert.deepEqual(back.config,bsc);
});
test('configuration backups redact RPC credentials from every saved network and round-trip profiles',()=>{
 const bsc=validateConfig({...networkDefaults(56),rpc:'https://rpc.example.com/bsc-secret?key=private-bsc',proxy:'host:8080:login:proxy-secret'}),arb=validateConfig({...networkDefaults(42161),rpc:'https://rpc.example.com/arb-secret?key=private-arb',contract:'0x'+'4'.repeat(40)});
 const backup=profileBackup({56:bsc,42161:arb},arb),serialized=JSON.stringify(backup);assert.equal(backup.version,3);assert.doesNotMatch(serialized,/secret|private-bsc|private-arb/);
 const restored=validateProfiles(JSON.parse(serialized).profiles,validateConfig(backup.config));assert.equal(restored[56]!.rpc,new URL(NETWORKS[56].rpc).toString());assert.equal(restored[42161]!.rpc,NETWORKS[42161].rpc);assert.equal(restored[42161]!.contract,arb.contract);
});
