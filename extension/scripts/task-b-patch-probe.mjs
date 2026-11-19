import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {TrueForge} from '@truefoundry/trueforge-sdk';
const require=createRequire(import.meta.url);
const {RepositoryContext}=require('../out/src/taskBContext.js');
const {TaskBTools}=require('../out/src/taskBTools.js');
const {WorkspaceMcpServer}=require('../out/src/workspaceMcp.js');
const root=process.env.FLASK_TASK_B_REPO,model=process.env.TRUEFORGE_MODEL;
if(!root||!model)throw Error('Set FLASK_TASK_B_REPO and TRUEFORGE_MODEL');
const ac=new AbortController(),counts={},log=e=>{if(e.type==='tool.start')counts[e.name]=(counts[e.name]||0)+1;if(['tool.error','stage'].includes(e.type))console.log(JSON.stringify(e));};
const repo=new RepositoryContext(root,2500,log),tools=new TaskBTools(repo,async()=>({ok:false,summary:'Not part of this probe'}),log,ac.signal);
const server=new WorkspaceMcpServer(0,()=>tools.createServer(),'/mcp/'+randomBytes(24).toString('hex'));
const c=new TrueForge({baseUrl:'http://localhost:8790',maxRetries:0,timeoutInSeconds:180,stream:{reconnectionEnabled:false}});
let session,turn;try{
 const url=await server.start(repo.root),id=randomBytes(4).toString('hex'),connector='forge-stage-probe-'+id,agent='forge-stage-probe-'+id;
 await c.settings.mcpServers.createOrUpdate({manifest:{name:connector,type:'remote',description:'Read and stage without writing',url}});
 await c.agents.create({name:agent,description:'Temporary staging-tool usability probe',manifest:{model:{name:model,params:{maxTokens:1500,temperature:0}},instructions:'Read source, then stage one harmless wording edit. stage_patch takes edits with path, original and replacement. Never write to disk.',config:{iterationLimit:12,sandbox:{enabled:false},webSearch:{enabled:false},askUserQuestions:{enabled:false},generativeUi:{enabled:false},dynamicSubAgents:{enabled:false}},mcpServers:[{name:connector,enableTools:['read_file','stage_patch'],preload:true,requireApprovalForTools:[]}]}});
 session=(await c.sessions.create({agent:{name:agent}})).data.id;console.log(JSON.stringify({type:'session',session,model}));
 const stream=await c.sessions.createTurnStream(session,{input:[{type:'user.message',content:'Read README.md and stage a short harmless wording improvement to one sentence. Do not write files or run validation. Call stage_patch and stop.'}]},{abortSignal:ac.signal,timeoutInSeconds:180});
 for await(const e of stream){if(e.type==='turn.created')turn=e.turnId;if(e.type==='model.message')console.log(JSON.stringify({type:'model.message',tools:e.toolCalls?.map(t=>t.function.name)}));if(e.type==='tool.response'&&tools.staged.length){console.log(JSON.stringify({type:'result',staged:tools.staged.length,paths:[...new Set(tools.staged.map(h=>h.path))],counts}));break;}if(e.type==='turn.done'){console.log(JSON.stringify({type:'turn.done',status:e.state.status,message:e.state.message,counts}));break;}}
 if(session)await c.sessions.cancel(session,{}, {maxRetries:0}).catch(()=>{});
 if(session&&turn){let n=0,input=0,output=0;for await(const e of await c.sessions.listTurnEvents(session,turn)){if(e.type==='model.message'&&e.usage){n++;input+=e.usage.inputTokens;output+=e.usage.outputTokens;}}console.log(JSON.stringify({type:'usage',responses:n,input,output}));}
}finally{await server.stop();await tools.dispose();}
if(!tools.staged.length)process.exitCode=1;
