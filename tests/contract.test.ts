import test from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import solc from 'solc';
import {readFile} from 'node:fs/promises';
import {BrowserProvider,ContractFactory,Wallet,parseEther} from 'ethers';
import artifact from '../artifacts/FlashArbitrageV2.json' with {type:'json'};
const input={language:'Solidity',sources:{'Mocks.sol':{content:await readFile(new URL('./Mocks.sol',import.meta.url),'utf8')}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
const output=JSON.parse((solc as any).compile(JSON.stringify(input)));const errors=(output.errors||[]).filter((x:any)=>x.severity==='error');assert.deepEqual(errors,[]);
async function fixture(){
 const raw=(ganache as any).provider({logging:{quiet:true},chain:{chainId:56,hardfork:'shanghai'},wallet:{totalAccounts:2,defaultBalance:1000}}),provider=new BrowserProvider(raw,undefined,{cacheTimeout:-1});
 const accounts=Object.values(raw.getInitialAccounts()) as any[],owner=new Wallet(accounts[0].secretKey,provider),other=new Wallet(accounts[1].secretKey,provider);
 const deploy=async(name:string,args:any[]=[])=>{const data=output.contracts['Mocks.sol'][name],c=await new ContractFactory(data.abi,'0x'+data.evm.bytecode.object,owner).deploy(...args);await c.waitForDeployment();return c as any;};
 const wrapped=await deploy('MockToken'),asset=await deploy('MockToken'),loanToken=await deploy('MockToken'),factory=await deploy('MockFactory'),factoryB=await deploy('MockFactory');
 const lender=await deploy('MockPair',[wrapped.target,loanToken.target]),tradePair=await deploy('MockPair',[wrapped.target,asset.target]),tradePairB=await deploy('MockPair',[wrapped.target,asset.target]);
 await(await factory.setPair(wrapped.target,loanToken.target,lender.target)).wait();await(await factory.setPair(wrapped.target,asset.target,tradePair.target)).wait();await(await factoryB.setPair(wrapped.target,asset.target,tradePairB.target)).wait();
 const buy=await deploy('MockRouter',[factory.target,wrapped.target,2000,1]),sell=await deploy('MockRouter',[factoryB.target,wrapped.target,11,20000]);
 const executor=await new ContractFactory(artifact.abi,artifact.bytecode,owner).deploy(wrapped.target,factory.target,[buy.target,sell.target]) as any;await executor.waitForDeployment();
 for(const [token,recipient,n] of [[wrapped,lender.target,'100'],[asset,buy.target,'1000000'],[wrapped,sell.target,'100']] as const)await(await token.mint(recipient,parseEther(n))).wait();
 const trade={loanPair:lender.target,token:asset.target,buyRouter:buy.target,sellRouter:sell.target,amount:parseEther('1'),minAssetOut:parseEther('1900'),minWbnbOut:parseEther('1.05'),minProfit:parseEther('0.04'),deadline:(await provider.getBlock('latest'))!.timestamp+90};
 return{raw,provider,owner,other,wrapped,asset,factory,buy,sell,lender,tradePair,executor,trade,close:async()=>{provider.destroy();await raw.disconnect();}};
}
test('authenticated flash swap repays rounded fee, distributes 98/2 profit and preserves donations',async()=>{
 const f=await fixture();try{
 await(await f.wrapped.mint(f.executor.target,parseEther('3'))).wait();await(await f.asset.mint(f.executor.target,parseEther('4'))).wait();const before=await f.wrapped.balanceOf(f.lender.target);
 await(await f.executor.startArb(f.trade)).wait();assert.equal(await f.executor.tradesExecuted(),1n);assert.equal(await f.wrapped.balanceOf(f.executor.target),parseEther('3'));assert.equal(await f.asset.balanceOf(f.executor.target),parseEther('4'));
 assert.equal(await f.wrapped.balanceOf(f.lender.target),before+(parseEther('1')*10000n+9974n)/9975n-parseEther('1'));
 assert.ok(await f.executor.totalProfit()>0n);assert.ok(await f.executor.totalDevFees()>0n);assert.equal(await f.wrapped.allowance(f.executor.target,f.buy.target),0n);assert.equal(await f.asset.allowance(f.executor.target,f.sell.target),0n);
 }finally{await f.close();}
});
test('unauthorized callback, non-owner execution and lending-pair swap lock are rejected',async()=>{
 const f=await fixture();try{
 await assert.rejects(f.executor.connect(f.other).startArb.staticCall(f.trade));
 await assert.rejects(f.executor.pancakeCall.staticCall(f.owner.address,1,0,'0x'));
 await assert.rejects(f.executor.startArb.staticCall({...f.trade,loanPair:f.tradePair.target}));
 await assert.rejects(f.executor.connect(f.other).setRouter.staticCall(f.buy.target,false));
 }finally{await f.close();}
});
test('losing routes revert without consuming donated balances; revoked routers cannot execute',async()=>{
 const f=await fixture();try{
 await(await f.wrapped.mint(f.executor.target,parseEther('3'))).wait();await(await f.sell.rate(9,20000)).wait();await assert.rejects(f.executor.startArb.staticCall({...f.trade,minWbnbOut:1n}));assert.equal(await f.wrapped.balanceOf(f.executor.target),parseEther('3'));
 await(await f.executor.setRouter(f.buy.target,false)).wait();await assert.rejects(f.executor.startArb.staticCall(f.trade));
 }finally{await f.close();}
});
