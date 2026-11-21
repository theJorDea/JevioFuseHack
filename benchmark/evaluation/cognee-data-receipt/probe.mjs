// Trusted held-out probe. Staged by eval-qualify, never placed inside the source snapshot.
import { CogneeMemory } from '../snapshot/src/memory.ts';

const text = 'Receipt qualification sample';
const check = process.argv[2];
if (!['target', 'control'].includes(check)) throw new Error('Unknown check');
const origin = 'https://receipt.invalid';
const routes = [];
const memory = new CogneeMemory({ enabled: true, baseUrl: origin, dataset: 'demo', timeoutMs: 1000 }, '.', async (url, init) => {
  const route = `${init.method ?? 'GET'} ${String(url).slice(origin.length)}`;
  routes.push(route);
  if (!String(url).startsWith(origin + '/')) throw new Error('Unexpected origin');
  switch (route) {
    case 'POST /api/v1/remember':
      return Response.json(check === 'target' ? { dataset_id: 'ds' } : { dataset_id: 'ds', data_id: 'direct' });
    case 'GET /api/v1/datasets/ds/data':
      return Response.json([{ id: 'other', name: 'unrelated' }, { id: 'resolved', name: 'note' }]);
    case 'GET /api/v1/datasets/ds/data/resolved/raw':
      return new Response(text);
    default: throw new Error('Unexpected request');
  }
});
const receipt = await memory.remember(text, undefined, 'note.md');
const same = (...expected) => JSON.stringify(routes) === JSON.stringify(expected);
const start = 'POST /api/v1/remember';
if (receipt?.datasetId !== 'ds') throw new Error('Unexpected dataset');
let verdict;
if (check === 'control' && same(start) && receipt.dataId === 'direct') verdict = 'PASS';
if (check === 'target' && same(start) && receipt.dataId == null) verdict = 'FAIL';
if (check === 'target' && same(start, 'GET /api/v1/datasets/ds/data', 'GET /api/v1/datasets/ds/data/resolved/raw') && receipt.dataId === 'resolved') verdict = 'PASS';
if (!verdict) throw new Error('Unexpected receipt behavior');
console.log(JSON.stringify(verdict));
