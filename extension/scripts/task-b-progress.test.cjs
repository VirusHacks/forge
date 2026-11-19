const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {RepositoryContext}=require('../out/src/taskBContext.js');
const {TaskBTools}=require('../out/src/taskBTools.js');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-progress-')),base=path.join(dir,'base'),root=path.join(dir,'work');fs.mkdirSync(base);
 const git=(...a)=>execFileSync('git',['-C',base,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git('init','-q');
 for(const [name,content] of Object.entries({'src/cli.py':'# cli commands\n'+'# filler\n'.repeat(30)+'registry.add_command(inspect_command)\ndef inspect_command():\n    return settings\n','tests/test_cli.py':'def test_inspect_command():\n    assert True\n','docs/cli.rst':'CLI commands\n============\nInspect settings.\n'})){const f=path.join(base,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,content);}
 git('add','.');git('-c','user.name=test','-c','user.email=test@example.invalid','commit','-qm','test');const ref=git('rev-parse','HEAD');git('worktree','add','--detach',root,ref);return {dir,root,ref};
}
test('investigator returns versioned, exact implementation-ready excerpts',async()=>{
 const f=fixture();let server,client;try{
 const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const res=await client.callTool({name:'investigate_repository',arguments:{goal:'Add a CLI command inspect that prints settings, covered by a test and documented.'}});assert.equal(res.isError,undefined);
 const data=JSON.parse(res.content[0].text);assert.equal(data.readyForPatch,true);
 for(const role of ['implementation','test','documentation']){const x=data[role][0];assert.match(x.sourceHash,/^[a-f0-9]{64}$/);assert.ok(x.ranges.length>0);for(const range of x.ranges){assert.ok(range.first>0);assert.ok(fs.readFileSync(path.join(f.root,x.path),'utf8').includes(range.text));}}
 assert.ok(data.implementation[0].ranges.some(x=>x.text.includes('add_command')));
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('repeated exact and contained reads summarize evidence; changed source is fresh',()=>{
 const f=fixture();try{const r=new RepositoryContext(f.root,3000,()=>{},f.ref);
 assert.match(r.read('src/cli.py',30,undefined,5,'first'),/add_command/);
 assert.match(r.read('src/cli.py',31,undefined,2,'overlap'),/already (?:read|supplied)/i);
 fs.appendFileSync(path.join(f.root,'src/cli.py'),'# changed\n');
 assert.match(r.read('src/cli.py',31,undefined,2,'changed'),/add_command/);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('repeated searches reuse evidence but invalidate when tracked source changes',()=>{
 const f=fixture();try{const r=new RepositoryContext(f.root,3000,()=>{},f.ref);assert.match(r.search(['inspect_command']),/src\/cli.py/);
 assert.match(r.search(['inspect_command']),/already searched/i);
 fs.appendFileSync(path.join(f.root,'tests/test_cli.py'),'\n# inspect_command new evidence\n');
 assert.doesNotMatch(r.search(['inspect_command']),/already searched/i);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('live runner honors configured iteration limit and bounded explicit override',()=>{
 const {iterationLimit}=require('./task-b-options.cjs');
 assert.equal(iterationLimit(undefined,37),37);assert.equal(iterationLimit('42',37),42);
 assert.throws(()=>iterationLimit('0',24),/iteration limit/i);assert.throws(()=>iterationLimit('oops',24),/iteration limit/i);
});
test('checkpoint stores versioned evidence and reports proposal stage after restore',async()=>{
 const f=fixture();try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal,0,undefined,'task');
 repo.read('src/cli.py',31,undefined,3,'inspect');const snap=tools.snapshot();assert.equal(snap.currentStage,'discovery');assert.match(snap.evidence[0].sourceHash,/^[a-f0-9]{64}$/);
 const checkpoint=tools.checkpoint();const resumedRepo=new RepositoryContext(f.root,3000,()=>{},f.ref);const resumed=new TaskBTools(resumedRepo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal,0,undefined,'task',checkpoint);assert.equal(resumed.snapshot().evidence[0].sourceHash,snap.evidence[0].sourceHash);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('investigator consults symbol index only when direct implementation navigation is missing',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);let calls=0;
 tools.graph=()=>({find:async()=>{calls++;return {hits:[{id:'sym',name:'inspect_command',file:'src/cli.py',line:33}]};},context:async()=>({excerpt:repo.read('src/cli.py',32,undefined,3,'symbol'),symbol:{name:'inspect_command'}})});
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const response=await client.callTool({name:'investigate_repository',arguments:{goal:'settings'}});const result=JSON.parse(response.content[0].text);assert.equal(calls,1);assert.equal(result.implementation[0].symbol.name,'inspect_command');
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('investigator fits a small response budget as valid JSON without losing role paths',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal,0,undefined,'task',undefined,1000);
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const response=await client.callTool({name:'investigate_repository',arguments:{goal:'Add a CLI command inspect that prints settings, covered by a test and documented.'}});assert.equal(response.isError,undefined);assert.ok(response.content[0].text.length<=1000);const result=JSON.parse(response.content[0].text);for(const role of ['implementation','test','documentation'])assert.ok(result[role][0].path);const visible=Object.values(result).filter(Array.isArray).flat().flatMap(x=>x?.ranges??[]).map(r=>r.text);for(const blocks of repo.observed.values())for(const block of blocks)assert.ok(visible.includes(block),'only delivered evidence may authorize an edit');
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
