// Exercise the historical npm command's argv, not a real second Node installation.
import { readFile } from 'node:fs/promises';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const mode=process.argv[2];
if (!['target','control'].includes(mode)) throw Error('Unknown check');
const flags=mode==='target'?['--experimental-test-isolation']:['--test-isolation','--experimental-test-isolation'];
const manifest=JSON.parse(await readFile('package.json','utf8'));
const [node,first,...tail]=manifest.scripts.test.split(' ');
if(node!=='node')throw Error('Unexpected executable');
let observed;
if(first==='--test')observed=[first,...tail];
else if(first==='scripts/run-tests.mjs') {
  Object.defineProperty(process,'allowedNodeEnvironmentFlags',{value:new Set(flags)});
  process.argv=[process.execPath,resolve(first),...tail];
  child.spawnSync=(exe,args)=>{if(exe!==process.execPath||observed)throw Error('Unexpected invocation'); observed=args;return {status:0};};
  syncBuiltinESMExports(); await import(pathToFileURL(resolve(first)).href);
} else throw Error('Unknown test runner');
if(!Array.isArray(observed)||observed.length!==3||observed[0]!=='--test'||observed[2]!=='test/*.test.ts')throw Error('Unexpected invocation');
const option=observed[1];
if(!['--experimental-test-isolation=none','--test-isolation=none'].includes(option))throw Error('Unexpected isolation policy');
console.log(JSON.stringify(option===`${flags[0]}=none`?'PASS':'FAIL'));
