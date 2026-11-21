import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectJournal} from '../scripts/eval-recover.mjs';
import {rehearseTeam} from '../scripts/eval-team-rehearse.mjs';

const slash=fileURLToPath(new URL('../examples/team-cases/slash-unicode/case.json',import.meta.url));
const cli=fileURLToPath(new URL('../scripts/model-eval.mjs',import.meta.url));
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const base='export const label=(s:string)=>s; // private-before-marker';
const gold='export const label=(s:string)=>s.trim(); // private-after-marker';
async function makeCase(dir:string,qualified=true){
  await writeFile(path.join(dir,'before.ts'),base);await writeFile(path.join(dir,'after.ts'),gold);
  const file=path.join(dir,'private-case-marker.json');
  await writeFile(file,JSON.stringify({schema:'jevio-team-case/v1',task:'private-task-marker',entry:'label',
    base:{file:'before.ts',sha256:sha(base)},gold:{file:'after.ts',sha256:sha(gold)},
    checks:[{kind:'target',input:qualified?' private-input-marker ':'private-input-marker',expected:'private-input-marker'},
      {kind:'control',input:'a b',expected:'a b'}]}));return file;
}

test('team rehearsal: plan-bound rows, unknown costs, blind dedup and downstream review without source leakage',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'team-rehearsal-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const out=path.join(dir,'run'), team=await makeCase(dir), cases=[slash,team];
  const summary=await rehearseTeam(out,cases);
  assert.equal(summary.attempts,8);assert.match(summary.planSha256,/^[0-9a-f]{64}$/);
  const text=(file:string)=>readFile(path.join(out,file),'utf8');
  for(const file of ['manifest.json','plan.json','ledger.json','attempts.jsonl','report.md']){
    const s=await text(file);assert.ok(s.trim());assert.doesNotMatch(s,/private-(?:task|input|case|before|after)-marker|export const label|export default function slash/);
  }
  const ledger=JSON.parse(await text('ledger.json')),blind=JSON.parse(await text('blind-review.json'));
  const journal=(await text('attempts.jsonl')).trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(journal,ledger.rows); assert.equal(ledger.rows.length,8);assert.equal(ledger.source,'simulation');
  assert.ok(ledger.rows.every(r=>r.costMicros===null&&r.accepted===null));
  const verified=ledger.rows.filter(r=>r.verified);assert.equal(summary.verified,verified.length);
  const tasks=new Set(ledger.rows.map(r=>r.task));assert.equal(tasks.size,2);
  for(const task of tasks){
    const rows=ledger.rows.filter(r=>r.task===task);assert.equal(rows.length,4);
    assert.equal(new Set(rows.map(r=>r.model)).size,2);assert.equal(new Set(rows.map(r=>r.repeat)).size,2);
    assert.ok(rows.some(r=>!r.verified));assert.ok(rows.some(r=>r.verified));
  }
  const recovered=await inspectJournal(out);assert.equal(recovered.complete,true);assert.deepEqual(recovered.ledger,ledger);
  assert.equal(blind.planSha256,summary.planSha256);assert.equal(blind.items.length,2);
  assert.ok(verified.length>blind.items.length,'identical verified bytes should be shown once per task');
  assert.ok(blind.items.some(item=>item.source===gold));
  for(const item of blind.items){assert.deepEqual(Object.keys(item).sort(),['candidateSha256','source','task']);assert.equal(sha(item.source),item.candidateSha256);}
  const decisionsFile=path.join(dir,'decisions.json'),pick=blind.items.find(item=>item.source===gold);
  await writeFile(decisionsFile,JSON.stringify({planSha256:blind.planSha256,decisions:[{task:pick.task,candidateSha256:pick.candidateSha256,accepted:false}]}));
  const reviewed=JSON.parse(execFileSync(process.execPath,[cli,'review',path.join(out,'manifest.json'),path.join(out,'ledger.json'),decisionsFile],{encoding:'utf8'}));
  for(const r of reviewed.rows)assert.equal(r.accepted,r.verified&&r.task===pick.task&&r.candidateSha256===pick.candidateSha256?false:null);
  assert.deepEqual(JSON.parse(await text('ledger.json')),ledger);
  await assert.rejects(rehearseTeam(out,cases));assert.deepEqual(JSON.parse(await text('ledger.json')),ledger);
});

test('team rehearsal rejects duplicate case identity and an unwitnessed target',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'team-rehearsal-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=await makeCase(dir),copy=path.join(dir,'copy.json');await writeFile(copy,await readFile(file));
  await assert.rejects(rehearseTeam(path.join(dir,'duplicate'),[file,copy]));
  await makeCase(dir,false);await assert.rejects(rehearseTeam(path.join(dir,'unqualified'),[file]));
});
