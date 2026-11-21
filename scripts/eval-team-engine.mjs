// Parent-only verdicts: no expected values, labels or other inputs enter a guest.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const worker=fileURLToPath(new URL('./eval-team-worker.mjs',import.meta.url));
const bounded=(value,limit)=>typeof value==='string'&&value.length<=limit&&Buffer.byteLength(value)<=limit;
const infra=()=>new Error('Team evaluation worker failed; no behavioral verdict');
export function evaluateFunction(source,entry,checks){
  if(!bounded(source,32768)||!source.trim()||typeof entry!=='string'||!/^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$/.test(entry))throw Error('Invalid team function configuration');
  if(!Array.isArray(checks)||checks.length>64||!checks.some(c=>c?.kind==='target')||!checks.some(c=>c?.kind==='control'))throw Error('Invalid team checks');
  for(const c of checks)if(!c||!['target','control'].includes(c.kind)||!bounded(c.input,4096)||!(typeof c.expected==='boolean'||bounded(c.expected,4096)))throw Error('Invalid team check');
  const summary={target:'PASS',control:'PASS'}, results=[];
  for(const {kind,input,expected} of checks){
    const r=spawnSync(process.execPath,['--max-old-space-size=64',worker],{input:JSON.stringify({source,entry,input}),encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:64*1024,windowsHide:true,env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}});
    if(r.error||r.status!==0)throw infra();
    let observed;
    try { observed=JSON.parse(r.stdout); } catch {throw infra();}
    if(observed!==null&&typeof observed!=='boolean'&&!bounded(observed,4096))throw infra();
    const verdict=observed===null?'INVALID':observed===expected?'PASS':'FAIL';
    results.push(verdict);
    if(verdict==='INVALID'||(summary[kind]==='PASS'&&verdict==='FAIL'))summary[kind]=verdict;
  }
  return {checks:summary,verified:summary.target==='PASS'&&summary.control==='PASS',results};
}
