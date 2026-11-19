import {TrueForge} from "@truefoundry/trueforge-sdk";
const session=process.argv[2];
if(!session)throw Error("Provide the TrueForge session ID");
const c=new TrueForge({baseUrl:process.env.TRUEFORGE_BASE_URL||"http://localhost:8790",token:process.env.TRUEFORGE_TOKEN,maxRetries:0});
const turns=[];
for await(const turn of await c.sessions.listTurns(session)){
 const events=[];
 for await(const e of await c.sessions.listTurnEvents(session,turn.id)){
   const entry={type:e.type,id:e.id,at:e.createdAt};
   if(e.type==="model.message"){entry.calls=e.toolCalls?.map(t=>({name:t.function.name,args:JSON.parse(t.function.arguments),id:t.id}));entry.usage=e.usage;}
   if(e.type==="tool.response"){entry.call=e.toolCallId;entry.result=e.content.slice(0,1400);}
   if(e.type==="user.tool_approval")Object.assign(entry,{approval:e.approval,call:e.toolCallId});
   if(e.type==="tool.approval_required")entry.calls=e.toolCalls;
   if(e.type==="thread.context_compaction_finished")entry.usage=e.usage;
   events.push(entry);
 }
 turns.push({id:turn.id,input:turn.input,status:turn.state.status,metrics:turn.state.metrics,error:turn.state.message,events:events.sort((a,b)=>a.id.localeCompare(b.id))});
}
console.log(JSON.stringify({session,turns},null,2).replace(/org_[\w-]+|gsk_[\w-]+/g,"[redacted]"));
