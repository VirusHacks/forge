import * as vscode from "vscode";
import {randomUUID} from "node:crypto";
import {TASK_B} from "./taskBRun";
import {isSensitivePath} from "./workspaceMcp";
import {freeModels} from "./taskBFallback";
import type {TaskBPreview} from "./taskBReview";

type ClientMessage =
 | {type:"ready"}|{type:"start";task:string;model:string}|{type:"stop";runId:string}
 | {type:"decision";runId:string;digest:string;indices:number[]}|{type:"models"}
 | {type:"history";runId:string}|{type:"attach"}|{type:"symbol"}|{type:"copy";text:string}|{type:"undo"};
type Run={id:string;task:string;model:string;status:"running"|"complete"|"error"|"cancelled"|"rejected";events:Record<string,unknown>[]};
type HostMessage = {type:"state";runs:Run[];current?:string;workspace:string;taskExample:string;models:string[];modelError?:string}
 | {type:"event";runId:string;event:Record<string,unknown>}
 | {type:"review";runId:string;digest:string;hunks:{index:number;path:string;line:number}[]}
 | {type:"attachment";text:string}|{type:"notice";text:string};

export class ForgeSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?:vscode.WebviewView;
  private runs:Run[]=[];
  private current?:string;
  private models:string[]=[];
  private modelError?:string;
  private pending?:{runId:string;digest:string;count:number;hunks:{index:number;path:string;line:number}[];resolve:(v:number[]|undefined)=>void};
  private output?: (run: {task:string;model:string;runId:string;resume?:boolean})=>void;
  constructor(private readonly context:vscode.ExtensionContext) {}
  setStart(fn:(run:{task:string;model:string;runId:string;resume?:boolean})=>void){this.output=fn;}
  resolveWebviewView(view:vscode.WebviewView){
    this.view=view;view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,"media")]};
    const js=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,"media","forge.js"));
    const css=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,"media","forge.css"));
    const nonce=randomUUID().replace(/-/g,"");
    view.webview.html=`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body><main id="app"></main><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((msg:unknown)=>void this.receive(msg),undefined,this.context.subscriptions);
    view.onDidDispose(()=>{this.view=undefined;if(this.pending){this.pending.resolve(undefined);this.pending=undefined;}},undefined,this.context.subscriptions);
  }
  private post(message:HostMessage){void this.view?.webview.postMessage(message);}
  private state(){this.post({type:"state",runs:this.runs,current:this.current,workspace:vscode.workspace.workspaceFolders?.[0]?.name??"No workspace",taskExample:TASK_B,models:this.models,modelError:this.modelError});if(this.pending)this.post({type:"review",runId:this.pending.runId,digest:this.pending.digest,hunks:this.pending.hunks});}
  private async receive(raw:unknown){
    if(!raw||typeof raw!=="object"||typeof (raw as {type?:unknown}).type!=="string")return;
    const msg=raw as ClientMessage;
    switch(msg.type){
      case "ready":this.state();await this.loadModels();break;
      case "models":await this.loadModels();break;
      case "history":if(typeof msg.runId==="string"&&this.runs.some(r=>r.id===msg.runId)){this.current=msg.runId;this.state();}break;
      case "start":{
        if(typeof msg.task!=="string"||typeof msg.model!=="string"||!msg.task.trim()||msg.task.length>4000||!this.models.includes(msg.model)){this.post({type:"notice",text:"Enter a task and select a configured TrueForge model."});return;}
        if(this.runs.some(r=>r.status==="running")){this.post({type:"notice",text:"Stop or finish the active run first."});return;}
        const typed=msg.task.trim();
        const continuation=/^(?:please\s+)?(?:continue|resume|go on)(?:\s+(?:please|the task))?[.!]?$/i.test(typed);
        const previous=continuation?this.runs.find(r=>r.id===this.current)??this.runs.at(-1):undefined;
        if(continuation&&!previous){this.post({type:"notice",text:"Choose an earlier task before continuing."});return;}
        const run:Run={id:randomUUID(),task:previous?.task??typed,model:msg.model,status:"running",events:[]};this.runs.push(run);this.runs=this.runs.slice(-20);this.current=run.id;this.state();
        if(!this.output){this.finish(run.id,"error","Task controller is unavailable.");return;}this.output({task:run.task,model:run.model,runId:run.id,resume:continuation});break;
      }
      case "stop":if(typeof msg.runId==="string"&&this.runs.some(r=>r.id===msg.runId&&r.status==="running")){if(this.pending?.runId===msg.runId){this.pending.resolve(undefined);this.pending=undefined;}await vscode.commands.executeCommand("forge.taskBCancel");}break;
      case "decision":{
        const p=this.pending;if(!p||msg.runId!==p.runId||msg.digest!==p.digest||!Array.isArray(msg.indices)||msg.indices.length>p.count||msg.indices.some(i=>!Number.isInteger(i)||i<0||i>=p.count)||new Set(msg.indices).size!==msg.indices.length)return;
        this.pending=undefined;p.resolve(msg.indices);break;
      }
      case "copy":if(typeof msg.text==="string"&&msg.text.length<=12000)await vscode.env.clipboard.writeText(msg.text);break;
      case "undo":await vscode.commands.executeCommand("undo");break;
      case "attach":{
        const root=vscode.workspace.workspaceFolders?.[0];if(!root)return;
        const files=await vscode.workspace.findFiles(new vscode.RelativePattern(root,"**/*"),"**/{.git,node_modules,.venv,venv}/**",300);
        const pick=await vscode.window.showQuickPick(files.filter(f=>!isSensitivePath(vscode.workspace.asRelativePath(f))).map(f=>({label:vscode.workspace.asRelativePath(f),uri:f})),{placeHolder:"Attach a workspace file reference"});
        if(pick)this.post({type:"attachment",text:`@file:${pick.label}`});break;
      }
      case "symbol":{
        const query=await vscode.window.showInputBox({prompt:"Search workspace symbols",placeHolder:"Symbol name"});if(!query?.trim())return;
        const symbols=await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider",query);
        const choices=(symbols??[]).filter(s=>s.location?.uri.scheme==="file"&&vscode.workspace.getWorkspaceFolder(s.location.uri)&&!isSensitivePath(vscode.workspace.asRelativePath(s.location.uri))).slice(0,100).map(s=>({label:s.name,description:vscode.workspace.asRelativePath(s.location.uri),line:s.location.range.start.line+1}));
        const pick=await vscode.window.showQuickPick(choices,{placeHolder:"Attach a symbol reference"});
        if(pick)this.post({type:"attachment",text:`@symbol:${pick.label} (${pick.description}:${pick.line})`});break;
      }
    }
  }
  private async loadModels(){
    try{const {TrueForge}=await (new Function("return import('@truefoundry/trueforge-sdk')")() as Promise<typeof import("@truefoundry/trueforge-sdk")>);
      const cfg=vscode.workspace.getConfiguration("forge"),client=new TrueForge({baseUrl:cfg.get<string>("trueforgeBaseUrl","http://localhost:8790"),token:process.env.TRUEFORGE_TOKEN,maxRetries:0,timeoutInSeconds:10});
      this.models=(await client.models.list({maxRetries:0})).data.map(m=>m.name).filter(name=>!cfg.get<boolean>("freeOnly",true)||freeModels.has(name)).sort();this.modelError=undefined;
    }catch{this.models=[];this.modelError="Cannot reach TrueForge. Start the local server and refresh models.";}this.state();
  }
  event(id:string|undefined,event:Record<string,unknown>){
    const run=this.runs.find(r=>r.id===id);if(!run||run.status!=="running")return;
    // Avoid copying full proposed source into UI state; diff editor owns previews.
    const clean={...event};if(clean.type==="tool.approval_required")delete clean.hunks;
    if(clean.type==="delta"){
      const last=run.events.at(-1);if(last?.type==="delta")last.text=String(last.text??"")+String(clean.text??"");else run.events.push(clean);
    }else run.events.push(clean);
    if(run.events.length>300)run.events.splice(0,run.events.length-300);
    this.post({type:"event",runId:run.id,event:clean});
  }
  review(runId:string,digest:string,previews:readonly TaskBPreview[],signal:AbortSignal):Promise<readonly number[]|undefined>{
    if(this.pending||!this.view||signal.aborted)return Promise.resolve(undefined);
    const hunks=previews.map((p,index)=>({index,path:p.hunk.path,line:p.line}));
    return new Promise(resolve=>{
      const finish=(value:number[]|undefined)=>{signal.removeEventListener("abort",abort);resolve(value);};
      const abort=()=>{if(this.pending?.runId===runId)this.pending=undefined;finish(undefined);};
      this.pending={runId,digest,count:hunks.length,hunks,resolve:finish};signal.addEventListener("abort",abort,{once:true});
      this.post({type:"review",runId,digest,hunks});
    });
  }
  finish(id:string|undefined,status:Run["status"],message:string){const run=this.runs.find(r=>r.id===id);if(!run)return;run.status=status;this.eventBeforeFinish(run,message);this.state();}
  private eventBeforeFinish(run:Run,message:string){run.events.push({type:"status",status:run.status,message});}
  dispose(){if(this.pending)this.pending.resolve(undefined);}
}
