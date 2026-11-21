// Pipe the exact demo manifest and ledger through the public plan/report CLI; never contact an API.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualifyDemo } from './eval-qualify.mjs';
import { digest } from '../src/eval-plan.ts';
const result = await qualifyDemo();
if (!result.qualified) throw Error('Control case failed qualification.');
const dir = await mkdtemp(path.join(tmpdir(),'jevio-eval-demo-'));
const cli = fileURLToPath(new URL('./model-eval.mjs',import.meta.url));
try {
  const manifest = {models:['sim-A','sim-B'],tasks:[{id:result.taskId,caseSha256:digest(JSON.stringify(result))}],repeats:2,provider:'offline',routingGroup:'simulation',systemPrompt:'Fix only the described behavior.',harnessRevision:'2b9e286a9dceb35c35026efd91cb9481c48739b9',tools:[],timeLimitSec:60,maxOutputTokens:2048,temperature:0.1,maxIterations:4,maxCostMicros:50000,seed:'demo'};
  const conf = path.join(dir,'manifest.json'), ledger=path.join(dir,'ledger.json');
  await writeFile(conf,JSON.stringify(manifest));
  const plan=JSON.parse(execFileSync(process.execPath,[cli,'plan',conf],{encoding:'utf8'}));
  const rows=plan.attempts.map(a=>({model:a.model,task:a.task,repeat:a.repeat,verified:a.repeat===1,regression:false,accepted:a.repeat===1?true:null,costMicros:a.model==='sim-A'?20000:30000,durationMs:1000}));
  await writeFile(ledger,JSON.stringify({schema:'jevio-eval-ledger/v1',source:'simulation',planSha256:plan.planSha256,currency:'USD',rows}));
  console.log('Trusted fixture qualification (observed):',JSON.stringify(result));
  execFileSync(process.execPath,[cli,'report',conf,ledger],{stdio:'inherit'});
} finally { await rm(dir,{recursive:true,force:true}); }
