import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEvaluationPlan, digest } from '../src/eval-plan.ts';
const manifest = { models: ['B','A'], tasks: [{id:'case01',caseSha256:digest('case-v1')}], repeats:2, seed:'pilot',provider:'offline',routingGroup:'fixture',systemPrompt:'Fix only the stated behavior.',tools:['edit','read'],harnessRevision:'a'.repeat(40),timeLimitSec:60,maxOutputTokens:2048,temperature:0.1,maxIterations:8,maxCostMicros:25000 };
test('stable, interleaved, bounded schedule; changing policy or case invalidates plan', () => {
  const a = makeEvaluationPlan(manifest);
  assert.deepEqual(a,makeEvaluationPlan({...manifest,models:['A','B'],tools:['read','edit']}));
  assert.equal(a.attempts.length,4); assert.equal(a.ceilingMicros,100000);
  assert.notEqual(a.attempts[0].model,a.attempts[2].model);
  assert.notEqual(a.planSha256,makeEvaluationPlan({...manifest,systemPrompt:'Different'}).planSha256);
  assert.throws(()=>makeEvaluationPlan({...manifest,repeats:1}));
  assert.throws(()=>makeEvaluationPlan({...manifest,maxCostMicros:Number.MAX_SAFE_INTEGER}));
});
test('report binds ledger to full planned matrix and explicitly identifies simulation', async t => {
  const cli=fileURLToPath(new URL('../scripts/model-eval.mjs',import.meta.url));
  const dir=await mkdtemp(path.join(tmpdir(),'jevio-eval-plan-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const conf=path.join(dir,'manifest.json'), ledger=path.join(dir,'ledger.json');
  await writeFile(conf,JSON.stringify(manifest)); const plan=JSON.parse(execFileSync(process.execPath,[cli,'plan',conf],{encoding:'utf8'}));
  const data={schema:'jevio-eval-ledger/v1',source:'simulation',currency:'USD',planSha256:plan.planSha256,rows:plan.attempts.map(a=>({...a,verified:false,regression:false,accepted:null,costMicros:null,durationMs:10}))};
  const report=()=>spawnSync(process.execPath,[cli,'report',conf,ledger],{encoding:'utf8'});
  await writeFile(ledger,JSON.stringify(data)); const ok=report(); assert.equal(ok.status,0,ok.stderr); assert.match(ok.stdout,/SIMULATED/);
  await writeFile(ledger,JSON.stringify({...data,rows:data.rows.slice(0,2)})); assert.notEqual(report().status,0);
  await writeFile(ledger,JSON.stringify({...data,planSha256:digest('wrong')})); assert.notEqual(report().status,0);
});
