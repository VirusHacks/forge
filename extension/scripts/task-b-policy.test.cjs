const {test}=require('node:test'),assert=require('node:assert/strict');
const {essentialTools,contextPolicy,RequestBudget}=require('../out/src/taskBPolicy.js');
const {TaskBTools,describeTaskBTools}=require('../out/src/taskBTools.js');
test('preload list contains essential workspace tools and leaves browsing deferred',async()=>{
 const instance=new TaskBTools({maxReadLines:40},async()=>({ok:false,summary:''}),()=>{},new AbortController().signal);
 const advertised=await describeTaskBTools(instance),names=new Set(advertised.map(x=>x.name));
 for(const tool of essentialTools)assert.ok(names.has(tool),tool);
 assert.ok(!essentialTools.includes('search_directory'));
 assert.ok(essentialTools.includes('stage_patch')&&essentialTools.includes('submit_review'));
});
test('complete request budget reserves output, bounds tool and model data, and avoids counting a tool response twice',()=>{
 const p=contextPolicy('model',6000,2400,8192);assert.equal(p.maxInputTokens,5280);assert.equal(p.maxOutputTokens,2400);
 assert.throws(()=>contextPolicy('model',6000,2400,3000),/too little/);
 const b=new RequestBudget(100,50);b.tool('one response');const after=b.used;b.streamedTool('one response');assert.equal(b.used,after);
 assert.throws(()=>b.add('x'.repeat(500)),/Context length exceeded/);
});
