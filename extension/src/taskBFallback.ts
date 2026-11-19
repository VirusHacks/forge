import {runTaskB, type TaskBSharedState} from "./taskBRun";
import type {TaskBCheckpoint} from "./taskBTools";
import {RepositoryContext} from "./taskBContext";

type RunOptions=Parameters<typeof runTaskB>[0];
export type FailureKind="rate_limit"|"server"|"network"|"unavailable"|"provider_incompatible"|"invalid_credentials"|"context_exceeded"|"retrieval_exhausted"|"malformed_output"|"tool_or_validation";
type Hooks={preflight?:(opts:RunOptions)=>void;wait?:(ms:number,signal:AbortSignal)=>Promise<void>;now?:()=>number};
const cooldowns=new Map<string,number>();
export function clearProviderCooldowns(){cooldowns.clear();}
export const freeModels=new Set(["groq/qwen-3-8-27b","google-gemini/gemini-3-5-flash-lite","openrouter/openrouter-free"]);

function messageOf(error:unknown){return error instanceof Error?error.message:String(error);}
function statusOf(error:unknown):number|undefined {
  const e=error as any;
  const value=e?.statusCode??e?.status??e?.response?.status??e?.rawResponse?.status;
  return Number.isInteger(Number(value))?Number(value):undefined;
}
function header(error:unknown,name:string):string|undefined {
  const e=error as any, headers=e?.headers??e?.response?.headers??e?.rawResponse?.headers;
  if(headers&&typeof headers.get==="function")return headers.get(name)??undefined;
  const entry=Object.entries(headers??{}).find(([key])=>key.toLowerCase()===name.toLowerCase());
  return entry?String(entry[1]):undefined;
}
export function retryAfterMs(error:unknown,now=Date.now()):number|undefined {
  const retry=header(error,"retry-after");
  if(retry){const seconds=Number(retry);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const date=Date.parse(retry);if(Number.isFinite(date))return Math.max(0,date-now);}
  const reset=header(error,"x-ratelimit-reset")??header(error,"ratelimit-reset");
  if(reset){const value=Number(reset);if(Number.isFinite(value)&&value>0)return Math.max(0,value>1e12?value-now:value>1e9?value*1000-now:value*1000);}
  const e=error as any;
  const direct=Number(e?.retryAfterMs??e?.retry_after_ms);
  if(Number.isFinite(direct)&&direct>=0)return direct;
  const match=messageOf(error).match(/(?:try again in|retry after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)/i);
  return match?Math.ceil(Number(match[1])*(match[2].toLowerCase().startsWith("m")?1:1000)):undefined;
}

/** Classify SDK/provider errors without treating tool or verification failures as provider faults. */
export function classifyProviderFailure(error:unknown):FailureKind|undefined {
  const message=messageOf(error),status=statusOf(error);
  if(status===429||/Request failed \(429\)|\b(?:rate limit|too many requests|quota exceeded)\b/i.test(message))return "rate_limit";
  if(status===401||status===403||/\b(?:invalid api key|unauthorized|authentication failed|invalid credentials)\b/i.test(message))return "invalid_credentials";
  if((status!==undefined&&status>=500&&status<=599)||/Request failed \(5\d\d\)|\b(?:HTTP|status)\s*5\d\d\b/i.test(message))return "server";
  if(/repository (?:context|retrieval) budget exhausted/i.test(message))return "retrieval_exhausted";
  if(status===413||/\b(?:context length|context window).{0,80}(?:exceed|too long|maximum)|maximum context length|prompt is too long|input token limit|request entity too large/i.test(message))return "context_exceeded";
  if(/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up|timeout|timed out|interrupted stream|stream disconnected|premature close)\b/i.test(message))return "network";
  if(status===404&&/\bmodel\b/i.test(message)||/\bmodel\b.*\b(?:does not exist|not found|unavailable)\b/i.test(message))return "unavailable";
  if(/reasoning_content.*unsupported|unsupported.*reasoning_content/i.test(message))return "provider_incompatible";
  if(/\b(?:malformed|invalid) (?:json|tool arguments|tool call|response)\b|incomplete model response|tool call validation failed/i.test(message))return "malformed_output";
  if(/\b(?:tool|validation|anchor|verification|review) (?:failed|error|denied|invalid)\b/i.test(message))return "tool_or_validation";
  return undefined;
}
function providerFamily(name:string){return name.split("/")[0].toLowerCase();}
const defaultWait=(ms:number,signal:AbortSignal)=>import("node:timers/promises").then(({setTimeout})=>setTimeout(ms,undefined,{signal}));

