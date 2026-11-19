const vscode=require("vscode");
const fs=require("node:fs");
const path=require("node:path");
const {setTimeout:delay}=require("node:timers/promises");
exports.run=async()=>{
  const {runTaskBWithFallback}=require("../out/src/taskBFallback.js");
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const abort=new AbortController();
  const channel=vscode.window.createOutputChannel("Forge Task B");
  channel.show(true);
  const log=event=>{
    if(event.type==="delta"){channel.append(event.text);return;}
    const line=JSON.stringify({time:new Date().toISOString(),...event});
    fs.appendFileSync(process.env.FORGE_RUN_LOG,line+"\n");
    channel.appendLine(line);
  };
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:"TrueForge Task B",cancellable:true},async(_,token)=>{
    const sub=token.onCancellationRequested(()=>abort.abort());
    try{
      await runTaskBWithFallback({root,model:process.env.TRUEFORGE_MODEL,
        fallbackModels:(process.env.TRUEFORGE_FALLBACK_MODELS??"google-gemini/gemini-3-5-flash-lite,openrouter/openrouter-free").split(",").map(x=>x.trim()).filter(Boolean),
        freeOnly:process.env.FORGE_FREE_ONLY!=="false",providerMaxRetries:Number(process.env.FORGE_PROVIDER_MAX_RETRIES??1),
        maxInputTokens:Number(process.env.FORGE_MAX_INPUT_TOKENS??12000),maxOutputTokens:Number(process.env.FORGE_MAX_OUTPUT_TOKENS??2400),modelContextWindow:Number(process.env.FORGE_MODEL_CONTEXT_WINDOW??16384),
        checkpointPath:process.env.FORGE_RUN_LOG+".state.json",baseUrl:process.env.TRUEFORGE_BASE_URL||"http://localhost:8790",
        compactionEnabled:process.env.FORGE_ENABLE_COMPACTION===undefined?vscode.workspace.getConfiguration("forge").get("taskBEnableCompaction",false):process.env.FORGE_ENABLE_COMPACTION==="true",
        iterationLimit:require("./task-b-options.cjs").iterationLimit(process.env.FORGE_ITERATION_LIMIT,vscode.workspace.getConfiguration("forge").get("taskBIterationLimit",24)),
        budget:Number(process.env.FORGE_CONTEXT_BUDGET||4000),paceMs:Number(process.env.FORGE_PACE_MS||0),signal:abort.signal,log,
        verify:(...args)=>require("../out/src/taskBValidate.js").validateTaskB(...args),
        review:async r=>{
          const {reviewTaskB}=require("../out/src/taskBReview.js");
          let save=false;
          return reviewTaskB(root,r.hunks,r.base,{...r,recoveryDirectory:path.join(process.env.FORGE_REVIEW_DIR,"recovery"),
            select:async previews=>{
              log({type:"diff.open",digest:r.digest,count:previews.length});
              const decisionPath=path.join(process.env.FORGE_REVIEW_DIR,"decision.json");
              while(!fs.existsSync(decisionPath)) await delay(250,undefined,{signal:r.signal});
              const d=JSON.parse(fs.readFileSync(decisionPath,"utf8"));
              if(d.digest!==r.digest)throw Error("Decision applies to a different diff.");
              save=d.save===true;
              return d.indexes;
            },confirmSave:async()=>save});
        }});
    }finally{sub.dispose();}
  });
};
