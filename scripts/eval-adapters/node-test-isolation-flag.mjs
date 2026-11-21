import { createHash } from 'node:crypto';

const pkg = 'package.json', runner = 'scripts/run-tests.mjs';
function project(main,edition,files) {
  const bundle = {[pkg]:main};
  if (edition === 'gold') {
    const extra = files instanceof Map ? files.get(runner) : files?.[runner];
    if (typeof extra !== 'string') throw Error('Missing pinned runner fixture');
    bundle[runner] = extra;
  } else if (edition !== 'base') throw Error('Unknown test runner fixture edition');
  return JSON.stringify(bundle,null,2);
}
// Require preservation of manifest metadata outside the two test commands (order and whitespace do not matter).
// Hash of the common base/gold manifest after removing those two fields, then canonicalizing object keys.
const metadataSha = 'c51eca44c701068b1ba18bf8e35f425ea68bcc67d41793032ee0fb3d596cb675';
const canonical = o => Array.isArray(o) ? o.map(canonical) : o && typeof o === 'object'
  ? Object.fromEntries(Object.keys(o).sort().map(k=>[k,canonical(o[k])])) : o;
function wrap(source) {
  // Never import, run or write the supplied runner here. Encode it as inert JSON in the guest module.
  const files = JSON.parse(source);
  if (!files || typeof files!=='object' || Array.isArray(files) || typeof files[pkg]!=='string' ||
      Object.keys(files).some(k=>k!==pkg && k!==runner) || (Object.hasOwn(files,runner) && typeof files[runner]!=='string')) throw Error('Invalid runner bundle');
  const manifest=JSON.parse(files[pkg]);
  const commands={test:manifest?.scripts?.test,cloud:manifest?.scripts?.['test:cloud']};
  for (const cmd of Object.values(commands)) if(typeof cmd!=='string'||cmd.length>300||!/^[\w./*= -]+$/.test(cmd))throw Error('Only simple Node argv commands supported');
  delete manifest.scripts.test; delete manifest.scripts['test:cloud'];
  if(createHash('sha256').update(JSON.stringify(canonical(manifest))).digest('hex')!==metadataSha) throw Error('Unrelated manifest fields changed');
  const text = files[runner];
  // No module loader. The single supported Node import is bound to a guest-only stub below.
  const imp=/^\s*import\s*\{\s*spawnSync(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\s*from\s*(['"])node:child_process\2\s*;?/m;
  const found=text?.match(imp);
  if(text!==undefined&&!found)throw Error('Runner must import spawnSync');
  const program=text===undefined?null:{binding:found?.[1]??'spawnSync',source:text.replace(imp,'')};
  return `export const bundle = ${JSON.stringify({commands,program})};`;
}
// Dynamic compilation here is QuickJS-only. Never expose a real process, subprocess or shell.
const adapter = `((parse,Fn,isArray) => async (bundle,input) => {
  const [script,stable,exit,...extra]=parse(input);
  const cmd=bundle.commands[script].trim().split(/ +/);
  const [node,first,...tail]=cmd;
  if(node!=='node')return null;
  const app='/runtime/node'; let seen=0, wire='';
  function spawn(exe,args,opts){
    seen++;
    if(exe!==app||!isArray(args)||args.length>12||typeof opts?.shell==='string'||opts?.shell===true)throw Error('Invalid spawn');
    for(let i=0;i<args.length;i++){const s=args[i];if(typeof s!=='string'||s.length>128)throw Error('Invalid argv');wire+=s.length+':'+s;}
    return {status:exit,signal:null,error:undefined};
  }
  let status;
  if(first==='--test'){ spawn(app,[first,...tail,...extra]);status=exit; }
  else if(first==='scripts/run-tests.mjs'&&bundle.program){
    const flags=['--experimental-test-isolation']; if(stable)flags.push('--test-isolation');
    const process={execPath:app,argv:[app,first,...tail,...extra],allowedNodeEnvironmentFlags:new Set(flags),exitCode:0};
    Fn('process',bundle.program.binding,'"use strict";\\n'+bundle.program.source)(process,spawn);
    status=process.exitCode;
  } else return null;
  if(!Number.isInteger(status)||status<0||status>255)return null;
  return seen+';'+status+';'+wire;
})(JSON.parse,Function,Array.isArray)`;
const checks=[];
for (const stable of [false,true]) for(const [script,file] of [['test','test/*.test.ts'],['cloud','test/cloud-memory.integration.ts']]) for(const exit of [0,3]) {
  const extra=['test/forwarded.test.ts'];
  const argv=['--test',(stable?'--test-isolation':'--experimental-test-isolation')+'=none',file,...extra];
  checks.push([stable?'control':'target',JSON.stringify([script,stable,exit,...extra]),'1;'+exit+';'+argv.map(s=>s.length+':'+s).join('')]);
}
export default {id:'node-test-isolation-flag',path:'src/test-runner-bundle.json',entry:'bundle',project,wrap,adapter,checks,
  promptSuffix:' Return only a JSON object mapping package.json and optionally scripts/run-tests.mjs to their complete UTF-8 source strings. Preserve manifest fields outside scripts.test and scripts["test:cloud"]. Use simple node commands, no shell syntax; a runner may import { spawnSync } from "node:child_process". Keep paths, forwarded arguments and child exit codes for both test commands. The runner runs in a guest with simulated Node flag capabilities, not on the host.',
  judge:(observed,expected)=>typeof observed!=='string'?'INVALID':observed===expected?'PASS':'FAIL'};