/** TrueForge owns each agent/tool turn; this bounded router only starts replacement sessions. */
export async function runTaskBWithFallback(opts:RunOptions & {fallbackModels?:string[];resumeState?:TaskBCheckpoint;providerMaxRetries?:number;freeOnly?:boolean},
  execute:typeof runTaskB=runTaskB, hooks:Hooks={}):Promise<void> {
  const names=[...new Set([opts.model,...(opts.fallbackModels??[])].map(x=>x.trim()).filter(Boolean))].filter((x,i)=>{if(opts.freeOnly!==true||freeModels.has(x))return true;if(i===0)throw Error("freeOnly: primary model is not on the free-model allowlist.");return false;}).slice(0,3);
  if(!names.length)throw Error("Choose a model configured in TrueForge.");
  const shared:TaskBSharedState={};
  const wait=hooks.wait??defaultWait,preflight=hooks.preflight??(options=>{new RepositoryContext(options.root,options.budget,options.log,undefined,{searchResultLimit:options.searchResultLimit,maxReadLines:options.maxReadLines});});
  const now=hooks.now??Date.now,maxRetries=Math.max(0,Math.min(2,opts.providerMaxRetries??1));
  const blocked=new Set<string>();
  let attempt=0,transientRetries=0,lastFamilyFailure:FailureKind|undefined;
  try {
  while(attempt<names.length*(maxRetries+1)){
    opts.signal.throwIfAborted();
    let modelIndex=Number(shared.modelIndex??0);
    while(modelIndex<names.length&&(blocked.has(providerFamily(names[modelIndex]))||(cooldowns.get(providerFamily(names[modelIndex]))??0)>now())){opts.log({type:"model.skip",model:names[modelIndex],reason:"provider cooldown or invalid credentials"});modelIndex++;}
    if(modelIndex>=names.length)throw Error("All configured model providers are unavailable or cooling down.");
    shared.modelIndex=modelIndex;const model=names[modelIndex];
    if(attempt>0){
      preflight(opts);
      shared.repo?.resetForNewModel();
    }
    let reviewStarted=false;
    opts.log({type:"model.attempt",model,index:modelIndex+1,total:names.length,attempt:attempt+1});
    try{
      await execute({...opts,model,shared,resuming:attempt>0||Boolean(opts.resumeState),modelPriority:names,
        resumeState:attempt===0?opts.resumeState:undefined,
        log:event=>{if(["tool.approval_required","approval.sent","review"].includes(String(event.type)))reviewStarted=true;opts.log(event);}});
      return;
    }catch(error){
      const kind=classifyProviderFailure(error);
      if(reviewStarted||opts.signal.aborted||!kind||kind==="tool_or_validation")throw error;
      const currentFamily=providerFamily(model);
      const retryAfter=retryAfterMs(error);
      if(["server","network"].includes(kind)&&transientRetries<maxRetries&&(retryAfter===undefined||retryAfter<=10_000)){
        transientRetries++;
        const backoff=Math.min(2000,250*2**Math.min(attempt,3))+Math.floor(Math.random()*250);
        const delay=retryAfter??backoff;
        opts.log({type:"model.retry",model,kind,delayMs:delay,retryAfterMs:retryAfter});
        await wait(delay,opts.signal);
        attempt++;
        shared.modelIndex=modelIndex;
        continue;
      }
      if(retryAfter!==undefined&&retryAfter>10_000)opts.log({type:"model.retry.skipped",model,kind,retryAfterMs:retryAfter,reason:"Retry-After exceeds the bounded wait; use another provider."});
      lastFamilyFailure=kind;
      if(kind==="rate_limit"){cooldowns.set(currentFamily,now()+(retryAfter??60000));blocked.add(currentFamily);}
      if(kind==="invalid_credentials")blocked.add(currentFamily);
      if(kind==="context_exceeded"&&shared.repo){
        const budget=shared.repo.reduceBudget();
        opts.log({type:"context.reduce",reason:kind,budget});
      }
      let next=modelIndex+1;
      if(retryAfter!==undefined&&retryAfter>10_000)blocked.add(currentFamily);
      while(next<names.length&&(blocked.has(providerFamily(names[next]))||(cooldowns.get(providerFamily(names[next]))??0)>now())){
        opts.log({type:"model.skip",model:names[next],reason:"same provider family is rate limited"});next++;
      }
      if(next>=names.length)throw error;
      opts.log({type:"model.fallback",from:model,to:names[next],kind,retryAfterMs:retryAfterMs(error)});
      shared.modelIndex=next;
      attempt++;
      transientRetries=0;
    }
  }
  throw Error(`No configured provider succeeded after ${lastFamilyFailure??"bounded retries"}.`);
  } finally {await shared.tools?.dispose?.();}
}
