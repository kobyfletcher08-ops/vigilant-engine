import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url),{APP_ORIGIN,isLocal,trustedApiRequest,safeExternal,safeAsset}=require('../desktop/policy.cjs');
test('desktop POST trusts the Chromium initiator even without Origin or Referer headers',()=>{
  const request=Object.assign(new Request(APP_ORIGIN+'/api/arb',{method:'POST',body:'{}'}),{initiatorOrigin:APP_ORIGIN});
  assert.equal(request.headers.has('origin'),false);
  assert.equal(request.headers.has('referer'),false);
  assert.equal(trustedApiRequest(request),true);
});
test('desktop API rejects absent, opaque and foreign initiators, including spoofed headers',()=>{
  for(const initiatorOrigin of [undefined,'null','https://evil.example','https://vigilant.local.evil.example']){
    const request=Object.assign(new Request(APP_ORIGIN+'/api/arb',{method:'POST',headers:{origin:APP_ORIGIN,referer:APP_ORIGIN+'/settings'}}),{initiatorOrigin});
    assert.equal(trustedApiRequest(request),false);
  }
  for(const origin of ['','null','https://evil.example']){
    const request=Object.assign(new Request(APP_ORIGIN+'/api/markets',{headers:{origin}}),{initiatorOrigin:APP_ORIGIN});
    assert.equal(trustedApiRequest(request),false);
  }
  assert.equal(trustedApiRequest(Object.assign(new Request('https://evil.example/api/arb'),{initiatorOrigin:APP_ORIGIN})),false);
});
test('desktop origin, external links and file boundaries reject spoofed origins and traversal',()=>{
  assert.equal(isLocal('https://vigilant.local/api/arb'),true);
  for(const url of ['https://vigilant.local.evil.example/','http://vigilant.local/','https://evil.example/'])assert.equal(isLocal(url),false);
  assert.equal(safeExternal('https://bscscan.com/tx/0x123'),true);
  for(const url of ['file:///C:/Windows','javascript:alert(1)','https://evil.example','https://user:pass@github.com'])assert.equal(safeExternal(url),false);
  const root=resolve('desktop-package/client');assert.equal(safeAsset(root,'/'),resolve(root,'index.html'));
  for(const path of ['/../secret','/%2e%2e/secret','/assets/..%5c..%5csecret','/%00'])assert.equal(safeAsset(root,path),null);
});
