const {test} = require("node:test");
const assert = require("node:assert/strict");
const {existsSync} = require("node:fs");
if (!existsSync(require.resolve("../out/src/taskAAgent.js").replace("taskAAgent.js", "taskAFallback.js"))) {
  test("Task A exposes bounded TrueForge session recovery", () => assert.fail("Task A has no session fallback yet"));
  return;
}
const {runTaskAWithFallback, taskAModelOrder} = require("../out/src/taskAFallback.js");
const {taskARequest, registerTaskA} = require("../out/src/taskAAgent.js");
const source = 'def get_debug_flag():\n    return True\n';
const proposal = JSON.stringify({path:"src/flask/helpers.py", originalText:source, replacementText:'def get_debug_flag():\n    return False\n', explanation:"Recognize false values"});
const request = taskARequest("src/flask/helpers.py", source, 37);
const event = (type, id, extra={}) => ({type,id,createdAt:"2026-11-19T00:00:00Z",threadId:"main",...extra});
const done = (id="done", text=proposal) => event("turn.done",id,{threadId:null,state:{status:"done",completedAt:"2026-11-19T00:00:00Z",output:{content:text},metrics:{totalInputTokens:20,totalOutputTokens:10}}});
async function* events(items) { for (const item of items) { if (item instanceof Error) throw item; yield item; } }
const fail = (statusCode, message="provider failure") => Object.assign(new Error(message), {statusCode});
function setup(streams, extra={}) {
  const calls=[], inputs=[], statuses=[], seen=[], cancelled=[], delays=[];
  const abort = new AbortController();
  const client = {sessions:{
    create:async()=>({data:{id:`session-${calls.length}`}}),
    createTurnStream:async(session, input, options)=>{
      inputs.push({session,input,options});
      const stream=streams[inputs.length-1];
      if (stream instanceof Error) throw stream;
      return typeof stream === "function" ? stream() : events(stream ?? [done()]);
    },
    cancel:async session=>{cancelled.push(session);},
  }};
  const options={client,model:"groq/qwen-3-8-27b",fallbackModels:["openrouter/openrouter-free"],freeOnly:true,
    agentName:"test-agent",request,signal:abort.signal,providerMaxRetries:0,attemptTimeoutMs:500,
    register:async model=>{calls.push(model);},onEvent:e=>seen.push(e),onStatus:e=>statuses.push(e),...extra};
  return {calls,inputs,statuses,seen,cancelled,abort,client,options,delays,
    run:()=>runTaskAWithFallback(options,{wait:async(ms,signal)=>{signal.throwIfAborted();delays.push(ms);}})};
}

test("primary 429 automatically falls back with exact selected context and one final proposal", {timeout:1000}, async()=>{
  const s=setup([[event("turn.created","created",{turnId:"turn-primary"}),fail(429)],
    [event("turn.created","created",{turnId:"turn-fallback"}),done()]]);
  const result=await s.run();
  assert.deepEqual(s.calls,["groq/qwen-3-8-27b","openrouter/openrouter-free"]);
  assert.equal(s.inputs[0].input.input[0].content,request);
  assert.equal(s.inputs[1].input.input[0].content,request);
  assert.match(request,/Treat the values 'off' and 'n' as false as well, case-insensitively/);
  assert.ok(request.includes(source)); assert.match(request,/"start_line":37/);
  assert.equal(result.finalText,proposal); assert.equal(result.modelName,"openrouter/openrouter-free");
  assert.equal(result.sessionId,"session-2"); assert.equal(result.turnId,"turn-fallback");
  assert.equal(result.attempts,2); assert.equal(s.inputs[0].options.maxRetries,0);
  assert.deepEqual(s.cancelled,["session-1"]);
});

test("both models failing stops at the configured bound", {timeout:1000}, async()=>{
  const s=setup([fail(503),fail(503)]);
  await assert.rejects(s.run(),/provider failure/);
  assert.equal(s.calls.length,2); assert.equal(s.cancelled.length,2);
});

test("provider retry count and Retry-After are bounded", {timeout:1000}, async()=>{
  const s=setup([Object.assign(fail(503),{headers:{"retry-after":"1"}}),fail(503),[done()]],{providerMaxRetries:1});
  await s.run();
  assert.deepEqual(s.calls,["groq/qwen-3-8-27b","groq/qwen-3-8-27b","openrouter/openrouter-free"]);
  assert.deepEqual(s.delays,[1000]);
  const long=setup([Object.assign(fail(503),{headers:{"retry-after":"600"}}),[done()]],{providerMaxRetries:2});
  await long.run(); assert.equal(long.calls.length,2); assert.deepEqual(long.delays,[]);
});

test("non-adjacent aliases of a rate-limited or invalid provider are skipped", {timeout:1000}, async()=>{
  for(const status of [429,401]) {
    const s=setup([fail(status),fail(503)],{model:"quota/one",fallbackModels:["independent/one","quota/two"],freeOnly:false});
    await assert.rejects(s.run());
    assert.deepEqual(s.calls,["quota/one","independent/one"]);
  }
});

