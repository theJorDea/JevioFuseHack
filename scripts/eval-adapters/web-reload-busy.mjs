// Projection is the complete browser script from the pinned base/gold blob, minus its
// last standalone boot() call. No implementation or recovery logic is injected. The
// wrapper calls boot once with guest-local browser doubles and awaits the initial render.
import {createHash} from 'node:crypto';
import spec from '../../benchmark/evaluation/web-reload-busy/case.mjs';

const suffix = /\nboot\(\);\s*$/;
const adapter = `async (client, mode) => {
  const task = 'Prepare the release summary';
  const busy = mode !== 'idle';
  const sessions = [];
  const history = mode === 'busy' ? [] : [{role:'user', content:task}];
  const responses = {
    '/api/status': {busy, activeTask:busy?task:null, activeDetail:'Reading files', sessionId:'example-session', workspace:'/workspace/example', mode:'direct', todos:[]},
    '/api/history': {messages:history}, '/api/sessions':sessions,
  };
  function element(){
    const children=[];
    return {children, disabled:false, dataset:{}, style:{}, classList:{add(){},remove(){},toggle(){}},
      addEventListener(){}, querySelectorAll(){return []}, querySelector(){return null},
      append(...nodes){children.push(...nodes)}, appendChild(node){children.push(node)}};
  }
  const elements = new Map();
  const get = id => {if(!elements.has(id))elements.set(id,element());return elements.get(id)};
  const chat=get('chat'), send=get('send'), pill=get('status-pill');
  let routes='';
  const fetch = async route => {
    const r=route==='/api/status'?'s':route==='/api/history'?'h':route==='/api/sessions'?'l':'?';
    if(routes.length>=4 || r==='?') throw Error('Unexpected route');
    routes+=r;
    return {ok:true, headers:{get:()=>'application/json'}, json:async()=>responses[route]};
  };
  await client({getElementById:get,createElement:element,body:element(),documentElement:element()},
    {getItem(){return null}}, {setTimeout(){return 1}}, fetch);
  const bubble=chat.children[0];
  return routes+'|'+(pill.className==='pill busy'?'B':pill.className==='pill idle'?'I':'?')+
    '|'+(send.disabled===true?'D':send.disabled===false?'E':'?')+
    '|'+(chat.children.length===1?'1':chat.children.length===0?'0':'M')+
    '|'+(bubble?.className==='bubble user'?'U':'?')+'|'+(bubble?.children?.[1]?.textContent===task?'T':'?');
}`;

export default {
  id:spec.id, path:spec.files.base[0][0],
  project(fullSource,edition){
    const pin=spec.files[edition]?.[0]?.[2];
    if (!pin || createHash('sha256').update(fullSource).digest('hex')!==pin || !suffix.test(fullSource)) throw Error('Unknown web client fixture');
    return fullSource.replace(suffix,'\n// The verifier calls boot() on reload.\n');
  },
  wrap(source){return `export async function runClient(document, localStorage, window, fetch){\n${source}\nreturn await boot();\n}`;},
  entry:'runClient',adapter,
  checks:[['target','busy','shl|B|D|1|U|T'],['target','busy-saved','shl|B|D|1|U|T'],['control','idle','shl|I|E|1|U|T']],
  judge(observed,expected){return typeof observed!=='string'?'INVALID':observed===expected?'PASS':'FAIL';},
};
