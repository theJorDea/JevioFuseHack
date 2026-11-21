import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { qualifyDemo } from '../scripts/eval-qualify.mjs';

const node = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/eval-qualify.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../benchmark/evaluation/cognee-data-receipt/', import.meta.url));
const baseHash = '9dac7c92af4d2fc1c927fa3d2bb11de3aa04fe65f70116ec0adb74fa5c383b1e';
const goldHash = '9cb7ee578ac812adaecdea5c61d0906eee3e5f8db837d5282aeabafa3dfe9f5b';

test('pinned historical bug fails only on base; unchanged behavior passes both revisions', async () => {
  const result = await qualifyDemo();
  assert.deepEqual(result, { taskId: 'cognee-data-receipt', snapshotHash: baseHash,
    base: { snapshotHash: baseHash, failToPass: 'FAIL', passToPass: 'PASS' },
    gold: { snapshotHash: goldHash, failToPass: 'PASS', passToPass: 'PASS' }, qualified: true });
  const { stdout } = await node(process.execPath, [cli], { cwd: tmpdir() });
  assert.deepEqual(JSON.parse(stdout), result);
});

test('altered bytes refuse execution; qualification has no arbitrary source option', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'qualify-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = path.join(root, 'scripts', 'eval-qualify.mjs');
  await mkdir(path.dirname(copy));
  await cp(cli, copy);
  const fixtures = path.join(root, 'benchmark', 'evaluation', 'cognee-data-receipt');
  await cp(fixture, fixtures, { recursive: true });
  await writeFile(path.join(fixtures, 'base-memory.ts.fixture'), '// changed\n', { flag: 'a' });
  await assert.rejects(node(process.execPath, [copy]), /Fixture digest mismatch: base-memory/);
  await assert.rejects(node(process.execPath, [cli, '--patch', 'x']), /takes no arguments/);
});
