import { isDeepStrictEqual } from 'node:util';

const baseUrl = 'https://provider.invalid/v1';
const model = 'local-model';
// Schema and SSE data only. No tool implementation exists or is dispatched.
const tool={type:'function',function:{name:'read_label',parameters:{type:'object',properties:{}}}};
const frame = delta => `data: ${JSON.stringify({choices:[{delta}]})}\n\n`;
const toolChunks=[frame({tool_calls:[{index:0,id:'c1',function:{name:'read_',arguments:'{'}}]}),
  frame({tool_calls:[{index:0,function:{name:'label',arguments:'}'}}]})+'data: [DONE]\n\n'];
// Evaluated before the candidate module. All I/O doubles and the observation state live
// in the guest; only primitive snapshots cross to the host, never response objects.
const adapter = String.raw`(() => {
  const quote = JSON.stringify, char = String.fromCharCode, bytes = Uint8Array;
  const small = v => typeof v === 'string' && v.length <= 1024;
  const isArray=Array.isArray, entries=Object.entries, lower=Function.call.bind(String.prototype.toLowerCase);
  const field=s=>small(s)?quote(s):'null';
  function list(calls,raw){
    if(raw&&calls===undefined) return '[]';
    if(!isArray(calls)||calls.length>4)return 'null';
    let out='[';
    for(let i=0;i<calls.length;i++){
      const c=calls[i], f=raw?c?.function:c;
      out+=(i?',':'')+'['+field(c?.id)+','+(raw?field(c?.type)+',':'')+field(f?.name)+','+field(f?.arguments)+']';
    }
    return out+']';
  }
  const toolChunks=${JSON.stringify(toolChunks)};
  const textChunks = ['data: {"choices":[{"delta":{"content":"Stre', 'amed"}}]}\n\ndata: [DONE]\n\n'];
  class AsciiDecoder {
    decode(value) { if (value === undefined) return ''; let s=''; for(const b of value) s+=char(b); return s; }
  }
  let active = false, mode, calls=0, wire='', deltas='', deltaCount=0, reads=0, earlyRetry=false;
  Object.defineProperty(globalThis,'AbortSignal',{value:Object.freeze({timeout:()=>undefined})});
  Object.defineProperty(globalThis,'TextDecoder',{value:AsciiDecoder});
  Object.defineProperty(globalThis,'fetch',{value:async(url,init)=>{
    if (!active || ++calls>2) throw Error('Unexpected request');
    if(calls===2 && reads===0) earlyRetry=true;
    const method=init?.method, body=init?.body;
    if (!small(url)||!small(method)||!small(body)) throw Error('Unobservable request');
    let type=null,auth=null,route=null;
    for(const [key,value] of entries(init.headers??{})){
      const k=lower(key); if(k==='content-type')type=value; else if(k==='authorization')auth=value; else if(k==='x-test-route')route=value;
    }
    wire+=(calls===1?'':',')+'['+quote(url)+','+quote(method)+','+quote(body)+','+field(type)+','+field(auth)+','+field(route)+']';
    if(calls===2) return {ok:true,status:200,headers:{get:()=>'application/json'},text:async()=>' {"choices":[{"message":{"content":"Recovered"}}]}'};
    return {ok:true,status:200,headers:{get:()=>'text/event-stream'},body:{getReader(){return {async read(){
      const i=reads++;
      if(mode==='interrupted') throw Error('terminated');
      const chunks=mode==='tool'?toolChunks:textChunks;
      if(i>=chunks.length) return {done:true};
      const s=chunks[i], data=new bytes(s.length); for(let j=0;j<s.length;j++)data[j]=s.charCodeAt(j);
      return {done:false,value:data};
    }}}}};
  }});
  return async (Client, input) => {
    mode=input; active=true; let reply='null', threw=false;
    try {
      const client=new Client({baseUrl:'https://provider.invalid/v1',apiKey:'fixture-only',headers:{'x-test-route':'offline'}},{model:'local-model'});
      const result=await client.complete({messages:[{role:'user',content:'Hello'}],...(mode==='tool'?{tools:[${JSON.stringify(tool)}]}:{})}, event=>{
        const type=event?.type, text=event?.delta;
        if(++deltaCount>4 || !small(type)||!small(text)) throw Error('Invalid delta');
        deltas+=(deltaCount===1?'':',')+'['+quote(type)+','+quote(text)+']';
      });
      const raw=result?.rawMessage;
      reply='['+field(result?.content)+','+list(result?.toolCalls,false)+','+field(raw?.role)+','+field(raw?.content)+','+list(raw?.tool_calls,true)+']';
    } catch {threw=true;} finally {active=false;}
    if(earlyRetry||calls>2||deltaCount>4||reads>16)return null;
    return '[['+wire+'],['+deltas+'],'+reply+','+threw+','+reads+','+calls+','+deltaCount+']';
  };
})()`;

function expected(mode) {
  const interrupted=mode==='interrupted', withTool=mode==='tool', streams=interrupted?[true,false]:[true];
  const text=interrupted?'Recovered':withTool?'':'Streamed', deltas=mode==='healthy'?[['text','Streamed']]:[];
  return [streams.map(stream=>[baseUrl+'/chat/completions','POST',{model,messages:[{role:'user',content:'Hello'}],temperature:0.2,stream,...(withTool?{tools:[tool],tool_choice:'auto'}:{})},'application/json','Bearer fixture-only','offline']),
    deltas,[text,withTool?[['c1','read_label','{}']]:[],'assistant',text,withTool?[['c1','function','read_label','{}']]:[]],false,interrupted?1:3,streams.length,deltas.length];
}

export default {
  id:'provider-stream-recovery', path:'src/provider/openai-compatible.ts', project:s=>s, wrap:s=>s, entry:'OpenAICompatibleClient', adapter,
  checks:[['target','interrupted',expected('interrupted')],['control','healthy',expected('healthy')],['control','tool',expected('tool')]],
  judge(observed,expected){
    if(typeof observed!=='string'||observed.length>8192)return 'INVALID';
    try {
      const actual=JSON.parse(observed);
      if(!Array.isArray(actual)||actual.length!==7||!Array.isArray(actual[0])||actual[0].length>2)return 'INVALID';
      actual[0]=actual[0].map(([url,method,body,...headers])=>[url,method,JSON.parse(body),...headers]);
      return isDeepStrictEqual(actual,expected)?'PASS':'FAIL';
    } catch { return 'INVALID'; }
  },
};
