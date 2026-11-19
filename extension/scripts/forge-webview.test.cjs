const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../media/forge.js'),'utf8'),css=fs.readFileSync(path.join(__dirname,'../media/forge.css'),'utf8');
function fixture(){
 class Node {constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.value='';this.checked=false;this.attributes={};this.className='';this.textContent='';this.scrollHeight=0;this.scrollTop=0;this.clientHeight=0;}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,v){this.listeners[k]=v;}click(){this.listeners.click?.({});}focus(){}remove(){}get lastChild(){return this.children.at(-1);}querySelector(q){return find(this,q)[0]??null;}}
 const root=new Node('main'),sent=[],handlers={},saved={};let raf=0,queue=new Map();
 function find(node,q){let result=[];if(q.startsWith('.')?node.className?.split(' ').includes(q.slice(1)):node.tag===q)result.push(node);for(const child of node.children||[])if(child&&typeof child==='object')result=result.concat(find(child,q));return result;}
 const doc={getElementById:()=>root,createElement:tag=>new Node(tag),createTextNode:text=>({tag:'#text',textContent:String(text),children:[]}),querySelector:q=>find(root,q)[0]??null};
 const context={document:doc,window:{addEventListener:(k,v)=>handlers[k]=v},acquireVsCodeApi:()=>({postMessage:m=>sent.push(m),getState:()=>saved,setState:x=>Object.assign(saved,x)}),requestAnimationFrame:fn=>{queue.set(++raf,fn);return raf;},cancelAnimationFrame:id=>queue.delete(id),console};
 vm.runInNewContext(source,context);const emit=data=>handlers.message({data});const flush=()=>{for(const fn of queue.values())fn();queue.clear();};return {root,sent,emit,find,flush};
}
const state={type:'state',runs:[],current:undefined,workspace:'Flask',taskExample:'task text',models:['google-gemini/gemini-3-5-flash-lite']};
test('webview initializes with theme tokens and sends selected model and exact task',()=>{
 const f=fixture();assert.equal(f.sent[0].type,'ready');f.emit(state);
 assert.match(css,/--vscode-sideBar-background/);assert.match(css,/--vscode-foreground/);assert.match(css,/--vscode-focusBorder/);
 const area=f.find(f.root,'textarea')[0];area.value='Add a feature';f.find(f.root,'button').find(b=>b.textContent==='Send').click();
 assert.equal(f.sent.at(-1).type,'start');assert.equal(f.sent.at(-1).task,'Add a feature');assert.equal(f.sent.at(-1).model,state.models[0]);
});
test('webview streams safely, retains late delta before activity and correlates review/stop',()=>{
 const f=fixture();f.emit({...state,current:'r',runs:[{id:'r',task:'task',model:state.models[0],status:'running',events:[]}]});
 f.emit({type:'event',runId:'other',event:{type:'delta',text:'wrong'}});
 f.emit({type:'event',runId:'r',event:{type:'delta',text:'Hello <img src=x> **bold**'}});
 f.emit({type:'event',runId:'r',event:{type:'tool.start',name:'read_file'}});f.emit({type:'event',runId:'r',event:{type:'context',file:'src/a.py',reason:'relevant'}});f.flush();
 assert.equal(f.find(f.root,'details').length,1);assert.match(f.find(f.root,'summary')[0].textContent,/Working.*2 steps/);
 assert.equal(f.find(f.root,'img').length,0);assert.equal(f.find(f.root,'strong').some(n=>n.textContent==='bold'),true);
 f.emit({type:'review',runId:'r',digest:'abc',hunks:[{index:0,path:'a.py',line:2}]});
 f.find(f.root,'button').find(b=>b.textContent==='Approve selected').click();assert.equal(f.sent.at(-1).type,'decision');assert.equal(f.sent.at(-1).digest,'abc');assert.equal(f.sent.at(-1).indices[0],0);
 f.find(f.root,'button').find(b=>b.textContent==='Stop').click();assert.equal(f.sent.at(-1).runId,'r');assert.equal(f.sent.at(-1).type,'stop');
});
