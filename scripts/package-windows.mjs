import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
for(const args of [['scripts/build-desktop.mjs'],['scripts/smoke-desktop.mjs'],[require.resolve('electron-builder/cli.js'),'--projectDir','desktop-package','--config','../electron-builder.yml','--win','portable','zip','--x64']]){
  const result=spawnSync(process.execPath,args,{stdio:'inherit',env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'}});
  if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
}
