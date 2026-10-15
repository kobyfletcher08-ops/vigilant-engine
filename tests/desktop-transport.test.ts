import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import type {Duplex} from 'node:stream';
import {desktopFetch,closeTransport} from '../desktop/transport.ts';
import {proxyUrl} from '../lib/proxy-config.ts';
test('proxy tuples preserve credential punctuation and reject non-proxy URLs',()=>{
  const url=new URL(proxyUrl('127.0.0.1:8123:login:p:a@ss'));
  assert.equal(decodeURIComponent(url.username),'login');assert.equal(decodeURIComponent(url.password),'p:a@ss');
  assert.equal(new URL(proxyUrl('https://proxy.example:8123:user:password')).protocol,'https:');
  for(const input of ['socks5://example:1080','host:70000:user:pass','https://host/path','https://host?key=x'])assert.throws(()=>proxyUrl(input));
});
test('authenticated CONNECT transport routes through the proxy and never sends its credentials upstream',async()=>{
  const target=createServer((req,res)=>{assert.equal(req.headers['proxy-authorization'],undefined);assert.equal(req.headers.authorization,undefined);res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));});
  const proxy=createServer(),sockets=new Set<Duplex>();let connects=0;
  proxy.on('connect',(req,client,head)=>{connects++;assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('login:p:a@ss').toString('base64'));const [host,port]=req.url!.split(':');const upstream=connect(Number(port),host,()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});sockets.add(client);sockets.add(upstream);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());});
  await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
  try {
    const targetPort=(target.address() as {port:number}).port,proxyPort=(proxy.address() as {port:number}).port;
    const request=desktopFetch(`127.0.0.1:${proxyPort}:login:p:a@ss`);
    for(let i=0;i<2;i++){const result=await request(`http://127.0.0.1:${targetPort}/`);assert.deepEqual(await result.json(),{ok:true});}
    assert.ok(connects>0);assert.equal(request,desktopFetch(`http://login:p%3Aa%40ss@127.0.0.1:${proxyPort}`));
  } finally {await closeTransport();for(const socket of sockets)socket.destroy();target.closeAllConnections();proxy.closeAllConnections();await Promise.all([new Promise<void>(r=>target.close(()=>r())),new Promise<void>(r=>proxy.close(()=>r()))]);}
});
