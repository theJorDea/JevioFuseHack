// One read, one fresh WASM runtime, one input. No loader, host callbacks or pending-job pump.
import {stripTypeScriptTypes} from 'node:module';
import {getQuickJS} from 'quickjs-emscripten';
const parts=[];let size=0;
for await(const part of process.stdin){if((size+=part.length)>256*1024)throw Error('Invalid worker input');parts.push(part);}
const {source,entry,input}=JSON.parse(Buffer.concat(parts));
const rt=(await getQuickJS()).newRuntime();
rt.setMemoryLimit(16*1024*1024);rt.setMaxStackSize(256*1024);
const vm=rt.newContext(),deadline=performance.now()+500;
rt.setInterruptHandler(()=>performance.now()>deadline);
// Before loading the candidate, capture the intrinsics used for measurement and serialization.
// JSON escaping retains lone surrogates and embedded NUL, even across the WASM C-string API.
const safeCall=`((quote,code,parse)=>(fn,encoded)=>{
  const value=fn(parse(encoded));
  if(typeof value==='boolean')return quote(value);
  if(typeof value!=='string'||value.length>4096)return null;
  let bytes=0;
  for(let i=0;i<value.length;i++){
    const n=code(value,i),low=n>=0xd800&&n<=0xdbff?code(value,i+1):0;
    if(low>=0xdc00&&low<=0xdfff){bytes+=4;i++;}else bytes+=n<128?1:n<2048?2:3;
    if(bytes>4096)return null;
  }
  return quote(value);
})(JSON.stringify,Function.call.bind(String.prototype.charCodeAt),JSON.parse)`;
let observed=null;
try {
  const adapter=vm.unwrapResult(vm.evalCode(safeCall,'adapter.js',{type:'global'}));
  try {
    let js;try{js=stripTypeScriptTypes(source);}catch{/* invalid TS */}
    if(js!==undefined){
      const mod=vm.evalCode(js,'candidate.mjs',{type:'module'});
      if(mod.error)mod.error.dispose();
      else try{
        const fn=vm.getProp(mod.value,entry),arg=vm.newString(JSON.stringify(input));
        try{
          if(vm.typeof(fn)==='function'){
            const result=vm.callFunction(adapter,vm.undefined,fn,arg);
            if(result.error)result.error.dispose();
            else try{if(vm.typeof(result.value)==='string')observed=JSON.parse(vm.getString(result.value));}finally{result.value.dispose();}
          }
        }finally{arg.dispose();fn.dispose();}
      }finally{mod.value.dispose();}
    }
  }finally{adapter.dispose();}
}finally{vm.dispose();rt.dispose();}
process.stdout.write(JSON.stringify(observed));
