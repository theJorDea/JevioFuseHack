import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const mode = process.argv[2];
if (!['target', 'control'].includes(mode)) throw Error('Unknown check');
const bytes = await readFile('src/interactive-tui.ts');
// Only these two historical blobs may supply code, never a candidate or dependency.
if (![
  '7d712b276ef82863ca77b02b9be2a5cf14d5c94adda09f3d8c14e99ba9234242',
  'e9697c8efd1471a8fe56b797be1e7f6f9c52aae0133273d82ee048adc398dcef',
].includes(createHash('sha256').update(bytes).digest('hex'))) throw Error('Unpinned snapshot');
const source = bytes.toString('utf8');
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing historical excerpt');
  return source.slice(a, b);
}
const init = between('    this.loader = new Loader(', '\n');
const run = between('  async run():', '\n  setTodos(');
const submit = between('  private async handleSubmit(', '\n  private async showSessionPicker(');
// pi-tui keeps its displayed frame on stop; setting an indicator restarts it.
// Sample frame zero rather than running a real animation timer.
class Loader {
  constructor(ui, spinnerColor, messageColor, message, indicator) {
    this.message = message;
    this.setIndicator(indicator);
  }
  setIndicator({ frames }) { this.frames = frames; this.start(); }
  start() { this.animating = this.frames.length > 1; }
  stop() { this.animating = false; }
  setMessage(message) { this.message = message; }
  get text() { return (this.frames.length ? this.frames[0] + ' ' : '') + this.message; }
}
const identity = x => x;
const Klass = vm.runInNewContext(stripTypeScriptTypes(`(class {
  constructor() { ${init} }
  ${run}
  ${submit}
})`), { Loader, cyan: identity, dim: identity, red: identity });
const view = new Klass();
const noop = () => {};
let finish;
view.options = { getSession: () => ({ messageCount: 1 }), submit: () => new Promise(r => { finish = r; }) };
view.tui = { start: noop, requestRender: noop, setFocus: noop };
view.editor = { addToHistory: noop, setText: noop };
view.appendMessage = view.refreshHeader = noop;
view.setStatus = text => { view.status = text; };
const idle = () => view.status === 'Готово' && view.loader.text === '' && !view.loader.animating;
const running = view.run();
const startup = idle();
const submitting = view.handleSubmit('hello');
const busy = view.status === 'Работаю...' && view.loader.text === '- Размышляю...' && view.loader.animating;
finish({ output: 'answer' });
await submitting;
view.resolveExit();
await running;
const pass = mode === 'target' ? startup && idle() : busy;
console.log(JSON.stringify(pass ? 'PASS' : 'FAIL'));
