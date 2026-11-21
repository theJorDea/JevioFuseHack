import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [kind,...rest] = process.argv.slice(2);
if (rest.length || !['target','control'].includes(kind)) throw Error('Unknown probe');
const url = pathToFileURL(resolve('src/agent.ts'));
const hash = createHash('sha256').update(readFileSync(url)).digest('hex');
if (!['82c4f3c5ba19e9dce72a1c2e2176e737a50ccdea1d73016d33f95ee411b8d6d7','f6c9a8ea65517b1338f6206f62bd52dbdcffdda9827eeba15c8952242ce0378f'].includes(hash)) throw Error('Unreviewed parser source');
const {parseFallbackToolCalls} = await import(url.href);
const args = { query: 'red  blue', note: 'quoted "text" and a literal backslash: \\test' };
const clean = JSON.stringify({ jevio_tool_calls: [{ name:'lookup', arguments:args }] });
const separators = kind === 'target' ? ['\\\n','\\\r\n'] : [''];
const observed = separators.map(separator => {
  const contents = clean.replace('red  blue',`red${separator}  blue`);
  const calls = parseFallbackToolCalls(['```json',contents,'```'].join('\n'),new Set(['lookup']));
  if (kind === 'target' && Array.isArray(calls) && calls.length === 0) return 'FAIL';
  assert.equal(calls.length,1); assert.equal(calls[0].name,'lookup');
  assert.deepEqual(JSON.parse(calls[0].arguments),args);
  return 'PASS';
});
assert.equal(new Set(observed).size,1,'Unexpected divergence between line endings');
process.stdout.write(JSON.stringify(observed[0]));
