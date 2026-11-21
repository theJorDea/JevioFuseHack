import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import web from '../scripts/eval-adapters/web-reload-busy.mjs';
import {modelInput, verifySource} from '../scripts/eval-candidate.mjs';

const snapshot=(edition:string)=>readFile(new URL(`../benchmark/evaluation/web-reload-busy/${edition}-app.js.fixture`,import.meta.url),'utf8');

test('web reload: exact pinned client projection, busy history restored, idle history unchanged', async()=>{
  const original=await snapshot('base'), base=web.project(original,'base');
  assert.throws(()=>web.project(original+' ','base'),/Unknown web client fixture/);
  assert.deepEqual((await modelInput(web.id)).files,{'web/app.js':base});
  assert.deepEqual(verifySource(base,web.id).checks,{target:'FAIL',control:'PASS'});
  const gold=web.project(await snapshot('gold'),'gold');
  assert.deepEqual(verifySource(gold,web.id).checks,{target:'PASS',control:'PASS'});
});

for(const prop of ['innerHTML','textContent']) test(`web reload: clearing chat via ${prop} removes restored bubbles`,async()=>{
  const gold=web.project(await snapshot('gold'),'gold');
  const candidate=gold+`\nconst restore=boot; boot=async()=>{await restore();document.getElementById('chat').${prop}='';};`;
  assert.deepEqual(verifySource(candidate,web.id).checks,{target:'FAIL',control:'FAIL'});
});

test('web reload: reject duplicates on busy restore, unlocked busy composer, and disabled idle composer',async()=>{
  const gold=web.project(await snapshot('gold'),'gold');
  const checks=(before:string,after:string)=>{
    assert.equal(gold.split(before).length,2,'mutation must apply exactly once');
    return verifySource(gold.replace(before,after),web.id).checks;
  };
  assert.deepEqual(checks('&& !data.messages?.some(', '&& (true || !data.messages?.some(').target,'INVALID'); // malformed client cannot be accepted
  assert.deepEqual(checks('&& !data.messages?.some(\n    (message) => message.role === "user" && message.content === state.activeTask,\n  )',''),{target:'FAIL',control:'PASS'});
  assert.deepEqual(checks('state.busy = true;\n      els.send.disabled = true;', 'state.busy = true;\n      els.send.disabled = false;'),{target:'FAIL',control:'PASS'});
  assert.deepEqual(checks('const status = await refreshStatus();\n    if (status.busy)', 'const status = await refreshStatus();\n    els.send.disabled = true;\n    if (status.busy)'),{target:'PASS',control:'FAIL'});
});
