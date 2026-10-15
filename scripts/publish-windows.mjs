import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const {version}=JSON.parse(await readFile('package.json','utf8'));
const repo=process.env.GH_REPO,token=process.env.GH_TOKEN,source=process.env.GITHUB_SHA;
assert(repo==='kobyfletcher08-ops/vigilant-engine'&&token&&/^[a-f0-9]{40}$/.test(source||''),'Release requires the repository Actions context.');
assert(/^\d+\.\d+\.\d+$/.test(version),'Invalid release version.');
const tag='v'+version;
async function api(path,options={}){
  const url=new URL(path,'https://api.github.com/');
  assert(['api.github.com','uploads.github.com'].includes(url.hostname),'Unexpected GitHub API host.');
  const response=await fetch(url,{...options,headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',...options.headers}});
  if(!response.ok)throw Error(`GitHub ${response.status}: ${(await response.text()).slice(0,500)}`);
  return response.json();
}
const root=`repos/${repo}`;
const files=[];
for(const extension of ['exe','zip']){
  const name=`VigilantEngine-${version}-Windows-x64.${extension}`,data=await readFile('release/'+name);
  assert(data.length>80_000_000,`Missing or truncated download: ${name}`);
  assert(extension==='exe'?data.subarray(0,2).toString()==='MZ':data.subarray(0,2).toString()==='PK',`Unexpected download format: ${name}`);
  files.push({name,data,size:data.length,digest:'sha256:'+createHash('sha256').update(data).digest('hex')});
}
const body=`Fixes the desktop **Origin required / Unexpected token O** failure when loading markets, scanning pairs or calling Solana execution APIs.

- Accepts requests using Electron's trusted Chromium initiator when the optional Origin header is absent; rejects foreign or opaque initiators.
- Returns JSON errors and readable HTTP failures instead of JSON parsing exceptions.
- Windows startup verification now sends real POST requests from the renderer to all three APIs, without Origin or Referer headers supplied by the test.

**Choose one download:** EXE for the portable app, or extract the ZIP and run \`VigilantEngine.exe\`. Both include the local backend, runtime and interface for Solana, BSC and Arbitrum One.

When updating the portable EXE, keep the existing adjacent \`VigilantEngine-Data\` folder to retain settings and encrypted wallets. No separate Node installation or hosting is required.

Windows 10/11 x64. Unsigned build. Funded trades remain untested; blockchain confirmation time varies. Supported execution routes and the existing EVM developer profit fee are unchanged.

Source: ${source}`;
const releases=await api(root+'/releases?per_page=100');
const matching=releases.filter(r=>r.tag_name===tag);
assert(matching.length<=1,'Ambiguous release tag.');
let release=matching[0]||await api(root+'/releases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tag_name:tag,target_commitish:source,name:`Vigilant Engine ${version} — Windows origin fix`,body,draft:true,prerelease:false})});
assert(release.target_commitish===source,'Existing release targets a different source; refusing to change it.');
for(const file of files){
  const existing=release.assets.find(a=>a.name===file.name);
  if(existing){
    assert(existing.state==='uploaded'&&existing.size===file.size&&existing.digest===file.digest,'Existing asset differs; refusing to overwrite it.');
    continue;
  }
  assert(release.draft,'Refusing to add assets to an existing published release.');
  const upload=release.upload_url.replace(/\{.*$/,'')+'?name='+encodeURIComponent(file.name);
  await api(upload,{method:'POST',headers:{'content-type':file.name.endsWith('.zip')?'application/zip':'application/octet-stream'},body:file.data});
}
release=await api(root+'/releases/'+release.id);
for(const file of files){
  const asset=release.assets.find(a=>a.name===file.name);
  assert(asset?.state==='uploaded'&&asset.size===file.size&&asset.digest===file.digest,`Upload verification failed: ${file.name}`);
}
if(release.draft)release=await api(root+'/releases/'+release.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({draft:false,make_latest:'true'})});
assert(!release.draft,'Release was not published.');
console.log('Published',release.html_url);
for(const asset of release.assets)console.log(asset.name,asset.size,asset.digest,asset.browser_download_url);
