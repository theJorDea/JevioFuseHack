import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fixture = new URL('../benchmark/evaluation/cognee-data-receipt/', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = {
  'base-memory.ts.fixture': '51ec19aa474ba3f755476487cc5346ddf51266155a3657a4b87b5c4bd1f83fe0',
  'gold-memory.ts.fixture': '7f1a42038c8d9de7a9af3d6237dc471844baaac99f00cb2d8aff672345f038e0',
  'project-identity.ts.fixture': '3e6c5cd230f365199e00f6fd1b42e024833171f90a2f954d209287bf1857d8da',
  'probe.mjs': '9e154c028b362c961a0fb90bf5275254deaf09b5ed9896518c0634829ce48e2b',
};
async function pinned(name) {
  const bytes = await readFile(new URL(name, fixture));
  if (sha256(bytes) !== pins[name]) throw new Error(`Fixture digest mismatch: ${name}`);
  return bytes;
}
const remember = 'POST /api/v1/remember';
const same = (value, expected) => JSON.stringify(value) === JSON.stringify(expected);

async function observe(edition) {
  const root = await mkdtemp(path.join(tmpdir(), 'jevio-eval-'));
  try {
    // Explicit package boundary for Node's native TS/ESM loader, outside the snapshot.
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    const snapshot = path.join(root, 'snapshot');
    const oracle = path.join(root, 'held-out');
    await mkdir(path.join(snapshot, 'src'), { recursive: true });
    await mkdir(oracle);
    const files = [['src/memory.ts', `${edition}-memory.ts.fixture`], ['src/project-identity.ts', 'project-identity.ts.fixture']];
    for (const [relative, name] of files) await writeFile(path.join(snapshot, relative), await pinned(name));
    const script = path.join(oracle, 'probe.mjs');
    await writeFile(script, await pinned('probe.mjs'));
    // Hash ordered [relative POSIX path, SHA-256 of exact bytes] pairs, not machine-specific paths.
    const snapshotHash = sha256(JSON.stringify(files.map(([relative, name]) => [relative, pins[name]])));
    const observeCheck = async kind => {
      const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
      const { stdout } = await run(process.execPath, [script, kind], {
        cwd: snapshot, env, timeout: 6000, maxBuffer: 32768, windowsHide: true,
      });
      const { dataset, data, routes } = JSON.parse(stdout);
      if (dataset !== 'ds' || !Array.isArray(routes) || routes[0] !== remember) throw new Error('Invalid probe observation');
      if (kind === 'provided') return same(routes, [remember]) && data === 'direct' ? 'PASS' : 'FAIL';
      if (data === null && same(routes, [remember])) return 'FAIL'; // Specific historical failure, not an infrastructure exception.
      if (data === 'resolved' && same(routes, [remember, 'GET /api/v1/datasets/ds/data', 'GET /api/v1/datasets/ds/data/resolved/raw'])) return 'PASS';
      throw new Error('Unexpected missing-receipt behavior');
    };
    return { snapshotHash, failToPass: await observeCheck('missing'), passToPass: await observeCheck('provided') };
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Qualifies the fixed trusted fixture only. Never run this harness on submitted patches. */
export async function qualifyDemo() {
  const base = await observe('base');
  const gold = await observe('gold');
  return { taskId: 'cognee-data-receipt', snapshotHash: base.snapshotHash, base, gold,
    qualified: base.failToPass === 'FAIL' && gold.failToPass === 'PASS' && base.passToPass === 'PASS' && gold.passToPass === 'PASS' };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw new Error('eval-qualify takes no arguments');
    const result = await qualifyDemo();
    console.log(JSON.stringify(result, null, 2));
    if (!result.qualified) process.exitCode = 1;
  } catch (error) {
    console.error('Qualification error:', error.message);
    process.exitCode = 1;
  }
}
