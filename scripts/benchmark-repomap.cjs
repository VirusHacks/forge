#!/usr/bin/env node
// Read-only benchmark on a clean linked worktree; creates and deletes a private index mirror.
const {performance}=require('node:perf_hooks');
const {RepositoryContext}=require('../extension/out/src/taskBContext.js');
const {RepoMapIndex}=require('../extension/out/src/repoMap.js');
const {TASK_B}=require('../extension/out/src/taskBRun.js');
const root=process.argv[2]||'/Users/dakshjain/.codex/worktrees/flask-task-b-agent/flask-3.1.3';
const estimate=value=>Math.ceil(Buffer.byteLength(JSON.stringify(value),'utf8')/3);
(async()=>{
 const events=[],baselineRepo=new RepositoryContext(root,12000,e=>events.push(e)),start=performance.now();
 const baseline=baselineRepo.investigate(TASK_B),baselineMs=performance.now()-start;
 const repo=new RepositoryContext(root,12000,()=>{}),index=new RepoMapIndex(repo,5);
 const report={revision:repo.revision,modelCalls:0,repomapEmbedding:'disabled',baseline:{ms:+baselineMs.toFixed(1),toolCalls:1,estimatedSourceTokens:baselineRepo.used,estimatedResponseTokens:estimate(baseline),paths:Object.fromEntries(Object.entries(baseline).map(([k,v])=>[k,v.map(x=>x.path)]))},queries:[]};
 try{
  for(const q of ['get_debug_flag',TASK_B,'add_command','test CLI config']){
   const t=performance.now(),r=await index.find(q);report.queries.push({query:q,ms:+(performance.now()-t).toFixed(1),estimatedResponseTokens:estimate(r),hits:r.hits.map(x=>({name:x.name,file:x.file,line:x.line,end:x.end,id:x.id}))});
   if(q==='get_debug_flag'&&r.hits[0]){const t2=performance.now(),c=await index.context(r.hits[0].id),t3=performance.now(),trace=await index.trace(r.hits[0].id,1);report.context={ms:+(t3-t2).toFixed(1),estimatedResponseTokens:estimate(c),symbol:c.symbol,tests:c.tests};report.trace={ms:+(performance.now()-t3).toFixed(1),estimatedResponseTokens:estimate(trace),callerCount:trace.callers.length,tests:trace.tests};}
  }
  report.repomapProcessStarts=index.stats.generation;console.log(JSON.stringify(report,null,2));
 }finally{await index.dispose();}
})().catch(error=>{console.error(error.message);process.exitCode=1});
