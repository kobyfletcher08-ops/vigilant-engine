'use strict';
const {app,BrowserWindow,session,Menu,shell,dialog} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const {APP_ORIGIN,isLocal,trustedApiRequest,safeExternal,safeAsset} = require('./policy.cjs');
const failure = (error,status) => Response.json({error},{status,headers:{'cache-control':'no-store'}});
const smoke = process.argv.includes('--smoke-desktop');
const dataDirectory=smoke?path.join(require('node:os').tmpdir(),'vigilant-smoke-'+process.pid):process.env.PORTABLE_EXECUTABLE_DIR?path.join(process.env.PORTABLE_EXECUTABLE_DIR,'VigilantEngine-Data'):null;
if(dataDirectory){require('node:fs').mkdirSync(dataDirectory,{recursive:true});app.setPath('userData',dataDirectory);}
let window,backend;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
  app.whenReady().then(async()=>{
    backend = require('./backend.cjs');
    const browser = session.fromPartition('persist:vigilant-desktop');
    browser.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    browser.setPermissionCheckHandler(()=>false);
    const contentPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'self'";
    browser.protocol.handle('https',async request=>{
      if (!isLocal(request.url) || request.initiatorOrigin !== undefined && request.initiatorOrigin !== APP_ORIGIN) return failure('Blocked request origin.',403);
      const origin = request.headers.get('origin');
      if (origin !== null && origin !== APP_ORIGIN) return failure('Blocked request origin.',403);
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        if (!trustedApiRequest(request)) return failure('Invalid desktop request origin.',403);
        if (request.method !== 'POST' && request.method !== 'GET') return failure('Method not allowed.',405);
        const headers = new Headers(request.headers); headers.set('origin',APP_ORIGIN);
        let body;
        if (request.method === 'POST') { body = await request.text(); if (body.length > 64000) return failure('Request too large.',413); }
        return backend.dispatch(new Request(request.url,{method:request.method,headers,body}));
      }
      if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
      const full = safeAsset(path.join(__dirname,'client'),url.pathname);
      if (!full) return new Response('Invalid path',{status:400});
      const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.zip':'application/zip','.woff2':'font/woff2'};
      try {
        const data = await fs.readFile(full);
        return new Response(request.method==='HEAD'?null:data,{headers:{'content-type':types[path.extname(full)]||'application/octet-stream','content-security-policy':contentPolicy,'x-content-type-options':'nosniff','cache-control':url.pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-store'}});
      } catch { return new Response('Not found',{status:404}); }
    });
    browser.on('will-download',(_event,item)=>item.setSaveDialogOptions({defaultPath:item.getFilename()}));
    window = new BrowserWindow({title:'Vigilant Engine',width:1440,height:960,minWidth:880,minHeight:640,backgroundColor:'#10161e',show:false,webPreferences:{session:browser,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
    window.webContents.setWindowOpenHandler(({url})=>{if(safeExternal(url))void shell.openExternal(url);return {action:'deny'};});
    window.webContents.on('will-navigate',(event,url)=>{if(!isLocal(url)){event.preventDefault();if(safeExternal(url))void shell.openExternal(url);}});
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'App',submenu:[{role:'reload'},{role:'togglefullscreen'},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));
    await window.loadURL(APP_ORIGIN+'/');
    if (!smoke) window.show();
    else {
      const report = await window.webContents.executeJavaScript(`(async()=>{
        await new Promise(r=>setTimeout(r,2500));
        const health=await fetch('/api/desktop/health').then(r=>r.json()),posts=[];
        for(const route of ['arb','markets','solana']){
          const response=await fetch('/api/'+route,{method:'POST',referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},body:'{}'});
          const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
          posts.push({route,status:response.status,error:data?.error||text.slice(0,100)});
        }
        return {ui:document.querySelector('main')!==null&&document.querySelectorAll('button').length>10,health:health.runtime,secure:window.isSecureContext,isolated:typeof window.require==='undefined',posts};
      })()`);
      console.log('DESKTOP_SMOKE_REPORT '+JSON.stringify(report));
      const ok=report.ui&&report.health==='local-desktop'&&report.secure&&report.isolated&&report.posts.length===3&&report.posts.every(p=>p.status===400&&typeof p.error==='string'&&p.error.length>0);
      console.log('DESKTOP_SMOKE '+(ok?'PASS':'FAIL')); app.exit(ok?0:1);
    }
  }).catch(error=>{console.error('Desktop startup failed:',error.message);if(!smoke)dialog.showErrorBox('Vigilant Engine could not start','The local application failed to start. Download a fresh copy of the Windows package.');app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',()=>{if(backend)void backend.closeTransport();});
}
