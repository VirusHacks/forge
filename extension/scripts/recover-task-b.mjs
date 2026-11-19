import {constants} from "node:fs";
import {chmod,lstat,open,readFile,realpath,rename,rm} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";

const [journalArg,rootArg,approval]=process.argv.slice(2);
if(!journalArg||!rootArg||approval!=="--rollback"){
  console.error("Usage: node scripts/recover-task-b.mjs <recovery-journal.json> <workspace-root> --rollback");
  process.exit(2);
}
const journalPath=path.resolve(journalArg),root=await realpath(rootArg);
const journal=JSON.parse(await readFile(journalPath,"utf8"));
if(journal.version!==1||journal.root!==root||!Array.isArray(journal.files)||journal.files.length<1||journal.files.length>18)
  throw Error("Recovery journal does not match this workspace or has an unsupported format.");
const plan=[];
for(const item of journal.files){
  if(typeof item.path!=="string"||typeof item.originalBase64!=="string"||typeof item.proposedBase64!=="string")throw Error("Malformed journal entry.");
  const parts=item.path.split("/");
  if(!item.path||path.isAbsolute(item.path)||/[\\:\x00-\x1f\x7f]/.test(item.path)||parts.some(p=>!p||p==="."||p===".."||p.startsWith(".")))throw Error("Unsafe recovery path: "+item.path);
  const target=path.join(root,...parts);
  if(await realpath(target)!==target)throw Error("Symlink or aliased recovery target: "+item.path);
  const stat=await lstat(target,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n)throw Error("Expected an unlinked regular file: "+item.path);
  const current=await readFile(target),original=Buffer.from(item.originalBase64,"base64"),proposed=Buffer.from(item.proposedBase64,"base64");
  if(!current.equals(original)&&!current.equals(proposed))throw Error("Disk contents conflict with the recovery journal: "+item.path);
  plan.push({target,path:item.path,current,original,proposed,mode:Number(stat.mode&0o777n)});
}
for(const item of plan){
  if(item.current.equals(item.original))continue;
  const latest=await readFile(item.target);
  if(!latest.equals(item.proposed))throw Error("File changed during recovery; journal retained: "+item.path);
  const temporary=path.join(path.dirname(item.target),"."+path.basename(item.target)+".forge-recovery-"+randomUUID()+".tmp");
  const handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
  try{await handle.writeFile(item.original);await handle.sync();}finally{await handle.close();}
  try{await chmod(temporary,item.mode);await rename(temporary,item.target);}catch(error){await rm(temporary,{force:true});throw error;}
  if(!(await readFile(item.target)).equals(item.original))throw Error("Restored bytes could not be confirmed: "+item.path);
}
await rm(journalPath,{force:true});
console.log(`Restored ${plan.length} Task B file(s) to their original bytes.`);
