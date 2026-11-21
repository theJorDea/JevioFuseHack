import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Explicit trusted catalog: no paths, dynamically discovered modules or candidate patches from CLI.
const ids = ['cognee-data-receipt', 'kimi-temperature', 'task-intent-questions', 'web-reload-busy', 'text-tool-line-continuation', 'node-test-isolation-flag', 'session-picker-focus', 'lmstudio-tool-default', 'provider-stream-recovery', 'idle-loader-status'];
const run = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function pinned(folder, name, hash) {
  if (!/^[\w.-]+$/.test(name)) throw new Error('Invalid fixture name');
  const bytes = await readFile(new URL(name, folder));
  if (sha256(bytes) !== hash) throw new Error(`Fixture digest mismatch: ${name}`);
  return bytes;
}
async function observe(folder, spec, edition) {
  const root = await mkdtemp(path.join(tmpdir(), 'jevio-eval-'));
  try {
    const snapshot = path.join(root, 'snapshot'), oracle = path.join(root, 'held-out');
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    await mkdir(snapshot); await mkdir(oracle);
    const files = spec.files[edition];
    for (const [relative, name, hash] of files) {
      if (!relative.split('/').every(segment => /^[\w-][\w.-]*$/.test(segment))) throw new Error('Invalid snapshot path');
      const dest = path.join(snapshot, relative);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, await pinned(folder, name, hash), { flag: 'wx' });
    }
    const script = path.join(oracle, 'probe.mjs');
    await writeFile(script, await pinned(folder, 'probe.mjs', spec.probeSha256));
    const check = async kind => {
      const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
      const { stdout } = await run(process.execPath, [script, kind], { cwd: snapshot, env, timeout: 6000, maxBuffer: 32768, windowsHide: true });
      const result = JSON.parse(stdout);
      if (!['PASS','FAIL'].includes(result)) throw new Error('Invalid trusted probe output');
      return result;
    };
    return { snapshotHash: sha256(JSON.stringify(files.map(([p,,h]) => [p,h]))), failToPass: await check('target'), passToPass: await check('control') };
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function qualify(id) {
  const folder = new URL(`../benchmark/evaluation/${id}/`, import.meta.url);
  const { default: spec } = await import(new URL('case.mjs',folder));
  if (spec.id !== id || !spec.task?.trim()) throw new Error('Case descriptor mismatch');
  const base = await observe(folder, spec, 'base'), gold = await observe(folder, spec, 'gold');
  const caseSha256 = sha256(JSON.stringify([id,spec.task,base.snapshotHash,gold.snapshotHash,spec.probeSha256]));
  return { taskId:id, caseSha256, snapshotHash:base.snapshotHash, base, gold,
    qualified: base.failToPass === 'FAIL' && gold.failToPass === 'PASS' && base.passToPass === 'PASS' && gold.passToPass === 'PASS' };
}
// Kept for the single-case demo. The suite is for curated historical code, not an execution sandbox.
export const qualifyDemo = () => qualify(ids[0]);
export function qualifyCase(id) {
  if (!ids.includes(id)) throw new Error('Unknown historical task');
  return qualify(id);
}
export async function qualifySuite() {
  const cases = [];
  for (const id of ids) cases.push(await qualify(id));
  return { schema:'jevio-eval-suite/v1', qualified:cases.every(c=>c.qualified), cases };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 1 && args[0] === '--all')) throw new Error('Use no arguments or --all');
    const result = args.length ? await qualifySuite() : await qualifyDemo();
    console.log(JSON.stringify(result,null,2)); if (!result.qualified) process.exitCode = 1;
  } catch (error) { console.error('Qualification error:',error.message); process.exitCode = 1; }
}
