import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url),{isLocal,safeExternal,safeAsset}=require('../desktop/policy.cjs');
test('desktop origin, external links and file boundaries reject spoofed origins and traversal',()=>{
  assert.equal(isLocal('https://vigilant.local/api/arb'),true);
  for(const url of ['https://vigilant.local.evil.example/','http://vigilant.local/','https://evil.example/'])assert.equal(isLocal(url),false);
  assert.equal(safeExternal('https://bscscan.com/tx/0x123'),true);
  for(const url of ['file:///C:/Windows','javascript:alert(1)','https://evil.example','https://user:pass@github.com'])assert.equal(safeExternal(url),false);
  const root=resolve('desktop-package/client');assert.equal(safeAsset(root,'/'),resolve(root,'index.html'));
  for(const path of ['/../secret','/%2e%2e/secret','/assets/..%5c..%5csecret','/%00'])assert.equal(safeAsset(root,path),null);
});
