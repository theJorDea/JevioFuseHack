// Offline API rehearsal. The transport is constructed here, never read from env or the network.
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelInput, verifySource, runnableCaseIds, loaderLifecycleExcerpt } from './eval-candidate.mjs';
import { makeEvaluationPlan, digest } from '../src/eval-plan.ts';
import { runAttempt } from './eval-attempt.mjs';
import { reviewArtifacts } from '../src/eval-review.ts';
import { formatEvaluation } from '../src/eval-report.ts';
import { qualifyCase } from './eval-qualify.mjs';

export async function rehearse(out) {
  const inputs = new Map();
  for (const id of runnableCaseIds) {
    const task = await qualifyCase(id);
    if (!task.qualified) throw Error('Historical case did not qualify');
    const {default:spec} = await import(`../benchmark/evaluation/${id}/case.mjs`);
    const gold = await readFile(new URL(`../benchmark/evaluation/${id}/${spec.files.gold[0][1]}`,import.meta.url),'utf8');
    if(digest(gold)!==spec.files.gold[0][2]) throw Error('Gold source mismatch');
    inputs.set(id,{task,packet:await modelInput(id),gold:id==='idle-loader-status'?loaderLifecycleExcerpt(gold):gold});
  }
  const tasks = [...inputs.values()].map(({task})=>({id:task.taskId,caseSha256:task.caseSha256}));
  const packetHashes = Object.fromEntries([...inputs].map(([id,{packet}])=>[id,digest(JSON.stringify(packet))]));
  const root = fileURLToPath(new URL('../',import.meta.url));
  const revision = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const manifest = {models:['mock-a','mock-b'],tasks,repeats:2,provider:'offline',routingGroup:'simulation',systemPrompt:'Return only the entire replacement TypeScript source. Do not include Markdown.',harnessRevision:revision,tools:[],timeLimitSec:10,maxOutputTokens:4096,temperature:0,maxIterations:1,maxCostMicros:50000,seed:'rehearsal'};
  const plan = makeEvaluationPlan(manifest);
  await mkdir(out); // Exclusive directory: never mix two runs or silently replace evidence.
  const put = (name,value) => writeFile(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  await put('manifest.json',manifest); await put('plan.json',plan);
  // HEAD alone cannot identify an unpublished/dirty runtime. Pin the bytes actually exercised.
  const components = ['scripts/eval-rehearse.mjs','scripts/eval-attempt.mjs','scripts/eval-candidate.mjs','scripts/eval-intent-worker.mjs','scripts/eval-qualify.mjs','src/eval-plan.ts','src/eval-report.ts','src/eval-billing.ts','package-lock.json'];
  const hashes = Object.fromEntries(await Promise.all(components.map(async file => [file,digest(await readFile(path.join(root,file)))])));
  await put('environment.json',{node:process.version,platform:process.platform,arch:process.arch,revision,hashes,packetHashes,tasks,planSha256:plan.planSha256});
  const rows=[]; const receipts=[]; const artifacts=new Map();
  for(const a of plan.attempts){
    const {packet,gold} = inputs.get(a.task);
    const id=`sim-${a.task}-${a.model}-${a.repeat}`;
    const fetchImpl = async (_url,init) => {
      const request=JSON.parse(init.body); if(request.model!==a.model) throw Error('Unexpected model');
      const headers={'x-request-id':id};
      if(a.model==='mock-b' && a.repeat===2) return Response.json({error:{message:'simulated outage'}},{status:503,headers});
      const wrong = a.task==='kimi-temperature' ? gold.replace('return requested ?? role.temperature ?? 0.2;', 'return 1;') : a.task==='idle-loader-status' ? 'constructor(){} async run(){} async handleSubmit(){}' : a.task==='task-intent-questions' ? 'export function isImplementationRequest(){return false}' : a.task==='session-picker-focus' ? 'async showSessionPicker(){}' : 'export function parseFallbackToolCalls(){return []}';
      const content=a.repeat===2?Object.values(packet.files)[0]:a.model==='mock-a'?gold:wrong;
      return Response.json({id,model:a.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}]}, {headers});
    };
    const row=await runAttempt({task:a.task,model:a.model,repeat:a.repeat,packet,systemPrompt:manifest.systemPrompt,temperature:manifest.temperature,maxOutputTokens:manifest.maxOutputTokens,timeoutMs:10000,fetchImpl,verify:source=>{const r=verifySource(source,a.task);if(r.verified)artifacts.set(r.candidateSha256,source);return r;}});
    row.planSha256=plan.planSha256;
    rows.push(row); await appendFile(path.join(out,'attempts.jsonl'),JSON.stringify(row)+'\n');
    // Intentionally leave one charge unknown. These are artificial receipts, not list prices.
    if(a.model==='mock-a') receipts.push({requestId:id,model:a.model,currency:'USD',costMicros:1000});
  }
  const ledger={schema:'jevio-eval-ledger/v1',planSha256:plan.planSha256,currency:'USD',source:'simulation',rows};
  await put('ledger.json',ledger); await put('blind-review.json',reviewArtifacts(ledger,artifacts)); await put('synthetic-receipts.json',receipts);
  await writeFile(path.join(out,'report.md'),'SIMULATION ONLY — no paid requests. Costs are unknown before reconciliation.\n\n'+formatEvaluation(rows),{flag:'wx'});
  return {attempts:rows.length,verified:rows.filter(r=>r.verified).length,planSha256:plan.planSha256,packetHashes};
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.length!==3){console.error('Usage: npm run eval:rehearse -- NEW_OUTPUT_DIRECTORY');process.exitCode=2;}
  else try{console.log(JSON.stringify(await rehearse(process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
