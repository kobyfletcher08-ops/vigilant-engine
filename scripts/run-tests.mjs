import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const files=(await readdir('tests')).filter(f=>f.endsWith('.test.ts')).sort().map(f=>'tests/'+f);
const result=spawnSync(process.execPath,['--experimental-strip-types','--test',...files],{stdio:'inherit'});
if(result.error)throw result.error;process.exit(result.status||0);
