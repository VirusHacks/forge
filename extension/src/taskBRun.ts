import {randomBytes} from "node:crypto";
import {WorkspaceMcpServer} from "./workspaceMcp";
import {RepositoryContext,Hunk,Log} from "./taskBContext";
import {TaskBTools,TaskBCheckpoint,Verify,Verdict,toolNames,describeTaskBTools} from "./taskBTools";

import {essentialTools,taskBInstructions,resumeInstructions,contextPolicy,estimateTokens,RequestBudget} from "./taskBPolicy";

export const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
type SDK=typeof import("@truefoundry/trueforge-sdk");
const loadSdk=new Function("return import('@truefoundry/trueforge-sdk')") as ()=>Promise<SDK>;
export interface Review {
  root:string; hunks:Hunk[]; base:Record<string,string>; digest:string;
  validate:(selected:Hunk[])=>Promise<Verdict>;approve:(allowed:boolean)=>Promise<void>;signal:AbortSignal;
}
export type TaskBSharedState={repo?:RepositoryContext;tools?:TaskBTools;modelIndex?:number};
export async function runTaskB(opts:{root:string;model:string;baseUrl:string;budget:number;paceMs:number;signal:AbortSignal;
  shared?:TaskBSharedState;resuming?:boolean;checkpointPath?:string;resumeState?:TaskBCheckpoint;modelPriority?:string[];deferredTools?:boolean;compactionEnabled?:boolean;
  objective?:string;repoMapEnabled?:boolean;repoMapMaxResults?:number;
  maxInputTokens?:number;maxOutputTokens?:number;modelContextWindow?:number;
  searchResultLimit?:number;maxReadLines?:number;maxToolResultChars?:number;iterationLimit?:number;
  verify:Verify;log:Log;review:(r:Review)=>Promise<{applied:boolean;selected:Hunk[]}>}) {
  const {log}=opts;
  const objective=opts.objective??TASK_B;
  const controller=new AbortController(),signal=controller.signal;
  const forwardAbort=()=>controller.abort(opts.signal.reason);
  opts.signal.throwIfAborted();opts.signal.addEventListener("abort",forwardAbort,{once:true});
  let budgetError:Error|undefined;
  const start=Date.now();
  const policy=contextPolicy(opts.model,opts.maxInputTokens??(opts.model.startsWith("groq/")?6000:10000),opts.maxOutputTokens??2400,opts.modelContextWindow??16384);
  const repo=opts.shared?.repo??new RepositoryContext(opts.root,opts.budget,log,undefined,{searchResultLimit:opts.searchResultLimit,maxReadLines:opts.maxReadLines});
  const tools=opts.shared?.tools??new TaskBTools(repo,opts.verify,log,signal,opts.paceMs,opts.checkpointPath,objective,opts.resumeState,opts.maxToolResultChars,{enabled:opts.repoMapEnabled,maxResults:opts.repoMapMaxResults});
  if(opts.shared){opts.shared.repo=repo;opts.shared.tools=tools;repo.setLog(log);tools.setLog(log);tools.setSignal(signal);}
  const initialCounts={...tools.counts},initialAttempts=tools.attempts,initialContext=repo.used;
  const id=randomBytes(5).toString("hex");
  const server=new WorkspaceMcpServer(0,()=>tools.createServer(),"/mcp/"+randomBytes(24).toString("hex"));
  const {TrueForge}=await loadSdk();
  const c=new TrueForge({baseUrl:opts.baseUrl,token:process.env.TRUEFORGE_TOKEN,timeoutInSeconds:900,maxRetries:0,stream:{reconnectionEnabled:false}});
  let session="",turn="",status="error",applied=false,models=0,input=0,output=0,lastError="",terminal=false,reviewStarted=false;
  let cancelPromise:Promise<unknown>|undefined;
  const seen=new Set<string>();
  const cancel=()=>{if(session&&!cancelPromise)cancelPromise=c.sessions.cancel(session,{}, {maxRetries:0}).catch(()=>{});return cancelPromise;};
  signal.addEventListener("abort",cancel,{once:true});
  try {
    signal.throwIfAborted();
    const url=await server.start(repo.root);
    const connector="forge-b-tools-"+id, agent="forge-task-b-"+id;
    await c.settings.mcpServers.createOrUpdate({manifest:{name:connector,type:"remote",description:"Search, read, stage and validate proposals in the disposable workspace",url}});
    const instructions=(opts.resuming?resumeInstructions:"")+taskBInstructions;
    const schemas=await describeTaskBTools(tools);
    const preloaded=schemas.filter(t=>opts.deferredTools===false||essentialTools.includes(t.name));
    const schemaTokens=estimateTokens(JSON.stringify(preloaded));
    const initial=1200+schemaTokens+estimateTokens(instructions+objective);
    const budget=new RequestBudget(policy.maxInputTokens,initial);
    const guard=(operation:()=>void)=>{try{operation();}catch(error){budgetError=error as Error;controller.abort(budgetError);throw error;}};
    tools.beforeResponse=text=>guard(()=>budget.tool(text));
    tools.onContextExhausted=()=>{budgetError=Error("Repository retrieval budget exhausted; resume from the checkpoint.");controller.abort(budgetError);};
    log({type:"context.request_budget",...policy,initialEstimatedTokens:initial,schemaEstimatedTokens:schemaTokens,harnessReserveTokens:1200,preloaded:preloaded.map(t=>t.name),estimateOnly:true});
    await c.agents.create({name:agent,description:"Repository discovery, isolated verification and human review",manifest:{model:{name:opts.model,params:{maxTokens:policy.maxOutputTokens,temperature:0}},
      instructions,
      config:{iterationLimit:opts.iterationLimit??24,sandbox:{enabled:false},webSearch:{enabled:false},askUserQuestions:{enabled:false},generativeUi:{enabled:false},dynamicSubAgents:{enabled:false},
        contextManagement:{compaction:{enabled:opts.compactionEnabled??false,trigger:{type:"input_tokens",value:policy.compactionTrigger}},largeToolResponse:{enabled:false}}},
      mcpServers:[{name:connector,enableTools:toolNames,...(opts.deferredTools===false?{preload:true}:{preload:false,preloadTools:essentialTools}),requireApprovalForTools:["submit_review"]}]}});
    session=(await c.sessions.create({agent:{name:agent}})).data.id;
    tools.setRunMetadata({status:"running",activeModel:opts.model,sessionId:session,turnId:undefined,modelPriority:opts.modelPriority});
    log({type:"session",agent,connector,session,model:opts.model,instruction:objective});
    const stream=await c.sessions.createTurnStream(session,{input:[{type:"user.message",content:objective}]},{abortSignal:signal,timeoutInSeconds:900});
    for await(const e of stream){
      signal.throwIfAborted();
      if(terminal)break;
      // Delta IDs may refer to the same message: never drop distinct text chunks by message ID.
      if(e.type!=="model.message.delta"&&"id" in e){const key=e.type+":"+e.id;if(seen.has(key))continue;seen.add(key);}
      if(e.type==="model.message")guard(()=>budget.add(JSON.stringify({content:e.content,reasoning:e.reasoningContent,toolCalls:e.toolCalls})));
      if(e.type==="tool.response")guard(()=>budget.streamedTool(e.content));
      if(e.type==="thread.context_compaction_finished")budget.compact();
      if(e.type==="model.message"||e.type==="tool.response")log({type:"context.request_estimate",tokens:budget.used,limit:budget.limit,estimateOnly:true});
      if(e.type==="turn.created"){turn=e.turnId;tools.setRunMetadata({turnId:turn});log({type:e.type,turn});}
      if(e.type==="model.message.delta" && e.content)log({type:"delta",text:e.content});
      if(e.type==="model.message"){models++;log({type:e.type,model:opts.model,requested:e.toolCalls?.map(t=>t.function.name),usage:e.usage});}
      if(e.type.startsWith("thread.context_compaction"))log({type:e.type});
      if(e.type==="tool.response")log({type:e.type,id:e.toolCallId});
      if(e.type==="tool.approval_required"){
        reviewStarted=true;
        const draft=tools.draft;
        if(!draft || tools.busy || tools.sealed || e.toolCalls.length!==1)throw Error("Unexpected approval request without a unique verified draft.");
        // Bind the approval to the exact saved call and candidate, never a later model edit.
        const ref=e.toolCalls[0];
        let matches=false;
        for await(const item of await c.sessions.listTurnEvents(session,turn)){
          if(item.type!=="model.message"||item.id!==ref.sourceEventId)continue;
          const t=item.toolCalls?.find(t=>t.id===ref.id);
          matches=t?.function.name==="submit_review" && JSON.parse(t.function.arguments).digest===draft.digest;
          break;
        }
        if(!matches)throw Error("Approval call differs from the validated draft.");
        tools.sealed=true;
        log({type:e.type,turn,digest:draft.digest,call:ref.id,hunks:draft.hunks});
        let sent=false;
        const approve=async(allow:boolean)=>{
          signal.throwIfAborted();
          if(sent)throw Error("Review decision already sent.");
          tools.approved=allow;
          await c.sessions.createTurnEvents(session,turn,{events:[{type:"user.tool_approval",threadId:e.threadId,toolCallId:ref.id,approval:allow?{status:"allow"}:{status:"deny",reason:"Reviewer declined"}}]});
          sent=true;log({type:"approval.sent",allow,call:ref.id});
        };
        const review=await opts.review({root:repo.root,...draft,approve,validate:h=>tools.validate(h),signal});
        if(!sent)await approve(false);
        applied=review.applied;
        log({type:"review",applied,selected:review.selected.length});
      }
      if(e.type==="user.tool_approval")log({type:e.type,decision:e.approval});
      if(e.type==="turn.done"){
        terminal=true;status=e.state.status;input=e.state.metrics?.totalInputTokens??0;output=e.state.metrics?.totalOutputTokens??0;
        if(e.state.status==="error")throw Error(e.state.message);
      }
    }
    if(!terminal)throw Error("Interrupted stream: no terminal turn event. Resume from checkpoint.");
    if(status!=="done")throw Error("Turn ended with status "+status);
    if(!applied)throw Error(reviewStarted?"Review denied: proposal was not applied.":"Incomplete model response: agent finished without submitting a verified proposal.");
  }catch(caught){void cancel();const error=budgetError??caught;lastError=String(error).replace(/org_[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+|sk-or-v1-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~-]+/g,"[redacted]").slice(0,500);log({type:"error",message:lastError});throw error;}
  finally{opts.signal.removeEventListener("abort",forwardAbort);signal.removeEventListener("abort",cancel);await server.stop();
    tools.beforeResponse=undefined;tools.onContextExhausted=undefined;
    if(session&&turn&&!opts.signal.aborted){
      try{
        const completed=[];
        for await(const e of await c.sessions.listTurnEvents(session,turn,undefined,{timeoutInSeconds:10,maxRetries:0})){
          if(e.type==="model.message"&&e.usage)completed.push({id:e.id,...e.usage,tools:e.toolCalls?.map(t=>t.function.name)});
        }
        log({type:"usage.completed",responses:completed.length,messages:completed,input:completed.reduce((n,e)=>n+e.inputTokens,0),output:completed.reduce((n,e)=>n+e.outputTokens,0)});
      }catch{log({type:"usage.unavailable",reason:"Saved usage could not be fetched; stream start events are not completed calls."});}
    }
    const finalState=applied?"complete":opts.signal.aborted?"cancelled":status==="done"?"rejected":"interrupted";
    tools.setRunMetadata({status:finalState,error:lastError||undefined,applied,activeModel:opts.model,sessionId:session||undefined,turnId:turn||undefined,modelPriority:opts.modelPriority});
    log({type:"metrics",session,turn,status,applied,modelMessageEvents:models,input,output,
      tools:Object.fromEntries(Object.entries(tools.counts).map(([name,count])=>[name,count-(initialCounts[name]??0)])),
      validationAttempts:tools.attempts-initialAttempts,sdkRetries:0,contextEstimatedTokens:repo.used-initialContext,
      contextTotalTokens:repo.used,durationMs:Date.now()-start});}
}
