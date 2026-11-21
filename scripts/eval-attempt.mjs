// Offline-by-construction: the caller supplies both transport and verifier. No retries or billing estimates.
const paths = new Map([['task-intent-questions','src/task-intent.ts'],['text-tool-line-continuation','src/agent.ts'],['session-picker-focus','src/picker-method.ts']]);
const bodyLimit = 256 * 1024, sourceLimit = 32 * 1024;
const positive = n => Number.isSafeInteger(n) && n > 0;
const discard = promise => promise?.catch(() => {});

async function boundedJson(response, signal) {
  if (!response.body || Number(response.headers.get('content-length')) > bodyLimit) {
    discard(response.body?.cancel()); throw Error();
  }
  const reader = response.body.getReader();
  const cancel = () => discard(reader.cancel());
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let size = 0; const chunks = [];
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks, size)));
      if (!(value instanceof Uint8Array) || (size += value.length) > bodyLimit) { cancel(); throw Error(); }
      if (value.length) chunks.push(Buffer.from(value));
    }
    throw Error();
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Reads a single non-streaming Chat Completion. timeoutMs bounds async waits; sync verification must enforce its own worker limits. */
export async function runAttempt({task = 'task-intent-questions', model, repeat, packet, systemPrompt, temperature, maxOutputTokens, timeoutMs, fetchImpl, verify}) {
  const file = paths.get(task);
  if (!file || typeof fetchImpl !== 'function' || typeof verify !== 'function' || typeof model !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9.:/_-]{0,127}$/.test(model) || !positive(repeat) ||
      !positive(maxOutputTokens) || !positive(timeoutMs) || timeoutMs > 2_147_483_647 ||
      !Number.isFinite(temperature) || temperature < 0 || temperature > 2 || typeof systemPrompt !== 'string' || !systemPrompt.trim() ||
      typeof packet?.task !== 'string' || !packet.task.trim() || typeof packet.files?.[file] !== 'string' || !packet.files[file].length) {
    throw new TypeError('Invalid attempt configuration');
  }
  const start = performance.now();
  const row = { model, task, repeat, verified:false, regression:null, accepted:null, costMicros:null, requestId:null };
  const finish = status => ({ ...row, durationMs:Math.round(performance.now()-start), status });
  const controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error()); }, timeoutMs); });
  let failure = 'api_error';
  try {
    const response = await Promise.race([fetchImpl('/v1/chat/completions', {
      method:'POST', redirect:'error', signal:controller.signal, headers:{'content-type':'application/json'},
      body:JSON.stringify({model,temperature,max_completion_tokens:maxOutputTokens,stream:false,n:1,messages:[
        {role:'system',content:systemPrompt}, {role:'user',content:JSON.stringify({task:packet.task,files:{[file]:packet.files[file]}})},
      ]}),
    }), timeout]);
    // A Chat completion's JSON id is not an HTTP request ID. Never rewrite/truncate a provider ID.
    const id = response.headers.get('x-request-id');
    if (id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && !/^(?:sk-|Bearer)/i.test(id)) row.requestId = id;
    if (!response.ok) { discard(response.body?.cancel()); return finish('api_error'); }
    failure = 'invalid';
    const data = await Promise.race([boundedJson(response, controller.signal), timeout]);
    const usage = {};
    for (const k of ['prompt_tokens','completion_tokens','total_tokens']) {
      const n = data?.usage?.[k]; if (Number.isSafeInteger(n) && n >= 0) usage[k] = n;
    }
    if (Object.keys(usage).length) row.usage = usage;
    if (data?.error) return finish('api_error');
    if (data?.model !== undefined && data.model !== model) return finish('model_mismatch');
    if (!Array.isArray(data?.choices) || data.choices.length !== 1) return finish('invalid');
    const choice = data.choices[0], msg = choice?.message;
    if (choice?.finish_reason === 'content_filter' || msg?.refusal) return finish('refused');
    if (choice?.finish_reason === 'length') return finish('truncated');
    const source = msg?.content;
    if (choice?.finish_reason !== 'stop' || msg?.role !== 'assistant' || msg.tool_calls || msg.function_call ||
        typeof source !== 'string' || !source.trim() || Buffer.byteLength(source)>sourceLimit || /^\s*(?:```|~~~|diff --git|\*\*\* Begin Patch|--- )/.test(source)) return finish('invalid');
    failure = 'verification_error';
    const result = await Promise.race([verify(source), timeout]);
    // A synchronous verifier can occupy the event loop past a timer callback's deadline.
    if (performance.now() - start >= timeoutMs) return finish('timeout');
    const target = result?.checks?.target, control = result?.checks?.control;
    if (![target,control].every(s=>['PASS','FAIL','INVALID'].includes(s)) || result.verified !== (target==='PASS' && control==='PASS')) return finish('verification_error');
    row.checks = {target,control};
    if (typeof result.candidateSha256 === 'string' && /^[a-f0-9]{64}$/.test(result.candidateSha256)) row.candidateSha256 = result.candidateSha256;
    row.verified = result.verified;
    row.regression = control==='INVALID' ? null : control==='FAIL';
    return finish(row.verified ? 'verified' : [target,control].includes('INVALID') ? 'invalid' : 'not_verified');
  } catch { return finish(controller.signal.aborted ? 'timeout' : failure); }
  finally { clearTimeout(timer); }
}
