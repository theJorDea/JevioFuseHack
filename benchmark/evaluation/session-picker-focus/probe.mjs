import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
const mode=process.argv[2];
if(!['target','control'].includes(mode))throw Error('Unknown check');
const method=await readFile('src/picker-method.ts','utf8');
// Trusted historical excerpt only. This context supplies view doubles; it is not an untrusted code sandbox.
const overlay={children:[],addChild(item){this.children.push(item)}};
class SelectList{constructor(items){this.items=items}}
const Klass=vm.runInNewContext(stripTypeScriptTypes(`(class {\n${method}\n})`),{SelectList,selectTheme:{},modalSurface:()=>overlay,Text:class{},boldCyan:x=>x,dim:x=>x});
const picker=new Klass(),editor={},sessions=mode==='target'?[{id:'session-1',title:'First',updatedAt:'2026-07-10T00:00:00Z'}]:[];
let focus=editor,visible=false,messages=[];
picker.editor=editor;picker.options={listSessions:async()=>sessions};picker.appendMessage=(...args)=>messages.push(args.slice(0,2));
picker.tui={showOverlay(){visible=true;return {hide(){visible=false}}},setFocus(x){focus=x}};
await picker.showSessionPicker();
let pass;
if(mode==='control')pass=!visible&&focus===editor&&messages.length===1&&messages[0][0]==='fuse'&&messages[0][1]==='No saved sessions in this workspace.';
else {
 const list=overlay.children.at(-1);
 if(!visible||!(list instanceof SelectList)||list.items[0].value!=='session-1')throw Error('Unexpected picker state');
 const focused=focus===list; list.onCancel();
 pass=focused&&!visible&&focus===editor;
}
console.log(JSON.stringify(pass?'PASS':'FAIL'));
