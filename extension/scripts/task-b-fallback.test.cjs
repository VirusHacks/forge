const {test,beforeEach}=require("node:test");
const assert=require("node:assert/strict");
const {classifyProviderFailure,retryAfterMs,runTaskBWithFallback,clearProviderCooldowns}=require("../out/src/taskBFallback.js");

beforeEach(()=>clearProviderCooldowns());

const opts=(events,signal=new AbortController().signal)=>({
  root:"unused-in-injected-test",model:"groq/qwen",fallbackModels:["openrouter/free"],baseUrl:"http://localhost:8790",
  budget:500,paceMs:0,signal,verify:async()=>({ok:true,summary:"unused"}),
  review:async()=>({applied:false,selected:[]}),log:event=>events.push(event),
});
const hooks=(extra={})=>({preflight:()=>{},wait:async(_ms,signal)=>signal.throwIfAborted(),...extra});

test("classifies provider and non-provider failures distinctly",()=>{
  for(const [error,kind] of [
    [new Error("Request failed (429)"),"rate_limit"],[new Error("Request failed (529)"),"server"],
    [new Error("network error: ETIMEDOUT"),"network"],[new Error("Request failed (404): model not found"),"unavailable"],
    [new Error("property 'reasoning_content' is unsupported"),"provider_incompatible"],
    [Object.assign(new Error("unauthorized"),{statusCode:401}),"invalid_credentials"],
    [new Error("maximum context length exceeded"),"context_exceeded"],[new Error("Repository retrieval budget exhausted; resume from the checkpoint."),"retrieval_exhausted"],
    [new Error("malformed tool arguments"),"malformed_output"],[new Error("tool call validation failed: attempted to call unavailable tool"),"malformed_output"],[new Error("Incomplete model response: agent finished without submitting a verified proposal."),"malformed_output"],
    [new Error("Tool validation failed: bad anchor"),"tool_or_validation"],
  ])assert.equal(classifyProviderFailure(error),kind);
  assert.equal(classifyProviderFailure(new Error("Review denied")),"tool_or_validation");
  for(const message of ["Request failed (403) without auth details","unknown failure"])
    assert.equal(classifyProviderFailure(new Error(message)),undefined);
});

test("reads Retry-After seconds, HTTP dates, and reset timestamps",()=>{
  assert.equal(retryAfterMs({headers:{"retry-after":"2"}},1_000),2_000);
  assert.equal(retryAfterMs({headers:{"retry-after":new Date(4_000).toUTCString()}},1_000),3_000);
  assert.equal(retryAfterMs({headers:{"x-ratelimit-reset":"4"}},1_000),4_000);
  assert.equal(retryAfterMs({headers:{"x-ratelimit-reset":"1700000002"}},1_700_000_000_000),2_000);
  assert.equal(retryAfterMs({rawResponse:{headers:new Headers({"retry-after":"3"})}},1_000),3_000);
  assert.equal(retryAfterMs(new Error("[Model Error] Request failed (429): Rate limit reached. Please try again in 25.448571428s."),1_000),25_449);
});

test("one rate limit switches provider and keeps staged tool state",async()=>{
  const events=[],calls=[];let preflights=0,shared;
  await runTaskBWithFallback(opts(events),async run=>{
    calls.push([run.model,run.resuming]);
    if(!shared)shared=run.shared;else assert.equal(run.shared,shared);
    if(calls.length===1)throw Error("Request failed (429)");
  },hooks({preflight:()=>{preflights++;}}));
  assert.deepEqual(calls,[["groq/qwen",false],["openrouter/free",true]]);
  assert.equal(preflights,1);
  assert.equal(events.find(e=>e.type==="model.fallback").kind,"rate_limit");
});

test("server errors get one jittered retry before falling back",async()=>{
  const events=[],calls=[],delays=[];
  await runTaskBWithFallback(opts(events),async run=>{
    calls.push(run.model);
    if(calls.length<3)throw Error("Request failed (503)");
  },hooks({wait:async(ms,signal)=>{signal.throwIfAborted();delays.push(ms);}}));
  assert.deepEqual(calls,["groq/qwen","groq/qwen","openrouter/free"]);
  assert.equal(delays.length,1);
  assert.ok(delays[0]>=250&&delays[0]<500);
});

test("cancellation during transient backoff prevents retry and provider switch",async()=>{
  const events=[],controller=new AbortController(),calls=[];
  await assert.rejects(runTaskBWithFallback(opts(events,controller.signal),async run=>{
    calls.push(run.model);throw Error("Request failed (503)");
  },hooks({wait:async(_ms,signal)=>{controller.abort();signal.throwIfAborted();}})));
  assert.deepEqual(calls,["groq/qwen"]);
});

