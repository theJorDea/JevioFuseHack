// Local checkout CLI. The historical fix and checks never enter the optional model packet.
import {createHash} from 'node:crypto';
import {loadTeamCase,readCandidateFile} from './eval-team-case.mjs';
import {evaluateFunction} from './eval-team-engine.mjs';

async function main([cmd,caseFile,candidate,...extra]) {
  if (!caseFile || extra.length || !['input','qualify','verify'].includes(cmd) || (cmd==='verify')!==Boolean(candidate)) throw Error('usage');
  const c=await loadTeamCase(caseFile);
  if(cmd==='input') return [0,{task:c.task,entry:c.entry,files:{'candidate.ts':c.baseSource}}];
  const run=source=>evaluateFunction(source,c.entry,c.checks);
  const base=run(c.baseSource), gold=run(c.goldSource);
  // Every designated target must witness the bug; a syntax error is not historical evidence.
  const qualified=c.checks.every(({kind},i)=>base.results[i]===(kind==='target'?'FAIL':'PASS') && gold.results[i]==='PASS');
  const report={schema:'jevio-team-result/v1',caseSha256:c.caseSha256,qualified,base:base.results,gold:gold.results};
  if(!qualified || cmd==='qualify') return [qualified?0:1,report];
  const source=await readCandidateFile(candidate),r=run(source);
  return [r.verified?0:1,{...report,candidateSha256:createHash('sha256').update(source).digest('hex'),verified:r.verified,checks:r.checks,results:r.results}];
}
try {
  const [code,body]=await main(process.argv.slice(2)); console.log(JSON.stringify(body,null,2)); process.exitCode=code;
} catch {
  console.error('Local evaluation failed: check case schema, pinned files and worker. Usage: eval-team.mjs input|qualify CASE.json, or verify CASE.json CANDIDATE.ts'); process.exitCode=2;
}
