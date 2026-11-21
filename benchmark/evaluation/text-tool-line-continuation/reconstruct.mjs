// Rebuild from trusted local Git blobs; review-only utility, not required during evaluation.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const folder = new URL('./', import.meta.url);
const cwd = fileURLToPath(folder);
for (const [edition, blob, first] of [
  ['base','eebbb7669a0446b6ee86d14d6f590506caa7a571','export function parseFallbackToolCalls('],
  ['gold','8a27ea7b252231dc83cebae90684506370795d44','function repairMalformedJsonLineContinuations('],
]) {
  const data = execFileSync('git', ['cat-file','blob',blob], {cwd});
  const start = data.indexOf('\n'+first)+1;
  const end = data.indexOf('\n\nexport function pruneOldToolResults(',start);
  if (start < 1 || end < start) throw Error('Historical source boundary mismatch');
  await writeFile(new URL(`${edition}-parser.ts.fixture`,folder),data.subarray(start,end+1));
}
