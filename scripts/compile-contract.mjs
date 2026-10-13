import solc from 'solc';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const source=await readFile('contracts/FlashArbitrageV2.sol','utf8');
const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'FlashArbitrageV2.sol':{content:source}},settings:{viaIR:true,optimizer:{enabled:true,runs:200},evmVersion:'paris',metadata:{bytecodeHash:'none'},outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}}})));
const errors=(output.errors||[]).filter(e=>e.severity==='error');if(errors.length)throw Error(errors.map(e=>e.formattedMessage).join('\n'));
const c=output.contracts['FlashArbitrageV2.sol'].FlashArbitrageV2;await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/FlashArbitrageV2.json',JSON.stringify({compiler:solc.version(),abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,runtime:'0x'+c.evm.deployedBytecode.object,immutableReferences:c.evm.deployedBytecode.immutableReferences},null,2));
console.log('Compiled FlashArbitrageV2; runtime bytes:',c.evm.deployedBytecode.object.length/2);
