import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const [check, ...extra] = process.argv.slice(2);
if (!['target', 'control'].includes(check) || extra.length) throw new Error('Expected target or control');
const source = await readFile('src/provider/openai-compatible.ts');
if (![
  '79b2aad4fd49f03ddea336ae4955230f31cfbeb67863421017c0dcf9e39c5cba',
  'fbd11fd027e8d21ff350b8a28a17c529e04956b1c2b1b03640d02a8757f8ed6b',
].includes(createHash('sha256').update(source).digest('hex'))) throw new Error('Untrusted provider bytes');

const baseUrl = 'https://provider.invalid/v1';
const model = 'local-model';
const messages = [{ role: 'user', content: 'Hello' }];
const terminated = new Error('terminated');
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init.method, body: JSON.parse(init.body) });
  if (calls.length === 1) {
    const body = check === 'target'
      ? new ReadableStream({ start(controller) { controller.error(terminated); } })
      : 'data: {"choices":[{"delta":{"content":"Streamed"}}]}\n\ndata: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  assert.equal(calls.length, 2);
  return Response.json({ choices: [{ message: { content: 'Recovered' } }] });
};
const js = stripTypeScriptTypes(source.toString('utf8'));
const { OpenAICompatibleClient } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const client = new OpenAICompatibleClient({ baseUrl }, { model });
const deltas = [];
let result;
let outcome = 'PASS';
try {
  result = await client.complete({ messages }, delta => deltas.push(delta));
} catch (error) {
  if (check !== 'target' || error !== terminated) throw error;
  outcome = 'FAIL';
}
const streams = check === 'target' && outcome === 'PASS' ? [true, false] : [true];
assert.deepEqual(calls, streams.map(stream => ({
  url: `${baseUrl}/chat/completions`, method: 'POST', body: { model, messages, temperature: 0.2, stream },
})));
assert.deepEqual(deltas, check === 'control' ? [{ type: 'text', delta: 'Streamed' }] : []);
if (outcome === 'PASS') assert.equal(result.content, check === 'control' ? 'Streamed' : 'Recovered');
process.stdout.write(JSON.stringify(outcome));
