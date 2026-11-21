// Synthetic, offline example; never opens the user's Claude storage.
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../bin/jevio.mjs', import.meta.url));
const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'jevio-demo-')));
try {
  execFileSync('git', ['init', '-q'], { cwd });
  const row = (uuid, parentUuid, role, content, extra = {}) => ({ uuid, parentUuid, cwd, sessionId: 'demo', type: role, message: { role, content }, ...extra });
  const records = [
    row('u1', null, 'user', 'Fix the failing concurrent refresh test.'),
    row('a1', 'u1', 'assistant', [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'npm test' } }]),
    row('u2', 'a1', 'user', [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'private test output' }], { toolUseResult: { exitCode: 1 } }),
    row('a2', 'u2', 'assistant', [{ type: 'tool_use', name: 'Edit', id: 't2', input: { file_path: 'refresh.js' } }]),
    row('u3', 'a2', 'user', [{ type: 'tool_result', tool_use_id: 't2', is_error: false, content: 'private edit result' }]),
  ];
  const transcript = path.join(cwd, '.git', 'synthetic.jsonl');
  await writeFile(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n{"type":');
  await writeFile(path.join(cwd, 'refresh.js'), '// synthetic change\n');
  execFileSync(process.execPath, [cli, 'handoff', '--transcript', transcript], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
} finally { await rm(cwd, { recursive: true, force: true }); }
