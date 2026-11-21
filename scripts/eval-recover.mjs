// Recover completed observations only. Never infer, retry or bill an interrupted request.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeEvaluationPlan} from '../src/eval-plan.ts';
import {summarizeEvaluation} from '../src/eval-report.ts';

export async function inspectJournal(dir){
  const load=async n=>JSON.parse(await readFile(path.join(dir,n),'utf8'));
  const plan=makeEvaluationPlan(await load('manifest.json'));
  const recorded=await load('plan.json');
  if(JSON.stringify(recorded)!==JSON.stringify(plan)||plan.policy.provider!=='offline'||plan.policy.routingGroup!=='simulation') throw Error('Not the original rehearsal plan');
  const raw=await readFile(path.join(dir,'attempts.jsonl'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
  const lines=raw.split('\n'); const tornTail=lines.pop()!=='';
  if(lines.length>plan.attempts.length) throw Error('Unexpected extra journal rows');
  const rows=lines.map((line,i)=>{
    const r=JSON.parse(line),a=plan.attempts[i];
    if(r.task!==a.task||r.model!==a.model||r.repeat!==a.repeat||r.planSha256!==plan.planSha256) throw Error('Journal order or plan identity mismatch');
    summarizeEvaluation([r]); return r;
  });
  const complete=!tornTail&&rows.length===plan.attempts.length;
  if(complete) summarizeEvaluation(rows);
  return {complete,tornTail,completed:rows.length,planned:plan.attempts.length,unobserved:plan.attempts.slice(rows.length),ledger:complete?{schema:'jevio-eval-ledger/v1',planSha256:plan.planSha256,currency:'USD',source:'simulation',rows}:null};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{if(process.argv.length!==3)throw Error('Usage: node scripts/eval-recover.mjs DIRECTORY');const r=await inspectJournal(process.argv[2]);console.log(JSON.stringify(r,null,2));if(!r.complete)process.exitCode=1;}catch(e){console.error(e.message);process.exitCode=2;}
}
