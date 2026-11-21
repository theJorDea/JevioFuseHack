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
  assert.match(result.caseSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result, { caseSha256: result.caseSha256, taskId: 'cognee-data-receipt', snapshotHash: baseHash,
    base: { snapshotHash: baseHash, failToPass: 'FAIL', passToPass: 'PASS' },
    gold: { snapshotHash: goldHash, failToPass: 'PASS', passToPass: 'PASS' }, qualified: true });
  const { stdout } = await node(process.execPath, [cli], { cwd: tmpdir() });
  assert.deepEqual(JSON.parse(stdout), result);
});

test('the full catalog reproduces all historical failures and preserves their controls', async () => {
  const { stdout } = await node(process.execPath, [cli, '--all'], { cwd: tmpdir() });
  const suite = JSON.parse(stdout);
  assert.equal(suite.qualified, true);
  assert.deepEqual(suite.cases.map(c => c.taskId), ['cognee-data-receipt', 'kimi-temperature', 'task-intent-questions', 'web-reload-busy', 'text-tool-line-continuation', 'node-test-isolation-flag', 'session-picker-focus', 'lmstudio-tool-default', 'provider-stream-recovery', 'idle-loader-status']);
  for (const c of suite.cases) {
    assert.match(c.caseSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(c.base.snapshotHash, c.gold.snapshotHash);
    assert.deepEqual([c.base.failToPass,c.gold.failToPass,c.base.passToPass,c.gold.passToPass], ['FAIL','PASS','PASS','PASS']);
  }
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
  await assert.rejects(node(process.execPath, [cli, '--patch', 'x']), /no arguments or --all/);
});
