import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const [check, ...extra] = process.argv.slice(2);
if (!['target', 'control'].includes(check) || extra.length) throw new Error('Expected target or control');

// Execute only the bytes just verified, not a second read of a mutable path.
const source = await readFile('src/provider/openai-compatible.ts');
if (![
  'f6db42ae708beec15c6fed8092a1bb6679a1c853f383c2a7af74b8f5f8f7cdbe',
  '9bec8d649314413f5746f6a063e5fe7ff0315f5eaf05545a8b3386483de0ac7f',
].includes(createHash('sha256').update(source).digest('hex'))) throw new Error('Untrusted provider bytes');

const model = check === 'target' ? 'moonshot/Kimi-K2.7' : 'qwen3-coder';
const messages = [{ role: 'user', content: 'Hello' }];
const temperatures = [];
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://provider.invalid/chat/completions');
  assert.equal(init.method, 'POST');
  const { temperature, ...body } = JSON.parse(init.body);
  assert.deepEqual(body, { model, messages, stream: false });
  temperatures.push(temperature);
  return Response.json({ choices: [{ message: { content: 'OK' } }] });
};
const js = stripTypeScriptTypes(source.toString('utf8'));
const { OpenAICompatibleClient } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
for (const [roleTemp, requestTemp] of [[0.15, 0], [0.15, undefined], [undefined, undefined]]) {
  const client = new OpenAICompatibleClient({ baseUrl: 'https://provider.invalid' }, { model, temperature: roleTemp });
  const result = await client.complete({ messages, temperature: requestTemp });
  assert.equal(result.content, 'OK');
}
const ordinary = [0, 0.15, 0.2];
let outcome = 'PASS';
if (check === 'target' && JSON.stringify(temperatures) === JSON.stringify(ordinary)) outcome = 'FAIL';
else assert.deepEqual(temperatures, check === 'target' ? [1, 1, 1] : ordinary);
process.stdout.write(JSON.stringify(outcome));
