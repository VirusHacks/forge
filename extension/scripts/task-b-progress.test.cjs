const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {RepositoryContext}=require('../out/src/taskBContext.js');
const {TaskBTools}=require('../out/src/taskBTools.js');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
function fixture(extra=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-progress-')),base=path.join(dir,'base'),root=path.join(dir,'work');fs.mkdirSync(base);
 const git=(...a)=>execFileSync('git',['-C',base,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git('init','-q');
 for(const [name,content] of Object.entries({'src/cli.py':(extra?'import os\n'+'# preface\n'.repeat(60):'')+'# cli commands\n'+'# filler\n'.repeat(30)+'registry.add_command(inspect_command)\ndef inspect_command():\n    return settings\n','tests/test_cli.py':'def test_inspect_command():\n    assert True\n','docs/cli.rst':'CLI commands\n============\nInspect settings.\n'})){const f=path.join(base,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,content);}
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
test('stage_patch atomically stages several observed files with actionable errors',async()=>{
 const f=fixture();let server,client;try{
  const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);
  const edits=[{path:'src/cli.py',original:'# cli commands',replacement:'# cli commands updated'},{path:'tests/test_cli.py',original:'def test_inspect_command():',replacement:'def test_inspect_command_changed():'},{path:'docs/cli.rst',original:'CLI commands',replacement:'CLI command guide'}];
  for(const e of edits)repo.read(e.path,1,undefined,2,'observe anchor');
  const before=edits.map(e=>repo.source(e.path));server=tools.createServer();client=new Client({name:'stage-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  let r=await client.callTool({name:'stage_patch',arguments:{edits:[edits[0],{...edits[1],original:'not in file'},edits[2]]}});assert.equal(r.isError,true);assert.equal(tools.staged.length,0);assert.match(r.content[0].text,/tests\/test_cli.py/);
  r=await client.callTool({name:'stage_patch',arguments:{edits}});assert.equal(r.isError,undefined);assert.equal(tools.staged.length,3);assert.deepEqual(edits.map(e=>repo.source(e.path)),before);
  const stale=await client.callTool({name:'stage_patch',arguments:{edits:[{...edits[0],original:'missing'}]}});assert.equal(stale.isError,true);assert.equal(tools.staged.length,3);
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('TrueForge iteration configuration accepts its supported maximum',()=>{
 const {iterationLimit}=require('./task-b-options.cjs');assert.equal(iterationLimit(undefined,1024),1024);assert.equal(iterationLimit('1024',24),1024);assert.throws(()=>iterationLimit('1025',24),/iteration limit/i);
});
test('large read requests return bounded content instead of schema errors',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref,{maxReadLines:10}),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const response=await client.callTool({name:'read_file',arguments:{path:'src/cli.py',start:1,lines:60}});assert.equal(response.isError,undefined);assert.match(response.content[0].text,/limited to 10 lines/i);
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('investigator includes import and relevant test evidence when present',async()=>{
 const f=fixture(true);let server,client;try{const repo=new RepositoryContext(f.root,3500,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const response=await client.callTool({name:'investigate_repository',arguments:{goal:'Add a CLI command inspect that prints settings, covered by a test and documented.'}});const result=JSON.parse(response.content[0].text);
 assert.ok(result.implementation[0].ranges.some(r=>r.text.includes('import os')));assert.ok(result.test[0].ranges.some(r=>r.text.includes('def test_inspect')));
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('repeated investigation reports lack of new evidence and suggests the next action',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,5000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const args={goal:'Add a CLI command inspect that prints settings, covered by a test and documented.'};await client.callTool({name:'investigate_repository',arguments:args});
 const again=await client.callTool({name:'investigate_repository',arguments:{goal:'Add a CLI command inspect that prints settings, covered by tests and documentation.'}});const result=JSON.parse(again.content[0].text);assert.equal(result.progress,'no_new_evidence');assert.match(result.guidance,/stage_patch/);assert.ok(tools.snapshot().repeatedCalls>=1);
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('live probe can explicitly disable fallback without relying on empty environment variables',()=>{
 const {fallbackModels}=require('./task-b-options.cjs');assert.deepEqual(fallbackModels('none'),[]);assert.deepEqual(fallbackModels('groq/example,google/example'),['groq/example','google/example']);
});
test('stage_patch accepts an anchor covered by overlapping observed source ranges',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);
 const original=repo.source('src/cli.py').trimEnd();repo.read('src/cli.py',1,undefined,20,'first');repo.read('src/cli.py',15,undefined,25,'second');
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const response=await client.callTool({name:'stage_patch',arguments:{edits:[{path:'src/cli.py',original,replacement:original+'\n# changed'}]}});assert.equal(response.isError,undefined,response.content[0].text);assert.equal(tools.staged.length,1);
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('overlapping evidence never authorizes unseen gaps or ambiguous blocks',()=>{
 const {isObservedAnchor}=require('../out/src/taskBContext.js');const source='prefix\none\ntwo\nthree\nfour\nsuffix';const anchor='one\ntwo\nthree\nfour';
 assert.equal(isObservedAnchor(source,['prefix\none\ntwo','two\nthree\nfour\nsuffix'],anchor),true);
 assert.equal(isObservedAnchor(source,['prefix\none','three\nfour\nsuffix'],anchor),false);
 assert.equal(isObservedAnchor('x abc x abc y',['abc',' y'],'abc y'),false);
});
test('live launcher loads an explicit checkpoint and rejects malformed content',()=>{
 const {resumeCheckpoint}=require('./task-b-options.cjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-checkpoint-'));try{
  assert.equal(resumeCheckpoint(undefined),undefined);const file=path.join(dir,'state.json');fs.writeFileSync(file,JSON.stringify({schemaVersion:1,staged:[{path:'x'}]}));assert.deepEqual(resumeCheckpoint(file).staged,[{path:'x'}]);fs.writeFileSync(file,'not json');assert.throws(()=>resumeCheckpoint(file),/checkpoint/i);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('invalid preflight does not consume an isolated verification attempt',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);repo.read('src/cli.py',1,undefined,2,'observe');
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const staged=await client.callTool({name:'stage_patch',arguments:{edits:[{path:'src/cli.py',original:'# cli commands',replacement:'# cli commands updated'}]}});assert.equal(staged.isError,undefined);
 for(let i=0;i<3;i++){const bad=await client.callTool({name:'validate_edits',arguments:{}});assert.equal(bad.isError,true);assert.match(bad.content[0].text,/at least three/);}assert.equal(tools.attempts,0);
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('stage_patch repairs text within an existing staged replacement without writing',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);const before=repo.source('src/cli.py');repo.read('src/cli.py',1,undefined,2,'observe');
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const call=edits=>client.callTool({name:'stage_patch',arguments:{edits}});let r=await call([{path:'src/cli.py',original:'# cli commands',replacement:'# generated\nflag = True'}]);assert.equal(r.isError,undefined);
 r=await call([{path:'src/cli.py',original:'flag = True',replacement:'flag = False'}]);assert.equal(r.isError,undefined,r.content[0].text);assert.equal(tools.staged.length,1);assert.equal(tools.staged[0].replacement,'# generated\nflag = False');assert.equal(repo.source('src/cli.py'),before);
 const detail=await client.callTool({name:'get_run_state',arguments:{stagedIndex:0}});assert.match(detail.content[0].text,/flag = False/);
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('verify_patch checks the already staged multi-file proposal without hunk arguments',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref);let calls=0;const tools=new TaskBTools(repo,async(_,files)=>{calls++;return {ok:Object.keys(files).length===3,summary:'verified'}},()=>{},new AbortController().signal);
 const edits=[{path:'src/cli.py',original:'# cli commands',replacement:'# cli commands updated'},{path:'tests/test_cli.py',original:'def test_inspect_command():',replacement:'def test_inspect_command_changed():'},{path:'docs/cli.rst',original:'CLI commands',replacement:'CLI command guide'}];for(const e of edits)repo.read(e.path,1,undefined,2,'observe');
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 await client.callTool({name:'stage_patch',arguments:{edits}});const response=await client.callTool({name:'verify_patch',arguments:{}});assert.equal(response.isError,undefined,response.content[0].text);assert.equal(JSON.parse(response.content[0].text).ok,true);assert.equal(calls,1);
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('staged repair rejects text that appears multiple times across staged replacements',async()=>{
 const f=fixture();let server,client;try{const repo=new RepositoryContext(f.root,3000,()=>{},f.ref),tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);repo.read('src/cli.py',1,undefined,2,'one');repo.read('src/cli.py',32,undefined,2,'two');
 server=tools.createServer();client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const stage=edits=>client.callTool({name:'stage_patch',arguments:{edits}});const initial=await stage([{path:'src/cli.py',original:'# cli commands',replacement:'# shared shared'},{path:'src/cli.py',original:'registry.add_command(inspect_command)',replacement:'registry.add_command(shared)'}]);assert.equal(initial.isError,undefined,initial.content[0].text);
 const repair=await stage([{path:'src/cli.py',original:'shared',replacement:'changed'}]);assert.equal(repair.isError,true);assert.match(repair.content[0].text,/uniquely/i);assert.equal(tools.staged.length,2);
 }finally{await client?.close();await server?.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});
