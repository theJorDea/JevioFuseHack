// Local-only rehearsal. No transport, credentials, model routing, or billing client.
import {mkdir,open,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {digest,makeEvaluationPlan} from '../src/eval-plan.ts';
import {reviewArtifacts} from '../src/eval-review.ts';
import {formatEvaluation} from '../src/eval-report.ts';
import {loadTeamCase} from './eval-team-case.mjs';
import {evaluateFunction} from './eval-team-engine.mjs';

const usage='Usage: node scripts/eval-team-rehearse.mjs NEW_DIR CASE.json [CASE2.json ...] (1–10 distinct cases)';
const failure='Team rehearsal failed: check case qualification, worker, and fresh output directory.';
async function run(out,caseFiles){
  if(typeof out!=='string'||!out||!Array.isArray(caseFiles)||!caseFiles.length||caseFiles.length>10)throw Error();
  const cases=new Map();
  for(const file of caseFiles){
    const c=await loadTeamCase(file);
    const id=`case-${c.caseSha256}`;
    if(cases.has(id))throw Error();
    const base=evaluateFunction(c.baseSource,c.entry,c.checks),gold=evaluateFunction(c.goldSource,c.entry,c.checks);
    if(!c.checks.every(({kind},i)=>base.results[i]===(kind==='target'?'FAIL':'PASS')&&gold.results[i]==='PASS'))throw Error();
    cases.set(id,c);
  }
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  // Positive plan ceilings are schema placeholders, not incurred charges or approved budgets.
  const manifest={models:['mock-a','mock-b'],tasks:[...cases].map(([id,c])=>({id,caseSha256:c.caseSha256})),repeats:2,
    provider:'offline',routingGroup:'simulation',systemPrompt:'Local deterministic source injection only.',harnessRevision:revision,
    tools:[],timeLimitSec:60,maxIterations:1,maxCostMicros:1,maxOutputTokens:8192,temperature:0,seed:'team-rehearsal'};
  const plan=makeEvaluationPlan(manifest),{planSha256}=plan;
  await mkdir(out,{mode:0o700}); // Non-recursive/exclusive: never reuse or overwrite a run.
  const put=(name,text)=>writeFile(path.join(out,name),text,{flag:'wx',mode:0o600});
  const json=(name,data)=>put(name,JSON.stringify(data,null,2)+'\n');
  await json('manifest.json',manifest);await json('plan.json',plan);
  const rows=[],artifacts=new Map();
  const journal=await open(path.join(out,'attempts.jsonl'),'wx',0o600);
  try{
    for(const {task,model,repeat} of plan.attempts){
      const c=cases.get(task),source=repeat===1?c.goldSource:model==='mock-a'?c.baseSource:'export {';
      const start=performance.now();
      const {verified,checks}=evaluateFunction(source,c.entry,c.checks);
      const row={task,model,repeat,planSha256,candidateSha256:digest(source),verified,checks,
        status:verified?'verified':Object.values(checks).includes('INVALID')?'invalid':'not_verified',
        regression:checks.control==='INVALID'?null:checks.control==='FAIL',durationMs:Math.round(performance.now()-start),
        costMicros:null,accepted:null,requestId:null};
      await journal.writeFile(JSON.stringify(row)+'\n');rows.push(row);
      if(verified)artifacts.set(row.candidateSha256,source);
    }
  }finally{await journal.close();}
  const ledger={schema:'jevio-eval-ledger/v1',source:'simulation',currency:'USD',planSha256,rows};
  await json('ledger.json',ledger);
  const review=reviewArtifacts(ledger,artifacts);
  await json('blind-review.json',{private:true,notice:'PRIVATE: contains local source code. Do not publish.',...review,
    tasks:[...cases].map(([task,c])=>({task,description:c.task,entry:c.entry,baseSource:c.baseSource}))});
  await put('report.md','SIMULATION ONLY — deterministic sources, no model requests. Costs and human decisions are unknown. Durations measure local verification. Keep blind-review.json private.\n\n'+formatEvaluation(rows));
  return {attempts:rows.length,verified:rows.filter(r=>r.verified).length,planSha256};
}
export async function rehearseTeam(out,caseFiles){
  try{return await run(out,caseFiles);}catch{throw Error(failure);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{const [out,...files]=process.argv.slice(2);if(!out||files.length<1||files.length>10)throw Error(usage);
    console.log(JSON.stringify(await rehearseTeam(out,files),null,2));
  }catch(e){console.error(e.message===usage?usage:failure);process.exitCode=2;}
}
