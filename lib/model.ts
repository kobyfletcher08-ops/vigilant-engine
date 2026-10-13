import {getAddress,parseUnits,formatUnits,ZeroAddress} from 'ethers';
import {validateRpcSettings,type RpcSettings} from './rpc-settings.ts';
export const DEV_ADDRESS='0x6A3404e7fdeE519AaaB364E1C27Db07aa99Ec922';
export const NETWORKS={
 56:{name:'BSC Mainnet',shortName:'BSC',nativeName:'BNB',nativeSymbol:'BNB',wrappedSymbol:'WBNB',rpc:'https://bsc-dataseed.bnbchain.org',factory:'0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',router:'0x10ED43C718714eb63d5aA57B78B54704E256024E',explorer:'https://bscscan.com'},
 97:{name:'BSC Testnet',shortName:'BSC Testnet',nativeName:'BNB',nativeSymbol:'BNB',wrappedSymbol:'WBNB',rpc:'https://data-seed-prebsc-1-s1.bnbchain.org:8545',factory:'0x6725F303b657a9451d8BA641348b6761A6CC7a17',router:'0xD99D1c33F9fC3444f8101754aBC46c52416550D1',explorer:'https://testnet.bscscan.com'},
 42161:{name:'Arbitrum One',shortName:'Arbitrum',nativeName:'Ether',nativeSymbol:'ETH',wrappedSymbol:'WETH',rpc:'https://arb1.arbitrum.io/rpc',factory:'0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E',router:'0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb',explorer:'https://arbiscan.io'}
} as const;
export type NetworkId=keyof typeof NETWORKS;
export function supportedNetwork(value:unknown):value is NetworkId{return typeof value==='number'&&[56,97,42161].includes(value);}
export type Asset={symbol:string,address:string,enabled:boolean};
export type Dex={name:string,address:string,enabled:boolean};
export type Config={rpcSettings?:RpcSettings,network:NetworkId,rpc:string,amount:string,maxAmount:string,minProfit:string,maxGasGwei:string,gasBudget:string,slippageBps:number,interval:number,reserveShareBps:number,minReserve:string,contract:string,tokens:Asset[],dexes:Dex[]};
export const DEFAULT_CONFIG:Config={network:56,rpc:NETWORKS[56].rpc,amount:'0.1',maxAmount:'1',minProfit:'0.001',maxGasGwei:'5',gasBudget:'0.002',slippageBps:30,interval:30,reserveShareBps:100,minReserve:'25',contract:'',tokens:[{symbol:'USDT',address:'0x55d398326f99059fF775485246999027B3197955',enabled:true},{symbol:'USDC',address:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',enabled:true},{symbol:'BUSD',address:'0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',enabled:false},{symbol:'CAKE',address:'0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',enabled:true}],dexes:[{name:'PancakeSwap V2',address:NETWORKS[56].router,enabled:true},{name:'Biswap',address:'0x3A6d8cA21D1CF76F653A67577FA0D27453350dD8',enabled:true},{name:'ApeSwap',address:'0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607',enabled:true},{name:'MDEX',address:'0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8',enabled:false}]};
export function networkDefaults(network:NetworkId):Config{
 if(network===56)return structuredClone(DEFAULT_CONFIG);
 if(network===97)return {...structuredClone(DEFAULT_CONFIG),network,rpc:NETWORKS[97].rpc,contract:'',tokens:[],dexes:[{name:'PancakeSwap Testnet',address:NETWORKS[97].router,enabled:true}]};
 if(network!==42161)throw Error('Unsupported network.');
 return {...structuredClone(DEFAULT_CONFIG),network,rpc:NETWORKS[42161].rpc,contract:'',amount:'0.01',maxAmount:'0.1',minProfit:'0.00001',maxGasGwei:'1',gasBudget:'0.00005',minReserve:'5',tokens:[
  {symbol:'USDC',address:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',enabled:true},
  {symbol:'USDT0',address:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',enabled:true},
  {symbol:'ARB',address:'0x912CE59144191C1204E64559FE8253a0e49E6548',enabled:true}
 ],dexes:[{name:'PancakeSwap V2',address:NETWORKS[42161].router,enabled:true},{name:'Uniswap V2',address:'0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',enabled:true}]};
}
export function safeRpc(value:unknown){let u:URL;try{u=new URL(String(value));}catch{throw Error('Enter a valid HTTPS RPC URL.');}
 if(u.protocol!=='https:'||u.username||u.password||u.hash||!u.hostname.includes('.')||/^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)|\.local$/i.test(u.hostname))throw Error('Use a public HTTPS RPC host without URL credentials or fragments.');return u.toString();}
export function amount(value:unknown,name='Amount',positive=true){if(typeof value!=='string'||!/^\d+(\.\d{1,18})?$/.test(value))throw Error(name+' must be a decimal with at most 18 places.');const n=parseUnits(value,18);if(n<0n||positive&&n===0n)throw Error(name+' must be positive.');return n;}
const integer=(value:unknown,label:string,min:number,max:number)=>{if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)throw Error(`${label} must be ${min}–${max}.`);return Number(value);};
export function address(value:unknown,label='Address'){let a;try{a=getAddress(String(value).toLowerCase());}catch{throw Error(label+' is invalid.');}if(a===ZeroAddress)throw Error(label+' cannot be zero.');return a;}
export function validateConfig(value:unknown):Config{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Configuration must be an object.');const c=value as Config;
 if(!supportedNetwork(c.network))throw Error('Choose BSC mainnet/testnet or Arbitrum One.');const net=NETWORKS[c.network];
 const size=amount(c.amount,'Trade size'),max=amount(c.maxAmount,'Maximum size');if(size>max||max>parseUnits('1000000000',18))throw Error('Trade size must be within the maximum, up to 1,000,000,000 '+net.wrappedSymbol+'.');
 amount(c.minProfit,'Minimum net profit');amount(c.minReserve,'Minimum '+net.wrappedSymbol+' reserves');amount(c.gasBudget,'Gas budget');if(amount(c.gasBudget)>parseUnits('1',18))throw Error('Gas budget must not exceed 1 '+net.nativeSymbol+'.');
 if(amount(c.maxGasGwei)>parseUnits('1000',18))throw Error('Gas price cap must not exceed 1000 gwei.');
 if(!Array.isArray(c.dexes)||c.dexes.length>8||!Array.isArray(c.tokens)||c.tokens.length>6)throw Error('Configure up to 8 routers and 6 tokens.');
 const dexes=c.dexes.map(x=>({name:String(x.name).trim().slice(0,24),address:address(x.address,'Router'),enabled:Boolean(x.enabled)}));
 const tokens=c.tokens.map(x=>({symbol:String(x.symbol).replace(/[^a-z0-9_-]/gi,'').slice(0,12)||'TOKEN',address:address(x.address,'Token'),enabled:Boolean(x.enabled)}));
 if(new Set(dexes.map(x=>x.address)).size!==dexes.length||new Set(tokens.map(x=>x.address)).size!==tokens.length)throw Error('Duplicate token/router addresses.');
 return {rpcSettings:validateRpcSettings(c.rpcSettings),network:c.network,rpc:safeRpc(c.rpc),amount:c.amount,maxAmount:c.maxAmount,minProfit:c.minProfit,maxGasGwei:c.maxGasGwei,gasBudget:c.gasBudget,minReserve:c.minReserve,slippageBps:integer(c.slippageBps,'Slippage (bps)',1,200),interval:integer(c.interval,'Scan interval',15,3600),reserveShareBps:integer(c.reserveShareBps,'Pool share (bps)',1,500),contract:c.contract?address(c.contract,'Executor'):'',dexes,tokens};
}
export const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
export const repayment=(borrow:bigint)=>ceil(borrow*10000n,9975n);
export function profitBounds(output:bigint,borrow:bigint,gasBudget:bigint,minNet:bigint){const repay=repayment(borrow),gross=output-repay,dev=gross>0n?gross*200n/10000n:0n,net=gross-dev-gasBudget;const minGross=ceil((gasBudget+minNet)*10000n,9800n);return {repay,gross,dev,net,minGross,minOut:repay+minGross,qualifies:net>=minNet&&output>=repay+minGross};}
export const bnb=(value:bigint)=>formatUnits(value,18);
export const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function scanAssets(value:unknown):Asset[]{
 if(!Array.isArray(value)||!value.length||value.length>4)throw Error('Quote 1–4 discovered tokens per batch.');
 const tokens=value.map(t=>({address:address(t?.address,'Discovered token'),symbol:String(t?.symbol||'TOKEN').replace(/[^a-z0-9_.-]/gi,'').slice(0,12)||'TOKEN',enabled:true}));
 if(new Set(tokens.map(t=>t.address.toLowerCase())).size!==tokens.length)throw Error('Duplicate discovered tokens.');
 return tokens;
}
