// Trusted held-out probe. Staged by eval-qualify, never placed inside the source snapshot.
import { CogneeMemory } from '../snapshot/src/memory.ts';

const text = 'Receipt qualification sample';
const check = process.argv[2];
if (!['missing', 'provided'].includes(check)) throw new Error('Unknown check');
const origin = 'https://receipt.invalid';
const routes = [];
const memory = new CogneeMemory({ enabled: true, baseUrl: origin, dataset: 'demo', timeoutMs: 1000 }, '.', async (url, init) => {
  const route = `${init.method ?? 'GET'} ${String(url).slice(origin.length)}`;
  routes.push(route);
  if (!String(url).startsWith(origin + '/')) throw new Error('Unexpected origin');
  switch (route) {
    case 'POST /api/v1/remember':
      return Response.json(check === 'missing' ? { dataset_id: 'ds' } : { dataset_id: 'ds', data_id: 'direct' });
    case 'GET /api/v1/datasets/ds/data':
      return Response.json([{ id: 'other', name: 'unrelated' }, { id: 'resolved', name: 'note' }]);
    case 'GET /api/v1/datasets/ds/data/resolved/raw':
      return new Response(text);
    default: throw new Error('Unexpected request');
  }
});
const receipt = await memory.remember(text, undefined, 'note.md');
console.log(JSON.stringify({ dataset: receipt?.datasetId ?? null, data: receipt?.dataId ?? null, routes }));
