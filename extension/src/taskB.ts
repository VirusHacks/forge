import * as vscode from "vscode";
import {createHash} from "node:crypto";
import {readFileSync,unlinkSync} from "node:fs";
import {classifyProviderFailure,runTaskBWithFallback} from "./taskBFallback";
import {validateTaskB} from "./taskBValidate";
import {reviewTaskB} from "./taskBReview";
import {TASK_B} from "./taskBRun";
import type {ForgeSidebar} from "./forgeSidebar";

export interface SidebarRun {task:string;model:string;runId:string;resume?:boolean}
export function registerTaskB(context:vscode.ExtensionContext,sidebar?:ForgeSidebar) {
  const output=vscode.window.createOutputChannel("Forge Task B");
  let active:AbortController|undefined;
  context.subscriptions.push(output,{dispose:()=>active?.abort()},
    vscode.commands.registerCommand("forge.taskBCancel",()=>active?.abort()),
    vscode.commands.registerCommand("forge.taskB",async(request?:SidebarRun)=>{
      if(active){void vscode.window.showWarningMessage("Finish or cancel the active Task B session.");sidebar?.finish(request?.runId,"error","Another run is active.");return;}
      const root=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if(!root){void vscode.window.showWarningMessage("Open a disposable Flask worktree.");sidebar?.finish(request?.runId,"error","Open a disposable Flask worktree.");return;}
      const objective=request?.task?.trim()||TASK_B;
      if(objective.length>4000){sidebar?.finish(request?.runId,"error","Task is too long (4,000 characters maximum).");return;}
      active=new AbortController();
      const signal=active.signal;
      let reviewDeclined=false;
      try{
        const cfg=vscode.workspace.getConfiguration("forge");
        const baseUrl=cfg.get<string>("trueforgeBaseUrl","http://localhost:8790");
        let model=request?.model||cfg.get<string>("trueforgeModel")||process.env.TRUEFORGE_MODEL;
        if(!model){
          const {TrueForge}=await (new Function("return import('@truefoundry/trueforge-sdk')")() as Promise<typeof import("@truefoundry/trueforge-sdk")>);
          const api=new TrueForge({baseUrl,token:process.env.TRUEFORGE_TOKEN,maxRetries:0});
          model=await vscode.window.showQuickPick((await api.models.list()).data.map(m=>m.name),{placeHolder:"Choose the Task B model in TrueForge"});
          if(!model){sidebar?.finish(request?.runId,"cancelled","Model selection cancelled.");return;}
        }
        const dir=vscode.Uri.joinPath(context.globalStorageUri,"task-b");
        const checkpointPath=vscode.Uri.joinPath(dir,createHash("sha256").update(root+"\0"+objective).digest("hex").slice(0,20)+".json").fsPath;
        const legacyPath=vscode.Uri.joinPath(dir,createHash("sha256").update(root).digest("hex").slice(0,20)+".json").fsPath;
        let resumeState:Record<string,unknown>|undefined;
        for(const candidate of [checkpointPath,legacyPath]){
          let saved:any;try{saved=JSON.parse(readFileSync(candidate,"utf8"));}catch{continue;}
          if(saved.root!==root||saved.objective!==objective||!Array.isArray(saved.staged)||saved.validationAttempts>=3||["complete","rejected","cancelled"].includes(saved.status))continue;
          const hasProgress=saved.staged.length>0||(Array.isArray(saved.discovered)&&saved.discovered.length>0);
          if(!hasProgress)continue;
          if(request?.resume){resumeState=saved;break;}
          const choice=await vscode.window.showQuickPick(["Resume saved Task B","Start a fresh Task B"],{placeHolder:`Saved ${saved.staged.length} staged edits and ${saved.discovered?.length??0} discovered files`});
          if(!choice){sidebar?.finish(request?.runId,"cancelled","Resume selection cancelled.");return;}
          if(choice==="Resume saved Task B")resumeState=saved;
          else if(candidate===checkpointPath)try{unlinkSync(checkpointPath);}catch{}
          break;
        }
        output.clear();output.show(true);
        await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:"TrueForge Task B",cancellable:true},async(_,token)=>{
          const sub=token.onCancellationRequested(()=>active?.abort());
          try{
            await runTaskBWithFallback({root,baseUrl,model:model!,objective,fallbackModels:cfg.get<string[]>("taskBFallbackModels",["google-gemini/gemini-3-5-flash-lite","openrouter/openrouter-free"]),freeOnly:cfg.get<boolean>("freeOnly",true),providerMaxRetries:cfg.get<number>("providerMaxRetries",1),signal,budget:cfg.get("taskBContextBudget",4000),paceMs:cfg.get("taskBToolPaceMs",0),checkpointPath,resumeState,deferredTools:cfg.get<boolean>("taskBDeferredTools",true),compactionEnabled:cfg.get<boolean>("taskBEnableCompaction",false),
              maxInputTokens:cfg.get<number>("taskBMaxInputTokens",12000),maxOutputTokens:cfg.get<number>("taskBMaxOutputTokens",2400),modelContextWindow:cfg.get<number>("taskBModelContextWindow",16384),
              repoMapEnabled:cfg.get<boolean>("repoMapEnabled",true),repoMapMaxResults:cfg.get<number>("repoMapMaxResults",5),
              searchResultLimit:cfg.get<number>("taskBSearchResultLimit",6),maxReadLines:cfg.get<number>("taskBMaxReadLines",40),maxToolResultChars:cfg.get<number>("taskBMaxToolResultChars",8000),iterationLimit:cfg.get<number>("taskBIterationLimit",1024),
              verify:validateTaskB,review:r=>reviewTaskB(r.root,r.hunks,r.base,{...r,...(request&&sidebar?{select:previews=>sidebar.review(request.runId,r.digest,previews,signal)}:{}),recoveryDirectory:vscode.Uri.joinPath(context.globalStorageUri,"task-b-recovery").fsPath}),
              log:e=>{if(e.type==="review"&&e.applied===false)reviewDeclined=true;sidebar?.event(request?.runId,e);if(e.type==="delta")output.append(String(e.text));else output.appendLine(JSON.stringify(e));}});
          }finally{sub.dispose();}
        });
        sidebar?.finish(request?.runId,"complete","Turn finished; check the review and save prompts.");
      }catch(error){
        const kind=classifyProviderFailure(error);
        const detail=String(error).replace(/org_[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+|sk-or-v1-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~-]+/g,"[redacted]");
        const text=kind==="invalid_credentials"?"TrueForge rejected credentials or access for a configured model. Update the provider in TrueForge → Settings → Models.":kind==="rate_limit"?"Configured providers are rate limited. Wait for the quota reset or configure a fallback from a different provider family.":kind==="context_exceeded"?"The model context limit was exceeded after retrieval was reduced. Choose a larger-context model or a compatible fallback.":kind==="retrieval_exhausted"?"The repository reading budget was exhausted. Continue the task to resume from the saved checkpoint.":detail;
        sidebar?.finish(request?.runId,signal.aborted?"cancelled":reviewDeclined?"rejected":"error",signal.aborted?"Run cancelled.":reviewDeclined?"Proposal rejected; no patch applied.":text.slice(0,500));
        output.appendLine(text);void vscode.window.showWarningMessage(signal.aborted?"Task B cancelled.":text.slice(0,250));
      }finally{active=undefined;}
    }));
}
