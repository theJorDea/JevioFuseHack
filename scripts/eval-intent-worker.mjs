// Internal worker. Candidate JS is evaluated only by the WASM guest, never Node.
import { stripTypeScriptTypes } from 'node:module';
import { getQuickJS } from 'quickjs-emscripten';
const chunks = []; let size = 0;
for await (const b of process.stdin) { if ((size += b.length) > 256 * 1024) throw Error('Input limit'); chunks.push(b); }
const { source, input, taskId } = JSON.parse(Buffer.concat(chunks));
const parser = taskId === 'text-tool-line-continuation';
const picker = taskId === 'session-picker-focus';
const engine = await getQuickJS();
const runtime = engine.newRuntime();
runtime.setMemoryLimit(16 * 1024 * 1024); runtime.setMaxStackSize(256 * 1024);
const end = performance.now() + 500;
runtime.setInterruptHandler(() => performance.now() > end);
const vm = runtime.newContext();
// Capture intrinsics before loading candidate code. Project only bounded primitive fields;
// do not dump guest objects, invoke toJSON, return a guest verdict or dispatch any calls.
// A candidate receives only guest doubles. Observations live in this adapter's closure,
// not in the injected method's lexical scope. No onSelect/tool dispatch or host callback.
const pickerAdapter = `async (makePicker, mode) => {
  let shown = null, focus, list, messageCount = 0, role = '', text = '';
  const editor = {}; focus = editor;
  class SelectList { constructor(items) { this.items=items; list=this; } }
  const Klass=makePicker(SelectList,{},()=>({last:null,addChild(child){this.last=child}}),class {},x=>x,x=>x);
  const p=new Klass(); p.editor=editor;
  p.options={listSessions:async()=>mode==='empty'?[]:[{id:'session-1',title:'First',updatedAt:'2026-07-10T00:00:00Z'}]};
  p.appendMessage=(r,t)=>{messageCount++;role=r;text=t};
  p.tui={showOverlay(overlay){shown=overlay;return {hide(){if(shown===overlay)shown=null}}},setFocus(x){focus=x}};
  await p.showSessionPicker();
  const visible=shown!==null, presented=!!list && shown?.last===list;
  const id=presented?list.items?.[0]?.value:'';
  const focused=!!list && focus===list;
  if(mode==='populated' && presented && typeof list.onCancel==='function') list.onCancel();
  if(typeof id!=='string'||id.length>64||typeof role!=='string'||role.length>32||typeof text!=='string'||text.length>128) return null;
  return (+visible)+'|'+(+presented)+'|'+(+focused)+'|'+(+(shown!==null))+'|'+(+(focus===editor))+'|'+messageCount+'|'+id+'|'+role+'|'+text;
}`;
const adapter = picker ? pickerAdapter : parser ? `((isArray, allowed) => (fn, input) => {
  const calls = fn(input, allowed);
  if (!isArray(calls)) return null;
  if (calls.length !== 1) return 'count-mismatch';
  const first = calls[0];
  const name = first?.name, args = first?.arguments;
  if (typeof name !== 'string' || typeof args !== 'string' || name.length > 64 || args.length > 2048) return null;
  return name.length + ':' + name + args;
})(Array.isArray, new Set(['lookup']))` : '(fn, input) => fn(input)';
function take(result) {
  if (result.error) { result.error.dispose(); throw Error('Guest exception'); }
  return result.value;
}
let observed = null;
try {
  const call = take(vm.evalCode(adapter, 'observation.js', {type:'global'}));
  try {
    const js = stripTypeScriptTypes(picker ? `export function makePicker(SelectList,selectTheme,modalSurface,Text,boldCyan,dim){return class {\n${source}\n}}` : source);
    const mod = take(vm.evalCode(js, 'candidate.mjs', { type:'module' }));
    try {
      const fn = vm.getProp(mod, picker ? 'makePicker' : parser ? 'parseFallbackToolCalls' : 'isImplementationRequest');
      const arg = vm.newString(input);
      try {
        const res = vm.callFunction(call, vm.undefined, fn, arg);
        if (res.error) res.error.dispose();
        else {
          try {
            if (picker) {
              const jobs = runtime.executePendingJobs(32);
              if (jobs.error) { jobs.error.dispose(); throw Error('Guest job failed'); }
              const state = vm.getPromiseState(res.value);
              if (state.type === 'fulfilled') {
                try { if (vm.typeof(state.value)==='string') observed=vm.getString(state.value); }
                finally { state.value.dispose(); }
              } else if (state.type === 'rejected') state.error.dispose();
            } else {
              const type = vm.typeof(res.value);
              if (parser && type === 'string') observed = vm.getString(res.value);
              if (!parser && type === 'boolean') observed = vm.eq(res.value, vm.true);
            }
          } finally { res.value.dispose(); }
        }
      } finally { arg.dispose(); fn.dispose(); }
    } finally { mod.dispose(); }
  } finally { call.dispose(); }
} catch { /* invalid source or unsupported TypeScript */ }
finally { vm.dispose(); runtime.dispose(); }
process.stdout.write(JSON.stringify({observed}));
