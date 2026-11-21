// Browser simulation for these two trusted Git blobs only. node:vm is NOT a sandbox for submitted code.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !['target', 'control'].includes(mode)) throw Error('Expected target or control');
const source = await readFile('web/app.js');
if (!['c5e04e3c6ec78d2c5d1857646d2200c096b5cef7e711cce8a1db5bbd5566f099','2cede69fbaaa1dc558a2e84fef40cd190bebba0757444232f3525773df0cab0e'].includes(createHash('sha256').update(source).digest('hex'))) throw Error('Not a pinned historical client');

function element() {
  const children = [];
  return {children, disabled:false, dataset:{}, style:{}, classList:{add(){},remove(){},toggle(){}},
    addEventListener(){}, querySelectorAll(){return []}, querySelector(){return null},
    append(...nodes){children.push(...nodes)},appendChild(node){children.push(node)} };
}
const elements = new Map();
const get = id => { if (!elements.has(id)) elements.set(id,element()); return elements.get(id); };
const task = 'Prepare the release summary';
const target = mode === 'target';
const responses = {
  '/api/status': {busy:target, activeTask:target?task:null, activeDetail:'Reading files', sessionId:'example-session', workspace:'/workspace/example', mode:'direct', todos:[]},
  '/api/history': {messages:target?[]:[{role:'user',content:task}]}, '/api/sessions':[],
};
const visited=[];
await runInNewContext(source.toString('utf8'), {
  document:{getElementById:get,createElement:element,body:element(),documentElement:element()},
  localStorage:{getItem(){return null}}, window:{setTimeout(){return 1}},
  fetch: async route => { visited.push(route); if (!Object.hasOwn(responses,route)) throw Error('Unexpected route'); return {ok:true,headers:{get:()=>'application/json'},json:async()=>responses[route]}; },
}, {filename:'web/app.js',timeout:1500}); // Last expression is boot(); await all initial rendering.
assert.deepEqual(visited,['/api/status','/api/history','/api/sessions']);
assert.equal(get('status-pill').className, target?'pill busy':'pill idle');
const bubbles = get('chat').children.map(b=>[b.className,b.children[1]?.textContent]);
let verdict;
if (target && !get('send').disabled && bubbles.length===0) verdict='FAIL'; // exact base symptom
else {assert.deepEqual(bubbles,[['bubble user', task]]); assert.equal(get('send').disabled,target); verdict='PASS';}
process.stdout.write(JSON.stringify(verdict));
