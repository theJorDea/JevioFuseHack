import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {inspectJournal} from '../scripts/eval-recover.mjs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rehearse} from '../scripts/eval-rehearse.mjs';
import {summarizeEvaluation} from '../src/eval-report.ts';

test('rehearsal keeps failed attempts, persists evidence, and reconciles only individually identified charges',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'eval-rehearse-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const out=path.join(dir,'run');
  const summary=await rehearse(out);assert.equal(summary.verified,4);assert.equal(summary.attempts,16);
  const ledger=JSON.parse(await readFile(path.join(out,'ledger.json'),'utf8'));
  const journal=(await readFile(path.join(out,'attempts.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.deepEqual(journal,ledger.rows);
  assert.ok(ledger.rows.every(r=>r.costMicros===null&&r.accepted===null));assert.ok(ledger.rows.some(r=>r.status==='api_error'&&r.regression===null));
  const cli=fileURLToPath(new URL('../scripts/model-eval.mjs',import.meta.url));
  const joined=JSON.parse(execFileSync(process.execPath,[cli,'reconcile',...['manifest.json','ledger.json','synthetic-receipts.json'].map(f=>path.join(out,f))],{encoding:'utf8'}));
  const [a,b]=summarizeEvaluation(joined.rows); assert.equal(a.costPerVerifiedMicros,2000);assert.equal(b.totalCostMicros,null);assert.equal(joined.source,'simulation');
  assert.deepEqual((await inspectJournal(out)).ledger,ledger);
  const journalFile=path.join(out,'attempts.jsonl');
  await writeFile(journalFile,JSON.stringify(journal[0])+'\n'+ '{"repeat":');
  const partial=await inspectJournal(out);assert.equal(partial.completed,1);assert.equal(partial.tornTail,true);assert.equal(partial.unobserved.length,summary.attempts-1);assert.equal(partial.ledger,null);
  await writeFile(journalFile,JSON.stringify(journal[1])+'\n');await assert.rejects(inspectJournal(out),/order or plan identity/);
  await assert.rejects(rehearse(out),/EEXIST/);
});
