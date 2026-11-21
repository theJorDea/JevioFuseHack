import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../scripts/eval-team.mjs',import.meta.url));
const cwd=fileURLToPath(new URL('../examples/team-cases/slash-unicode/',import.meta.url));
test('public external slash case qualifies upstream and rejects unconditional replacement',()=>{
  const r=spawnSync(process.execPath,[cli,'verify','case.json','naive.js'],{cwd,encoding:'utf8'});
  assert.equal(r.status,1,r.stderr); const report=JSON.parse(r.stdout);
  assert.equal(report.qualified,true); assert.equal(report.verified,false);
  assert.deepEqual(report.base,['FAIL','FAIL','PASS','PASS','PASS']);
  assert.deepEqual(report.gold,['PASS','PASS','PASS','PASS','PASS']);
  assert.deepEqual(report.results,['PASS','PASS','FAIL','PASS','PASS']);
});
