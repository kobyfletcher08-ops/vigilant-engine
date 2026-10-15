import {NETWORKS,networkDefaults,supportedNetwork,validateConfig,type Config,type NetworkId} from './model.ts';
export type NetworkProfiles=Partial<Record<NetworkId,Config>>;
export function validateProfiles(value:unknown,current:Config):NetworkProfiles{
 const profiles:NetworkProfiles={};
 if(value&&typeof value==='object'&&!Array.isArray(value))for(const [id,raw] of Object.entries(value)){
  const network=Number(id);if(!supportedNetwork(network))continue;const c=validateConfig(raw);if(c.network!==network)throw Error('Saved network profile does not match its chain.');profiles[network]=c;
 }
 profiles[current.network]=validateConfig(current);return profiles;
}
export function selectNetwork(profiles:NetworkProfiles,current:Config,network:NetworkId){
 const saved={...profiles,[current.network]:validateConfig(current)},config=validateConfig(saved[network]||networkDefaults(network));
 if(config.network!==network)throw Error('Network profile mismatch.');
 return {profiles:{...saved,[network]:config},config};
}
export function profileBackup(profiles:NetworkProfiles,current:Config){
 const safe=Object.fromEntries(Object.entries(validateProfiles(profiles,current)).map(([id,c])=>[id,{...c,rpc:NETWORKS[c.network].rpc,proxy:''}]));
 return {version:3,config:{...current,rpc:NETWORKS[current.network].rpc,proxy:''},profiles:safe};
}
