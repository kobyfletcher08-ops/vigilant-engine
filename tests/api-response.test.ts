import test from 'node:test';
import assert from 'node:assert/strict';
import {apiResult} from '../lib/api-response.ts';
test('API errors remain readable when a server returns plain text or HTML',async()=>{
  await assert.rejects(apiResult(new Response('Origin required',{status:403}),'Market request failed.'),/Market request failed.*HTTP 403/);
  await assert.rejects(apiResult(new Response('<html>Bad gateway</html>',{status:502})),/HTTP 502/);
  await assert.rejects(apiResult(Response.json({error:'Invalid desktop request origin.'},{status:403})),/Invalid desktop request origin/);
});
test('API results preserve values and reject malformed successful responses',async()=>{
  assert.deepEqual(await apiResult(Response.json({result:{slot:123}})),{slot:123});
  await assert.rejects(apiResult(Response.json({})),/Invalid server response/);
  await assert.rejects(apiResult(new Response('not JSON')),/invalid server response/);
});
