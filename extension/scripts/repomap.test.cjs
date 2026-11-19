const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {RepositoryContext}=require('../out/src/taskBContext.js'),{RepoMapIndex}=require('../out/src/repoMap.js'),{TaskBTools}=require('../out/src/taskBTools.js'),{WorkspaceMcpServer}=require('../out/src/workspaceMcp.js');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
function fixture(code='def alpha():\n    return 1\n\ndef caller():\n    return alpha()\n'){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-map-test-')),src=path.join(dir,'src'),root=path.join(dir,'work');fs.mkdirSync(src);const git=(...args)=>execFileSync('git',['-C',src,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git('init','-q');fs.mkdirSync(path.join(src,'app'));fs.mkdirSync(path.join(src,'tests'));fs.mkdirSync(path.join(src,'secrets'));fs.writeFileSync(path.join(src,'app/code.py'),code);fs.writeFileSync(path.join(src,'tests/test_code.py'),'from app.code import alpha\ndef test_alpha():\n    assert alpha() == 1\n');fs.writeFileSync(path.join(src,'secrets/hidden.py'),'def sensitive_unsearchable():\n    return 1\n');fs.writeFileSync(path.join(src,'.repomapignore'),'app/ignored.py\n');fs.writeFileSync(path.join(src,'app/ignored.py'),'def ignored_unique_symbol():\n    pass\n');git('add','.');git('-c','user.name=test','-c','user.email=test@example.invalid','commit','-qm','fixture');const ref=git('rev-parse','HEAD');git('worktree','add','--detach',root,ref);return {dir,root,ref};}

test('RepoMap reuses process, rejects stale IDs, refreshes changed sources and excludes sensitive paths',async()=>{
 const f=fixture();let index;try{const repo=new RepositoryContext(f.root,10000,()=>{},f.ref);index=new RepoMapIndex(repo,5);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(index.find('alpha',cancelled.signal));assert.equal(index.stats.generation,0);
  const first=await index.find('alpha');const symbol=first.hits.find(x=>x.name==='alpha');assert.ok(symbol);assert.equal(symbol.file,'app/code.py');assert.equal(symbol.line,1);assert.equal(index.stats.generation,1);
  const context=await index.context(symbol.id);assert.match(context.excerpt,/def alpha/);assert.ok(repo.observed.get('app/code.py').some(x=>x.includes('def alpha')));
  const trace=await index.trace(symbol.id,1);assert.ok(trace.callers.every(x=>x.relation==='statically inferred'));assert.ok(Array.isArray(trace.callees));assert.equal(index.stats.generation,1);
  const hidden=await index.find('sensitive_unsearchable');assert.equal(hidden.hits.some(x=>x.file.includes('secrets/')),false);
  const ignored=await index.find('ignored_unique_symbol');assert.equal(ignored.hits.some(x=>x.name==='ignored_unique_symbol'),false);
  fs.writeFileSync(path.join(f.root,'untracked.py'),'def secret_untracked_symbol():\n    pass\n');const untracked=await index.find('secret_untracked_symbol');assert.equal(untracked.hits.some(x=>x.name==='secret_untracked_symbol'),false);assert.equal(index.stats.generation,1);
  fs.writeFileSync(path.join(f.root,'app/code.py'),'def beta():\n    return 2\n');await assert.rejects(index.context(symbol.id),/stale/);
  const updated=await index.find('beta');assert.ok(updated.hits.some(x=>x.name==='beta'));assert.equal(index.stats.generation,2);
 }finally{await index?.dispose();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('HTTP MCP exposes real symbol tools and disabled RepoMap uses existing safe fallback',async()=>{
 const f=fixture();let server,client,tools,server2,client2,disabled;try{const repo=new RepositoryContext(f.root,10000,()=>{},f.ref);tools=new TaskBTools(repo,async()=>({ok:true,summary:'ok'}),()=>{},new AbortController().signal);server=new WorkspaceMcpServer(0,()=>tools.createServer());client=new Client({name:'integration-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(await server.start(f.root))));
  const advertised=(await client.listTools()).tools.map(t=>t.name);for(const x of ['find_symbols','get_symbol_context','trace_symbol'])assert.ok(advertised.includes(x));
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
  const longQuery='Find alpha and caller in the repository. '.repeat(7);const longResult=await call('find_symbols',{query:longQuery});assert.equal(longResult.source,'repomap');
  const result=await call('find_symbols',{query:'alpha'});assert.equal(result.source,'repomap');const hit=result.hits.find(x=>x.name==='alpha');assert.ok(hit);
  const context=await call('get_symbol_context',{symbol_id:hit.id});assert.match(context.excerpt,/def alpha/);
  const trace=await call('trace_symbol',{symbol_id:hit.id,depth:1});assert.equal(trace.source,'repomap');assert.match(trace.graphCaveat,/inferred/);
  tools.maxToolResultChars=1000;const bounded=await client.callTool({name:'get_symbol_context',arguments:{symbol_id:hit.id}});assert.ok(!bounded.isError);assert.ok(bounded.content[0].text.length<=1000);assert.ok(JSON.parse(bounded.content[0].text).symbol);tools.maxToolResultChars=8000;
  assert.ok(tools.checkpoint().symbols.some(x=>x.name==='alpha'));
  disabled=new TaskBTools(new RepositoryContext(f.root,10000,()=>{},f.ref),async()=>({ok:true,summary:''}),()=>{},new AbortController().signal,0,undefined,'',undefined,8000,{enabled:false});
  server2=new WorkspaceMcpServer(0,()=>disabled.createServer());client2=new Client({name:'fallback-test',version:'1'});await client2.connect(new StreamableHTTPClientTransport(new URL(await server2.start(f.root))));
  const fallback=await client2.callTool({name:'find_symbols',arguments:{query:'alpha'}});assert.equal(JSON.parse(fallback.content[0].text).source,'fallback');
  const read=await client2.callTool({name:'get_symbol_context',arguments:{symbol_id:hit.id}});assert.match(JSON.parse(read.content[0].text).excerpt,/def alpha/);
  const traceFallback=await client2.callTool({name:'trace_symbol',arguments:{symbol_id:hit.id,depth:1}});assert.deepEqual(JSON.parse(traceFallback.content[0].text).relationships,[]);
  const invalid=await client2.callTool({name:'trace_symbol',arguments:{symbol_id:'../secret:1#000000000000'}});assert.equal(invalid.isError,true);
 }finally{await client2?.close();await server2?.stop();await disabled?.dispose();await client?.close();await server?.stop();await tools?.dispose();fs.rmSync(f.dir,{recursive:true,force:true});}
});


test('indexes for different workspace roots remain separate',async()=>{
 const a=fixture(),b=fixture('def unique_other_workspace():\n    return 2\n');let ia,ib;
 try{ia=new RepoMapIndex(new RepositoryContext(a.root,5000,()=>{},a.ref));ib=new RepoMapIndex(new RepositoryContext(b.root,5000,()=>{},b.ref));
 const [one,two]=await Promise.all([ia.find('unique_other_workspace'),ib.find('unique_other_workspace')]);
 assert.ok(!one.hits.some(x=>x.name==='unique_other_workspace'));assert.ok(two.hits.some(x=>x.name==='unique_other_workspace'));
 }finally{await ia?.dispose();await ib?.dispose();fs.rmSync(a.dir,{recursive:true,force:true});fs.rmSync(b.dir,{recursive:true,force:true});}
});
