import { isDeepStrictEqual } from 'node:util';

const baseUrl = 'https://provider.invalid/v1';
const model = 'local-model';
// Evaluated before the candidate module. All I/O doubles and the observation state live
// in the guest; only primitive snapshots cross to the host, never response objects.
const adapter = String.raw`(() => {
  const quote = JSON.stringify, char = String.fromCharCode, bytes = Uint8Array;
  const small = v => typeof v === 'string' && v.length <= 1024;
  const chunks = ['data: {"choices":[{"delta":{"content":"Stre', 'amed"}}]}\n\ndata: [DONE]\n\n'];
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
    wire+=(calls===1?'':',')+'['+quote(url)+','+quote(method)+','+quote(body)+']';
    if(calls===2) return {ok:true,status:200,headers:{get:()=>'application/json'},text:async()=>' {"choices":[{"message":{"content":"Recovered"}}]}'};
    return {ok:true,status:200,headers:{get:()=>'text/event-stream'},body:{getReader(){return {async read(){
      const i=reads++;
      if(mode==='interrupted') throw Error('terminated');
      if(i>=chunks.length) return {done:true};
      const s=chunks[i], data=new bytes(s.length); for(let j=0;j<s.length;j++)data[j]=s.charCodeAt(j);
      return {done:false,value:data};
    }}}}};
  }});
  return async (Client, input) => {
    mode=input; active=true; let content=null, threw=false;
    try {
      const client=new Client({baseUrl:'https://provider.invalid/v1'},{model:'local-model'});
      const result=await client.complete({messages:[{role:'user',content:'Hello'}]}, event=>{
        const type=event?.type, text=event?.delta;
        if(++deltaCount>4 || !small(type)||!small(text)) throw Error('Invalid delta');
        deltas+=(deltaCount===1?'':',')+'['+quote(type)+','+quote(text)+']';
      });
      content=result?.content; if(!small(content))return null;
    } catch {threw=true;} finally {active=false;}
    if(earlyRetry||calls>2||deltaCount>4||reads>16)return null;
    return '[['+wire+'],['+deltas+'],'+quote(content)+','+threw+','+reads+','+calls+','+deltaCount+']';
  };
})()`;

function expected(interrupted) {
  const streams = interrupted ? [true,false] : [true];
  return [streams.map(stream=>[baseUrl+'/chat/completions','POST', {model,messages:[{role:'user',content:'Hello'}],temperature:0.2,stream}]),
    interrupted ? [] : [['text','Streamed']],interrupted?'Recovered':'Streamed',false,interrupted?1:3,streams.length,interrupted?0:1];
}

export default {
  id:'provider-stream-recovery', path:'src/provider/openai-compatible.ts', project:s=>s, wrap:s=>s, entry:'OpenAICompatibleClient', adapter,
  checks:[['target','interrupted',expected(true)],['control','healthy',expected(false)]],
  judge(observed,expected){
    if(typeof observed!=='string'||observed.length>8192)return 'INVALID';
    try {
      const actual=JSON.parse(observed);
      if(!Array.isArray(actual)||actual.length!==7||!Array.isArray(actual[0])||actual[0].length>2)return 'INVALID';
      actual[0]=actual[0].map(([url,method,body])=>[url,method,JSON.parse(body)]);
      return isDeepStrictEqual(actual,expected)?'PASS':'FAIL';
    } catch { return 'INVALID'; }
  },
};