test("cancellation during generation ignores late events and never falls back", {timeout:1000}, async()=>{
  let release;
  const stream={ [Symbol.asyncIterator](){return this;},next:()=>new Promise(resolve=>{release=resolve;}),return:()=>new Promise(()=>{}) };
  const s=setup([()=>stream]);
  // A broken server cancel endpoint must not hold the editor hostage.
  s.client.sessions.cancel=()=>new Promise(()=>{});
  const result=s.run();
  await new Promise(resolve=>setImmediate(resolve));
  s.abort.abort();
  await assert.rejects(result,e=>e.name==="AbortError");
  release({value:done(),done:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.calls.length,1); assert.equal(s.seen.length,0);
});

test("cancellation while opening a session cancels a late-created session without sending a turn", {timeout:1000}, async()=>{
  let release;
  const s=setup([]);
  s.client.sessions.create=()=>new Promise(resolve=>{release=resolve;});
  const result=s.run(); await new Promise(resolve=>setImmediate(resolve)); s.abort.abort();
  await assert.rejects(result,e=>e.name==="AbortError");
  release({data:{id:"late-session"}}); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(s.cancelled,["late-session"]); assert.equal(s.inputs.length,0); assert.equal(s.calls.length,1);
});

test("cancellation during retry backoff and pre-cancelled signals launch no replacement", {timeout:1000}, async()=>{
  const s=setup([fail(503)],{providerMaxRetries:2});
  await assert.rejects(runTaskAWithFallback(s.options,{wait:async()=>{s.abort.abort();}}),e=>e.name==="AbortError");
  assert.equal(s.calls.length,1);
  const pre=setup([]);pre.abort.abort();await assert.rejects(pre.run());assert.equal(pre.calls.length,0);
});

test("EOF and thrown disconnects recover without reusing partial response", {timeout:1000}, async()=>{
  for(const ending of [[],[new Error("socket hang up")]]) {
    const s=setup([[event("model.message.delta","delta",{content:"broken partial"}),...ending],[done()]]);
    const result=await s.run(); assert.equal(result.finalText,proposal);assert.equal(result.attempts,2);
  }
});

test("hung stream times out; old stream completion cannot change fallback result", {timeout:1000}, async()=>{
  let release;
  const stream={ [Symbol.asyncIterator](){return this;},next:()=>new Promise(resolve=>{release=resolve;}),return:async()=>({done:true}) };
  const s=setup([()=>stream,[done()]],{attemptTimeoutMs:15});
  const result=await s.run(); release({done:false,value:done("late","stale")});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result.finalText,proposal); assert.equal(result.attempts,2);
  assert.equal(s.seen.filter(e=>e.id==="late").length,0);
});

test("duplicate IDs are ignored within each attempt; valid same-text deltas remain", {timeout:1000}, async()=>{
  const delta=event("model.message.delta","d1",{content:"x"});
  const message=event("model.message","m1",{content:"response",usage:{inputTokens:3,outputTokens:1}});
  const s=setup([[delta,delta,event("model.message.delta","d2",{content:"x"}),message,message,done(),done(),fail(503)]]);
  const result=await s.run();
  assert.equal(s.seen.filter(e=>e.type==="model.message.delta").length,2);
  assert.equal(s.seen.filter(e=>e.type==="model.message").length,1);
  assert.equal(s.seen.filter(e=>e.type==="turn.done").length,1);
  assert.equal(result.attempts,1);
});

test("malformed completed JSON can fall back, but unsafe proposals cannot", {timeout:1000}, async()=>{
  const s=setup([[done("bad","{broken")],[done()]]);assert.equal((await s.run()).attempts,2);
  const unsafe=setup([[done()]],{validate:()=>{throw new Error("The proposed patch targets a different file than the selected function.");}});
  await assert.rejects(unsafe.run(),/different file/);assert.equal(unsafe.calls.length,1);
});

test("server cancellation never triggers fallback unless it is execution timeout", {timeout:1000}, async()=>{
  const s=setup([[event("turn.done","cancel",{state:{status:"cancelled",reason:"client-cancelled"}})]]);
  await assert.rejects(s.run(),e=>e.name==="AbortError");assert.equal(s.calls.length,1);
  const timeout=setup([[event("turn.done","timeout",{state:{status:"cancelled",reason:"server-execution-timeout"}})],[done()]]);
  assert.equal((await timeout.run()).attempts,2);
});

test("free-only model selection refuses unverified spend and filters unavailable fallbacks",()=>{
  assert.throws(()=>taskAModelOrder("paid/model",[],["paid/model"],true),/freeOnly/);
  assert.deepEqual(taskAModelOrder("groq/qwen-3-8-27b",undefined,["groq/qwen-3-8-27b","openrouter/openrouter-free"],true),["groq/qwen-3-8-27b","openrouter/openrouter-free"]);
  assert.deepEqual(taskAModelOrder("groq/qwen-3-8-27b",["paid/model","google-gemini/gemini-3-5-flash-lite","openrouter/openrouter-free"],undefined,true),["groq/qwen-3-8-27b","google-gemini/gemini-3-5-flash-lite","openrouter/openrouter-free"]);
  assert.deepEqual(taskAModelOrder("forge-task-c-unreachable/unreachable",[],undefined,true),["forge-task-c-unreachable/unreachable"]);
});

test("agent registration exposes only read-only tools and honours cancellation", async()=>{
  let manifest;
  const client={settings:{mcpServers:{createOrUpdate:async()=>{}}},agents:{list:async()=>events([]),create:async arg=>{manifest=arg.manifest;}}};
  await registerTaskA(client,"groq/qwen-3-8-27b","agent","tools","http://localhost/mcp","test");
  assert.deepEqual(manifest.mcpServers[0].enableTools,["read_file","search_repository"]);
  assert.equal(manifest.config.sandbox.enabled,false);
  const abort=new AbortController();abort.abort();manifest=undefined;
  await assert.rejects(registerTaskA(client,"model","agent","tools","http://localhost/mcp","test",abort.signal));
  assert.equal(manifest,undefined);
});
