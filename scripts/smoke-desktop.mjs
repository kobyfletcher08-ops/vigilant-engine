import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{dispatch,closeTransport}=require('../desktop-package/backend.cjs');
const origin='https://vigilant.local';
try{
  const health=await dispatch(new Request(origin+'/api/desktop/health',{headers:{origin}}));
  assert.equal(health.status,200);assert.equal((await health.json()).runtime,'local-desktop');
  assert.equal((await dispatch(new Request(origin+'/api/desktop/health',{headers:{origin:'https://evil.example'}}))).status,403);
  for(const route of ['arb','solana','markets']){
    const response=await dispatch(new Request(origin+'/api/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}));
    assert.equal(response.status,400);assert.ok((await response.json()).error);
  }
  const html=await readFile('desktop-package/client/index.html','utf8');assert.ok(/\/assets\/.*\.js/.test(html));
  console.log('Desktop backend smoke checks passed: auth, all API routes, bundled frontend.');
}finally{await closeTransport();}
