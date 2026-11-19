// Offline scripted model: the reference diff is test data and is never sent to a live agent.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {RepositoryContext}=require('../out/src/taskBContext.js');
const {TaskBTools}=require('../out/src/taskBTools.js');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
function parsePatch(text){
 let file='',current;const hunks=[];
 for(const line of text.split('\n')){
  if(line.startsWith('+++ b/')){file=line.slice(6);continue;}
  const h=/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  if(h){current={path:file,start:Number(h[1]),original:'',replacement:''};hunks.push(current);continue;}
  if(!current||line.startsWith('diff --git ')||line.startsWith('index ')||line.startsWith('--- ')||line.startsWith('+++ ')||line.startsWith('\\'))continue;
  if(line.startsWith(' ')){current.original+=line.slice(1)+'\n';current.replacement+=line.slice(1)+'\n';}
  else if(line.startsWith('-'))current.original+=line.slice(1)+'\n';
  else if(line.startsWith('+'))current.replacement+=line.slice(1)+'\n';
 }
 return hunks.map(h=>({...h,original:h.original.replace(/\n$/, ""),replacement:h.replacement.replace(/\n$/, "")}));
}
const root=process.env.FLASK_TASK_B_REPO,oracle=process.env.FORGE_REFERENCE_PATCH;
test('scripted offline model stages reference hunks, validates and reaches gated review',{skip:!root||!oracle,timeout:180000},async()=>{
 const before=execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'});assert.equal(before,'');
 const hunks=parsePatch(fs.readFileSync(oracle,'utf8'));assert.ok(new Set(hunks.map(h=>h.path)).size>=3);
 const repo=new RepositoryContext(root,18000,()=>{});let verification=0;
 const project=fs.realpathSync(process.env.FORGE_PROJECT_ROOT||path.join(__dirname,'../..'));
 const verify=async(root,files)=>{
  if(++verification===1)return {ok:false,summary:'Simulated test failure: expected config output'};
  const p=spawnSync(path.join(project,'scratch/flask-task-a-agent-venv/bin/python'),['-I','-S','-B',path.join(project,'scripts/task-b-check.py')],{cwd:project,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},input:JSON.stringify({root,files}),encoding:'utf8',timeout:120000});
  return {ok:p.status===0,summary:(p.stdout||p.error?.message||'Verifier failed').trim()};
 };
 const t=new TaskBTools(repo,verify,()=>{},new AbortController().signal,0,undefined,'offline scripted simulation');
 const server=t.createServer(),client=new Client({name:'scripted-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(`${name}: ${r.content[0].text}`);try{return JSON.parse(r.content[0].text)}catch{return r.content[0].text}};
 try{
  const found=await call('investigate_repository',{goal:'Add a built-in CLI command that prints configuration as JSON, with sensitive values masked, with tests and documentation.'});
  assert.ok(found.implementation.length&&found.test.length&&found.documentation.length);
  for(const h of hunks){const lines=h.original.split('\n').length;assert.ok(lines<=40);await call('read_file',{path:h.path,start:h.start,lines,reason:'Read exact reference anchor for simulation'});const {start,...staged}=h;await call('stage_edit',staged);}
  assert.equal(new Set(t.staged.map(h=>h.path)).size,3);const failure=await call('validate_edits');assert.equal(failure.ok,false);assert.match(failure.summary,/test failure/);assert.ok(failure.summary.length<=1600);
  const h=hunks[0];await call('stage_edit',{path:h.path,original:h.original,replacement:h.replacement+'\n'});
  const pass=await call('validate_edits');assert.equal(pass.ok,true,pass.summary);assert.ok(pass.digest);assert.equal(t.snapshot().currentStage,'review');
  const denied=await client.callTool({name:'submit_review',arguments:{digest:pass.digest}});assert.equal(denied.isError,true);
  assert.equal(execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'}),before);
  t.sealed=true;t.approved=true;assert.match(await call('submit_review',{digest:pass.digest}),/acknowledged/);
  assert.equal(execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'}),before);
 } finally {await client.close();await server.close();await t.dispose();}
});