test("invalid credentials and context overflow switch without retrying the same model",async()=>{
  for(const [failure,kind] of [[Object.assign(new Error("bad key"),{statusCode:401}),"invalid_credentials"],[new Error("maximum context length exceeded"),"context_exceeded"]]){
    const events=[],calls=[];
    await runTaskBWithFallback(opts(events),async run=>{calls.push(run.model);if(calls.length===1)throw failure;},hooks());
    assert.deepEqual(calls,["groq/qwen","openrouter/free"]);
    assert.ok(events.some(e=>e.type==="model.fallback"&&e.kind===kind));
  }
});

test("rate-limited provider family is skipped; free aliases do not rotate around account limits",async()=>{
  const events=[],run=opts(events);run.model="openrouter/model-primary";run.fallbackModels=["openrouter/model-a","groq/other"];
  const calls=[];
  await runTaskBWithFallback(run,async attempt=>{
    calls.push(attempt.model);
    if(calls.length===1)throw Error("Request failed (429)");
  },hooks());
  assert.deepEqual(calls,["openrouter/model-primary","groq/other"]);
  assert.ok(events.some(e=>e.type==="model.skip"&&e.model==="openrouter/model-a"));
});

test("never switches after review, cancellation, malformed output, or tool failure",async()=>{
  for(const mode of ["review","cancel","tool"]){
    const events=[],controller=new AbortController(),calls=[];
    const execute=async run=>{
      calls.push(run.model);
      if(mode==="review")run.log({type:"tool.approval_required"});
      if(mode==="cancel")controller.abort();
      if(mode==="tool")throw Error("Tool validation failed: bad anchor");
      throw Error("Request failed (429)");
    };
    await assert.rejects(runTaskBWithFallback(opts(events,controller.signal),execute,hooks()));
    assert.deepEqual(calls,["groq/qwen"]);
  }
});

test("malformed model output moves to a different configured model without repeating the turn",async()=>{
  const events=[],calls=[];
  await runTaskBWithFallback(opts(events),async run=>{
    calls.push(run.model);
    if(calls.length===1)throw Error("malformed tool arguments");
  },hooks());
  assert.deepEqual(calls,["groq/qwen","openrouter/free"]);
  assert.ok(events.some(e=>e.type==="model.fallback"&&e.kind==="malformed_output"));
});

test("context overflow reduces repository retrieval before starting fallback",async()=>{
  const events=[],run=opts(events),calls=[];
  let budget=1000,reductions=0;
  const resetForNewModel=()=>{};
  await runTaskBWithFallback(run,async attempt=>{
    calls.push(attempt.model);
    if(!attempt.shared.repo)attempt.shared.repo={get budget(){return budget;},resetForNewModel,reduceBudget(){budget=Math.floor(budget*.65);reductions++;return budget;}};
    if(calls.length===1)throw Error("maximum context length exceeded");
  },hooks());
  assert.deepEqual(calls,["groq/qwen","openrouter/free"]);
  assert.equal(reductions,1);
  assert.equal(budget,650);
  assert.ok(events.some(e=>e.type==="context.reduce"&&e.budget===650));
});

test("duplicate fallback names are bounded to three configured providers",async()=>{
  const events=[],run=opts(events);run.fallbackModels=["groq/qwen","openrouter/free","openrouter/free","other/model"];
  const calls=[];
  await assert.rejects(runTaskBWithFallback(run,async attempt=>{calls.push(attempt.model);throw Error("Request failed (429)");},hooks()));
  assert.deepEqual(calls,["groq/qwen","openrouter/free","other/model"]);
});


test("cooldown skips nonadjacent aliases across runs and expires",async()=>{
 const events=[],run=opts(events),calls=[];run.fallbackModels=["other/free","groq/another"];let clock=1000;
 await assert.rejects(runTaskBWithFallback(run,async a=>{calls.push(a.model);throw a.model.startsWith("groq/")?Error("Request failed (429): Please try again in 25.4s"):Error("Request failed (503)");},hooks({now:()=>clock})));
 assert.ok(!calls.includes("groq/another"));calls.length=0;
 await runTaskBWithFallback(run,async a=>calls.push(a.model),hooks({now:()=>clock}));assert.deepEqual(calls,["other/free"]);
 clock+=25401;calls.length=0;await runTaskBWithFallback(run,async a=>calls.push(a.model),hooks({now:()=>clock}));assert.deepEqual(calls,["groq/qwen"]);
});


test("retrieval exhaustion switches with a fresh retrieval budget without shrinking it",async()=>{
 const events=[],run=opts(events),calls=[];let reductions=0,resets=0;
 await runTaskBWithFallback(run,async attempt=>{
   calls.push(attempt.model);if(!attempt.shared.repo)attempt.shared.repo={resetForNewModel(){resets++},reduceBudget(){reductions++}};
   if(calls.length===1)throw Error("Repository retrieval budget exhausted; resume from the checkpoint.");
 },hooks());
 assert.deepEqual(calls,["groq/qwen","openrouter/free"]);assert.equal(reductions,0);assert.equal(resets,1);
});
