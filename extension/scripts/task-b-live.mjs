import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,renameSync,existsSync,readFileSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {createInterface} from "node:readline";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {TrueForge} from "@truefoundry/trueforge-sdk";

const extension=fileURLToPath(new URL("../",import.meta.url));
if(!process.env.FLASK_TASK_B_REPO||!process.env.TRUEFORGE_MODEL)throw Error("Set FLASK_TASK_B_REPO and TRUEFORGE_MODEL.");
const root=realpathSync(process.env.FLASK_TASK_B_REPO);
const dir=mkdtempSync(path.join(os.tmpdir(),"forge-b-"));
const evidence=path.join(extension,"../reports/evidence/task-b");
mkdirSync(evidence,{recursive:true});
const log=path.join(evidence,Date.now()+".jsonl");
console.log("Task B evidence:",log);
const child=spawn(process.env.VSCODE_EXECUTABLE||"/Applications/Visual Studio Code.app/Contents/MacOS/Code",[
  root,"--extensionDevelopmentPath="+extension,"--extensionTestsPath="+path.join(extension,"scripts/task-b-host.cjs"),
  "--user-data-dir="+path.join(dir,"profile"),"--extensions-dir="+path.join(dir,"extensions"),
  "--disable-extensions","--skip-welcome","--skip-release-notes"],{
  env:{...process.env,FORGE_RUN_LOG:log,FORGE_REVIEW_DIR:dir},stdio:["ignore","ignore","inherit"]});
let shown=false;
const timer=setInterval(()=>{
  if(shown||!existsSync(log))return;
  const lines=readFileSync(log,"utf8").trim().split("\n");
  if(lines.some(s=>s.includes('"type":"diff.open"'))){
    const item=JSON.parse(lines.find(s=>s.includes('"type":"tool.approval_required"')));
    shown=true;
    item.hunks.forEach((h,i)=>console.log(i+1,h.path,"\n- "+h.original+"\n+ "+h.replacement));
    console.log("Review the VS Code hunks, then type: approve "+item.digest+" all (or comma-separated 1-based indexes), or reject.");
  }
},500);
const rl=createInterface({input:process.stdin});
rl.on("line",line=>{
  if(!shown)return;
  const item=JSON.parse(readFileSync(log,"utf8").split("\n").find(s=>s.includes('"type":"tool.approval_required"')));
  const m=/^approve ([a-f0-9]+) (all|\d+(?:,\d+)*)$/.exec(line.trim());
  if(line.trim()!=="reject"&&(!m||m[1]!==item.digest)){console.log("Expected an explicit decision for",item.digest);return;}
  const indexes=!m?[]:m[2]==="all"?item.hunks.map((_,i)=>i):m[2].split(",").map(n=>Number(n)-1);
  writeFileSync(path.join(dir,"decision.tmp"),JSON.stringify({digest:item.digest,indexes,save:!!m}),{mode:0o600});
  renameSync(path.join(dir,"decision.tmp"),path.join(dir,"decision.json"));
});
let stopping=false;
async function cancelPendingSession(){
  if(!existsSync(log))return;
  const events=readFileSync(log,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const session=events.filter(e=>e.type==="session").at(-1)?.session;
  if(!session||events.some(e=>e.type==="metrics"&&e.session===session))return;
  const c=new TrueForge({baseUrl:process.env.TRUEFORGE_BASE_URL||"http://localhost:8790",token:process.env.TRUEFORGE_TOKEN,maxRetries:0});
  try{await c.sessions.cancel(session,{}, {maxRetries:0});console.log("Cancelled interrupted TrueForge session:",session);}
  catch(error){console.error("Could not cancel interrupted TrueForge session:",String(error).slice(0,180));}
}
child.on("exit",code=>{
  clearInterval(timer);rl.close();process.exitCode=code??1;
  if(!stopping)void cancelPendingSession();
});
process.on("SIGINT",()=>{
  if(stopping)return;
  stopping=true;
  void cancelPendingSession().finally(()=>child.kill("SIGTERM"));
});
