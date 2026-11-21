import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import intent from '../benchmark/evaluation/task-intent-questions/case.mjs';
import parser from '../benchmark/evaluation/text-tool-line-continuation/case.mjs';

import picker from '../benchmark/evaluation/session-picker-focus/case.mjs';

import loader from '../benchmark/evaluation/idle-loader-status/case.mjs';

// Select only the historical constructor statement and the two lifecycle methods.
// Never evaluate this text here. The full fixture imports Node and pi-tui; the packet must not.
export function loaderLifecycleExcerpt(fullFixtureSource) {
  function between(start,end) {
    const a=fullFixtureSource.indexOf(start), b=fullFixtureSource.indexOf(end,a+start.length);
    if(a===-1 || b===-1 || fullFixtureSource.indexOf(start,a+start.length)!==-1) throw Error('Unrecognized loader fixture layout');
    return fullFixtureSource.slice(a,b);
  }
  const init=between('    this.loader = new Loader(', '\n');
  return `constructor() {\n${init}\n}\n${between('  async run():', '\n  setTodos(')}\n${between('  private async handleSubmit(', '\n  private async showSessionPicker(')}\n`;
}
import kimi from '../benchmark/evaluation/kimi-temperature/case.mjs';
const catalog = new Map([intent, parser, picker, loader, kimi].map(spec => [spec.id, spec]));
export const runnableCaseIds = Object.freeze([...catalog.keys()]);
const worker = fileURLToPath(new URL('./eval-intent-worker.mjs', import.meta.url));
const digest = s => createHash('sha256').update(s).digest('hex');
function lookup(id) {
  const spec = catalog.get(id);
  if (!spec) throw Error('Unknown candidate verifier');
  return spec;
}
export async function modelInput(taskId = intent.id) {
  const spec = lookup(taskId);
  const [name, fixture, expected] = spec.files.base[0];
  const bytes = await readFile(new URL(`../benchmark/evaluation/${spec.id}/${fixture}`, import.meta.url));
  if (digest(bytes) !== expected) throw Error('Base snapshot digest mismatch');
  if (taskId === loader.id) return {task:spec.task+' Return the replacement class members only: constructor, run and handleSubmit.',files:{'src/loader-lifecycle.ts':loaderLifecycleExcerpt(bytes.toString('utf8'))}};
  return { task:spec.task, files:{[name]:bytes.toString('utf8')} };
}
const intentChecks = [ ['target', 'How does the app build the navigation menu?',false], ['control','Build the navigation menu.',true] ];
function parserChecks() {
  return [['target','\\\n','LF'], ['target','\\\r\n','CRLF'], ['control','','clean']].map(([kind, wrap, label]) => {
    const args = { query:`red  blue ${label}`, note:'quoted "text" and a literal backslash: \\test' };
    const json = JSON.stringify({jevio_tool_calls:[{name:'lookup', arguments:args}]}).replace('red  blue',`red${wrap}  blue`);
    return [kind, ['```json', json, '```'].join('\n'), args];
  });
}
function compareParser(observed, expected) {
  if (observed === 'count-mismatch') return 'FAIL';
  if (typeof observed !== 'string' || !observed.startsWith('6:lookup')) return observed === null ? 'INVALID' : 'FAIL';
  try { return isDeepStrictEqual(JSON.parse(observed.slice(8)), expected) ? 'PASS' : 'FAIL'; }
  catch { return 'INVALID'; }
}
const kimiChecks = [['target','moonshot/Kimi-K2.7',[1,1,1]], ['target','alias/KiMi-preview',[1,1,1]],
  ['control','qwen3-coder',[0,0.15,0.2]], ['control','kimiko-instruct',[0,0.15,0.2]]];
function compareWire(observed, model, temps) {
  if (typeof observed!=='string') return 'INVALID';
  try {
    const [requests,replies,count]=JSON.parse(observed);
    if(count!==3 || !isDeepStrictEqual(replies,['OK','OK','OK']) || requests.length!==3) return 'FAIL';
    for(let i=0;i<3;i++) {
      const [url,method,type,body]=requests[i];
      if(url!=='https://provider.invalid/chat/completions'||method!=='POST'||type!=='application/json'||
         !isDeepStrictEqual(JSON.parse(body),{model,temperature:temps[i],messages:[{role:'user',content:`wire-${i}`}],stream:false})) return 'FAIL';
    }
    return 'PASS';
  } catch { return 'INVALID'; }
}
export function verifySource(source, taskId = intent.id) {
  const spec = lookup(taskId);
  if (typeof source !== 'string' || !source.length || Buffer.byteLength(source)>32*1024) throw Error('Expected one replacement source file (1–32768 bytes)');
  const observations = {};
  const isParser = spec.id === parser.id;
  const pickerChecks = [['target','populated','1|1|1|0|1|0|session-1||'], ['control','empty','0|0|0|0|1|1||fuse|No saved sessions in this workspace.']];
  const loaderChecks = [['target','idle','RE0S|RE0S'], ['control','busy','WT1A']];
  for (const [kind,input,expected] of spec.id===kimi.id ? kimiChecks : spec.id===loader.id ? loaderChecks : isParser ? parserChecks() : spec.id === picker.id ? pickerChecks : intentChecks) {
    const r = spawnSync(process.execPath,['--max-old-space-size=64',worker], {input:JSON.stringify({source,input,taskId}),encoding:'utf8',timeout:5000,killSignal:'SIGKILL',maxBuffer:32768,windowsHide:true,env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{} });
    if (r.error || r.status !== 0) throw Error('Verifier worker failed or timed out; no behavioral verdict');
    const {observed} = JSON.parse(r.stdout);
    const verdict = spec.id===kimi.id ? compareWire(observed,input,expected) : isParser ? compareParser(observed,expected) : observed === null ? 'INVALID' : observed === expected ? 'PASS' : 'FAIL';
    const prior = observations[kind];
    observations[kind] = [prior,verdict].includes('INVALID') ? 'INVALID' : [prior,verdict].includes('FAIL') ? 'FAIL' : 'PASS';
  }
  return {taskId:spec.id,candidateSha256:digest(source),checks:observations,verified: Object.values(observations).every(v=>v==='PASS')};
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [cmd,first,second,...extra] = process.argv.slice(2);
    if (cmd==='input' && second===undefined) console.log(JSON.stringify(await modelInput(first),null,2));
    else if(cmd==='verify' && first && !extra.length) {
      const info = await stat(first);
      if (!info.isFile() || info.size>32768) throw Error('Invalid candidate file');
      const report = verifySource(await readFile(first,'utf8'),second); console.log(JSON.stringify(report,null,2)); if(!report.verified) process.exitCode=1;
    } else throw Error('Usage: eval-candidate.mjs input [TASK_ID] | verify FILE [TASK_ID]');
  } catch(e) {console.error(e.message);process.exitCode=2;}
}
