import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !['target', 'control'].includes(mode)) throw new Error('Expected target or control');
const { isImplementationRequest } = await import(pathToFileURL(resolve('src/task-intent.ts')).href);
const prompt = mode === 'target'
  ? 'How does the app build the navigation menu?'
  : 'Build the navigation menu.';
const actual = isImplementationRequest(prompt);
if (typeof actual !== 'boolean') throw new Error('Expected a boolean classification');
process.stdout.write(JSON.stringify(actual === (mode === 'control') ? 'PASS' : 'FAIL'));
