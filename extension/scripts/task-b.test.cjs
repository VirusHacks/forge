const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const {RepositoryContext,renderHunks}=require("../out/src/taskBContext.js");
const {TaskBTools}=require("../out/src/taskBTools.js");
const {WorkspaceMcpServer}=require("../out/src/workspaceMcp.js");
const {Client}=require("@modelcontextprotocol/sdk/client/index.js");
const {StreamableHTTPClientTransport}=require("@modelcontextprotocol/sdk/client/streamableHttp.js");

test("multi-file rendering anchors are exact, unique, disjoint, and literal",()=>{
 const h=(a,b)=>({path:"x",original:a,replacement:b});
 assert.equal(renderHunks("foo and bar",[h("foo","$&"),h("bar","$1")]),"$& and $1");
 for(const edits of [[h("absent","!")],[h("foo","foo")],[h("foo","A"),h("oo","B")]])
   assert.throws(()=>renderHunks("foo",edits));
 assert.throws(()=>renderHunks("aaaa",[h("aaa","X")]));
});

test("investigation ranks implementation, test, and documentation from a generic feature request",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"forge-b-investigate-"));
 const src=path.join(dir,"src"),root=path.join(dir,"work");fs.mkdirSync(src);
 const git=(...args)=>execFileSync("git",["-C",src,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 try{
  git("init","-q");fs.mkdirSync(path.join(src,"src"));fs.mkdirSync(path.join(src,"tests"));fs.mkdirSync(path.join(src,"docs"));
  fs.writeFileSync(path.join(src,"src/cli.py"),"# CLI command registry\n"+"# filler\n".repeat(80)+"registry.add_command(inspect_command)\ndef inspect_command():\n    return settings\n");
  fs.writeFileSync(path.join(src,"src/settings.py"),"settings = {'PUBLIC': 1}\n");
  fs.writeFileSync(path.join(src,"tests/test_cli.py"),"def test_inspect_command():\n    assert True\n");
  fs.writeFileSync(path.join(src,"docs/cli.rst"),"CLI Commands\n============\nInspect settings as JSON.\n");
  fs.writeFileSync(path.join(src,"README.md"),"A package with commands and settings.\n");
  git("add",".");git("-c","user.name=test","-c","user.email=test@example.invalid","commit","-qm","fixture");
  const ref=git("rev-parse","HEAD");git("worktree","add","--detach",root,ref);
  const log=[];const repo=new RepositoryContext(root,500,e=>log.push(e),ref);
  const found=repo.investigate("Add a CLI command inspect that prints settings as JSON, covered by a test and documented.");
  assert.equal(found.implementation[0].path,"src/cli.py");
  assert.equal(repo.lastReadFile,"src/cli.py");
  assert.equal(found.test[0].path,"tests/test_cli.py");
  assert.equal(found.documentation[0].path,"docs/cli.rst");
  assert.ok(Object.values(found).flat().every(x=>x.reason&&x.excerpt));
  repo.read("src/cli.py",1,undefined,10,"first page");
  assert.match(repo.read("src/cli.py",1,undefined,10,"repeat"),/already read/);
  assert.match(repo.read("src/cli.py",undefined,undefined,10,"continue"),/add_command/);
  assert.ok(log.some(x=>x.type==="context.evidence_jump"));
  assert.ok(repo.used<=500);assert.equal(repo.discovered.size,3);
  assert.ok(log.some(x=>x.type==="context.investigation"));
  const guiRepo=new RepositoryContext(root,500,e=>log.push(e),ref);
  const originalPath=process.env.PATH;
  try {
    process.env.PATH="/nonexistent-for-forge-test";
    const guiResult=guiRepo.investigate("Add a CLI command inspect that prints settings as JSON, covered by a test and documented.");
    assert.equal(guiResult.implementation[0].path,"src/cli.py");
    assert.equal(guiResult.test[0].path,"tests/test_cli.py");
    assert.equal(guiResult.documentation[0].path,"docs/cli.rst");
    assert.match(guiRepo.search(["registry"]),/src\/cli.py/);
    assert.ok(log.some(x=>x.type==="search.fallback"));
  } finally {process.env.PATH=originalPath;}

  const constrained=new RepositoryContext(root,500,()=>{},ref,{searchResultLimit:1,maxReadLines:1});
  assert.equal(constrained.maxReadLines,1);
  const boundedSearch=constrained.search(["registry"]);
  assert.equal((boundedSearch.match(/(?:src\/cli\.py|tests\/test_cli\.py|src\/settings\.py|docs\/cli\.rst):/g)||[]).length,1);
  const boundedRead=constrained.read("src/cli.py",1,undefined,8,"configured line limit");
  assert.doesNotMatch(boundedRead,/filler/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("budgeted discovery, proposal validation, repair limit, and review gate over real MCP",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"forge-b-tools-"));
 const src=path.join(dir,"src"),root=path.join(dir,"work");
 fs.mkdirSync(src);
 const git=(...args)=>execFileSync("git",["-C",src,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 let server,client;
 try{
  git("init","-q");
  const paths=["alpha.txt","beta.txt","gamma.txt"];
  for(const f of paths)fs.writeFileSync(path.join(src,f),"lookup ABC\n"+f+" common\n");
  fs.mkdirSync(path.join(src,"docs"));fs.writeFileSync(path.join(src,"docs/guide.txt"),"guide\n");
  fs.writeFileSync(path.join(src,".env"),"hidden");
  git("add",".");git("-c","user.name=test","-c","user.email=test@example.invalid","commit","-qm","fixture");
  const ref=git("rev-parse","HEAD");git("worktree","add","--detach",root,ref);
  const log=[];
  const context=new RepositoryContext(root,150,e=>log.push(e),ref);
  context.search(["lookup"]);assert.equal(context.discovered.size,3);
  assert.throws(()=>context.source("../src/alpha.txt"));assert.throws(()=>context.source(".env"));
  const verify=async(_,files)=>({ok:Object.keys(files).length===3&&files["alpha.txt"].includes("changed"),summary:"fixture verifier"});
  const t=new TaskBTools(context,verify,()=>{},new AbortController().signal);
  server=new WorkspaceMcpServer(0,()=>t.createServer());
  client=new Client({name:"test",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(await server.start(root))));
  const call=(name,args)=>client.callTool({name,arguments:args});
  assert.equal((await call("read_file",{path:"alpha.txt",start:1,lines:1})).isError,undefined);
  assert.match((await call("read_file",{start:2,lines:1})).content[0].text,/alpha.txt common/);
  assert.equal((await call("search_repository",{query:"lookup"})).isError,undefined);
  assert.equal((await call("search_repository",{})).isError,true);
  assert.equal((await call("investigate-repository",{goal:"Find lookup implementation tests and documentation"})).isError,undefined);
  const rootListing=(await call("search_directory",{path:""})).content[0].text;
  assert.match(rootListing,/docs\//);assert.doesNotMatch(rootListing,/docs\/guide.txt/);
  assert.match((await call("search_directory",{path:"docs"})).content[0].text,/docs\/guide.txt/);
  const hunks=paths.map(f=>({path:f,original:"lookup ABC",replacement:"changed"}));
  assert.equal((await call("stage_edit",{...hunks[2],original:"unseen"})).isError,true);
  for(const h of [{...hunks[0],replacement:"wrong"},...hunks.slice(1)])assert.ok(!(await call("stage_edit",h)).isError);
  assert.equal(t.staged.length,3);
  assert.equal(JSON.parse((await call("validate_edits",{})).content[0].text).ok,false);
  assert.equal((await call("validate_edits",{})).isError,true);
  assert.equal(t.attempts,1);
  context.resetForNewModel();
  const state=JSON.parse((await call("get_run_state",{})).content[0].text);
  assert.equal(state.staged.length,3);
  assert.equal(state.contextUsed,0);
  assert.equal(state.lastValidation.ok,false);
  assert.equal((await call("stage_edit",hunks[0])).isError,true);
  assert.ok(!(await call("read_file",{path:"alpha.txt",start:1,lines:1})).isError);
  assert.ok(!(await call("stage_edit",hunks[0])).isError);
  assert.equal(JSON.parse((await call("validate_edits",{})).content[0].text).ok,true);
  const checkpoint=t.checkpoint();
  const checkpointFile=path.join(dir,"state","task-b.json");
  const restoredRepo=new RepositoryContext(root,150,()=>{},ref);
  const restored=new TaskBTools(restoredRepo,verify,()=>{},new AbortController().signal,0,checkpointFile,"",checkpoint);
  assert.equal(restored.staged.length,3);
  assert.equal(restored.attempts,t.attempts);
  assert.equal(restored.draft,undefined);
  assert.equal(restored.snapshot().needsValidation,true);
  assert.ok(restored.snapshot().discovered.every(item=>item.path&&item.reason));
  assert.equal(fs.statSync(checkpointFile).mode&0o777,0o600);
  assert.throws(()=>new TaskBTools(new RepositoryContext(root,150,()=>{},ref),verify,()=>{},new AbortController().signal,0,undefined,"",{...checkpoint,root:"/wrong"}),/does not match/);
  assert.equal((await call("submit_review",{digest:t.draft.digest})).isError,true);
  assert.ok(!(await call("validate_edits",{})).isError);
  assert.equal((await call("validate_edits",{})).isError,true);
  assert.equal((await t.validate(hunks.slice(0,2))).ok,false);
  t.sealed=true;t.approved=true;
  assert.ok(!(await call("submit_review",{digest:t.draft.digest})).isError);
  assert.equal(context.source(paths[0]),"lookup ABC\nalpha.txt common\n");
  const paged=new RepositoryContext(root,150,()=>{},ref);
  paged.read(paths[0],1,undefined,1,"page one");
  assert.match(paged.read(paths[0],undefined,undefined,1,"implicit continuation"),/alpha.txt common/);
  assert.match(paged.read(paths[0],undefined,undefined,1,"end"),/End of file/);
  const limited=new RepositoryContext(root,15,()=>{},ref);
  const limitedTools=new TaskBTools(limited,verify,()=>{},new AbortController().signal);
  let budgetStops=0;limitedTools.onContextExhausted=()=>budgetStops++;
  const limitedServer=new WorkspaceMcpServer(0,()=>limitedTools.createServer());
  const limitedClient=new Client({name:"budget-stop",version:"1"});
  try {
    await limitedClient.connect(new StreamableHTTPClientTransport(new URL(await limitedServer.start(root))));
    await limitedClient.callTool({name:"read_file",arguments:{path:paths[0],start:1,lines:1}});
    const stopped=await limitedClient.callTool({name:"read_file",arguments:{path:paths[1],start:1,lines:3}});
    assert.equal(stopped.isError,true);assert.equal(budgetStops,1);
  } finally {await limitedClient.close();await limitedServer.stop();}
  const tiny=new RepositoryContext(root,15,()=>{},ref);
  tiny.read(paths[0],1,undefined,1,"budget");
  assert.match(tiny.read(paths[0],1,undefined,1,"budget"),/already read/);
  assert.throws(()=>tiny.read(paths[1],1,undefined,3,"budget"));
  assert.ok(tiny.used<=tiny.budget);
 }finally{await client?.close();await server?.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
