import {classifyProviderFailure,retryAfterMs,freeModels} from "./taskBFallback";

type Event=any;
type Options={client:any;model:string;fallbackModels?:string[];availableModels?:string[];freeOnly?:boolean;agentName:string;request:string;signal:AbortSignal;providerMaxRetries?:number;attemptTimeoutMs?:number;register:(model:string)=>Promise<void>;onEvent?:(event:Event)=>void;onStatus?:(event:Record<string,unknown>)=>void;onSession?:(id:string)=>void;validate?:(text:string)=>void};
type Hooks={wait?:(ms:number,signal:AbortSignal)=>Promise<void>};
const defaults=["google-gemini/gemini-3-5-flash-lite","openrouter/openrouter-free"];
export function taskAModelOrder(primary:string,fallbacks?:string[],available?:string[],freeOnly=true){
  const fault=primary==="forge-task-c-unreachable/unreachable";
  if(freeOnly&&!freeModels.has(primary)&&!fault)throw Error("freeOnly: primary model is not on the free-model allowlist.");
  return [...new Set([primary,...(fallbacks??defaults)])].filter((m,i)=>i===0||(!freeOnly||freeModels.has(m))&&(!available||available.includes(m))).slice(0,3);
}
function abortError(){const e=new Error("Cancelled");e.name="AbortError";return e;}
function content(value:any):string {if(typeof value==="string")return value;if(Array.isArray(value))return value.map((x:any)=>typeof x==="string"?x:x?.text??"").join("");return "";}
function raceAbort<T>(p:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();return new Promise((resolve,reject)=>{const stop=()=>{cleanup();reject(abortError());};const cleanup=()=>signal.removeEventListener("abort",stop);signal.addEventListener("abort",stop,{once:true});p.then(v=>{cleanup();resolve(v);},e=>{cleanup();reject(e);});});
}
export async function runTaskAWithFallback(o:Options,hooks:Hooks={}) {
  const names=taskAModelOrder(o.model,o.fallbackModels,o.availableModels,o.freeOnly??true),blocked=new Set<string>();
  const wait=hooks.wait??((ms:number,signal:AbortSignal)=>import("node:timers/promises").then(({setTimeout})=>setTimeout(ms,undefined,{signal})));
  const retries=Math.max(0,Math.min(2,o.providerMaxRetries??1));let attempts=0,last:unknown;
  for(const model of names){
    const family=model.split("/")[0];if(blocked.has(family))continue;
    for(let n=0;n<=retries;n++){
      o.signal.throwIfAborted();attempts++;let session="",terminal=false,timedOut=false;
      const local=new AbortController(),stop=()=>local.abort();o.signal.addEventListener("abort",stop,{once:true});
      const timer=setTimeout(()=>{timedOut=true;local.abort();},Math.max(1,o.attemptTimeoutMs??600000));
      const cancel=()=>{if(session)void Promise.resolve(o.client.sessions.cancel(session,{}, {maxRetries:0})).catch(()=>{});};
      try{
        o.onStatus?.({type:"model.attempt",model,attempt:attempts});
        await raceAbort(o.register(model),local.signal);
        const creating=Promise.resolve(o.client.sessions.create({agent:{name:o.agentName}},{maxRetries:0})) as Promise<any>;
        creating.then(x=>{if(local.signal.aborted)void Promise.resolve(o.client.sessions.cancel(x.data.id,{}, {maxRetries:0})).catch(()=>{});}).catch(()=>{});
        session=(await raceAbort(creating,local.signal)).data.id;o.onSession?.(session);
        const stream:any=await raceAbort(o.client.sessions.createTurnStream(session,{input:[{type:"user.message",content:o.request}]},{maxRetries:0,timeoutInSeconds:600,abortSignal:local.signal,stream:{reconnectionEnabled:false,maxReconnectionAttempts:0}}),local.signal);
        const iter=stream[Symbol.asyncIterator](),seen=new Set<string>();let turnId="unknown",finalText="",inputTokens=0,outputTokens=0,modelCalls=0;
        while(true){
          const next:any=await raceAbort(iter.next(),local.signal);if(next.done)break;
          local.signal.throwIfAborted();const e=next.value;
          const key=e.type+":"+e.id;if(e.id&&seen.has(key))continue;if(e.id)seen.add(key);
          if(e.type==="turn.created")turnId=e.turnId;
          if(e.type==="model.message"){modelCalls++;inputTokens+=e.usage?.inputTokens??0;outputTokens+=e.usage?.outputTokens??0;}
          if(e.type==="turn.done"){
            if(e.state.status==="cancelled"){if(e.state.reason==="server-execution-timeout")throw Error("provider timeout");throw abortError();}
            if(e.state.status!=="done")throw Error(e.state.message??"Provider turn failed");
            terminal=true;finalText=content(e.state.output?.content);inputTokens=e.state.metrics?.totalInputTokens??inputTokens;outputTokens=e.state.metrics?.totalOutputTokens??outputTokens;
          }
          o.onEvent?.(e);if(terminal)break;
        }
        if(!terminal)throw Error("interrupted stream");
        try{JSON.parse(finalText);}catch{throw Error("malformed json response");}
        o.validate?.(finalText);
        return {modelName:model,sessionId:session,turnId,finalText,modelCalls,inputTokens,outputTokens,attempts};
      }catch(error){
        cancel();if(o.signal.aborted||((error as Error)?.name==="AbortError"&&!timedOut))throw abortError();
        last=timedOut?Error("provider timeout"):error;const kind=classifyProviderFailure(last);
        if(!kind||kind==="tool_or_validation")throw last;
        if(kind==="rate_limit"||kind==="invalid_credentials")blocked.add(family);
        const delay=retryAfterMs(last)??250;
        if((kind==="network"||kind==="server")&&n<retries&&delay<=10000){o.onStatus?.({type:"model.retry",model,kind,delay});await wait(delay,o.signal);o.signal.throwIfAborted();continue;}
        o.onStatus?.({type:"model.fallback",model,kind});break;
      }finally{clearTimeout(timer);o.signal.removeEventListener("abort",stop);}
    }
  }
  throw last??Error("No eligible model configured.");
}
