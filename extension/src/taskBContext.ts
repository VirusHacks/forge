import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync, realpathSync, statSync} from "node:fs";
import path from "node:path";
import {isSensitivePath} from "./workspaceMcp";

export const pinned = "22d924701a6ae2e4cd01e9a15bbaf3946094af65";
export type Hunk = {path:string; original:string; replacement:string};
export type Log = (entry: Record<string,unknown>) => void;
export function git(root:string, ...args:string[]) {
  return execFileSync("git", ["-C", root, ...args], {encoding:"utf8",maxBuffer:4_000_000});
}

export function renderHunks(source:string, hunks:Hunk[]):string {
  const edits = hunks.map(h => {
    const at = source.indexOf(h.original);
    if (!h.original || at < 0 || source.indexOf(h.original,at+1) >= 0) throw Error("Anchor must occur exactly once in the original file.");
    if (h.original === h.replacement) throw Error("Empty edit.");
    return {at, end:at+h.original.length, text:h.replacement};
  }).sort((a,b)=>b.at-a.at);
  let cursor=source.length, result=source;
  for (const edit of edits) {
    if (edit.end>cursor) throw Error("Overlapping edits.");
    result=result.slice(0,edit.at)+edit.text+result.slice(edit.end);
    cursor=edit.at;
  }
  return result;
}

export class RepositoryContext {
  readonly root:string;
  readonly files:string[];
  readonly discovered=new Set<string>();
  readonly reasons=new Map<string,string>();
  readonly observed = new Map<string,string[]>();
  private evidence:{path:string;first:number;text:string;sourceHash:string}[]=[];
  private rgMissing=false;
  private readonly searchCache=new Map<string,{fingerprint:string;summary:string}>();
  evidenceSummary(limit=3){return this.evidence.slice(-limit);}
  restoreEvidence(items:unknown){
    if(!Array.isArray(items))return;
    for(const e of items.slice(-12)){
      if(!e||typeof e.path!=="string"||typeof e.text!=="string"||e.text.length>600||!Number.isSafeInteger(e.first)||e.first<1||!this.files.includes(e.path))continue;
      const source=this.source(e.path),hash=createHash("sha256").update(source).digest("hex");
      if(typeof e.sourceHash!=="string"||e.sourceHash!==hash||!source.split("\n").slice(e.first-1).join("\n").startsWith(e.text))continue;
      this.evidence.push({path:e.path,first:e.first,text:e.text,sourceHash:hash});
    }
    this.evidence=this.evidence.slice(-12);
  }
  private readonly readCursors = new Map<string,number>();
  private readonly readRanges = new Map<string,{hash:string;first:number;last:number}[]>();
  private readonly investigationAnchors = new Map<string,number[]>();
  lastReadFile?:string;
  private lastReadEnd?:number;
  used=0;
  readonly revision:string;
  readonly searchResultLimit:number;
  readonly maxReadLines:number;
  constructor(root:string, public budget:number, private log:Log, requiredRef=pinned, limits:{searchResultLimit?:number;maxReadLines?:number}={}) {
    if (!Number.isSafeInteger(budget)||budget<1) throw Error("Invalid context budget.");
    this.searchResultLimit=Math.max(1,Math.min(20,limits.searchResultLimit??6));
    this.maxReadLines=Math.max(1,Math.min(40,limits.maxReadLines??40));
    this.root=realpathSync(root);
    this.revision=git(this.root,"rev-parse","HEAD").trim();
    if (!statSync(path.join(this.root,".git")).isFile() || this.revision!==requiredRef ||
      git(this.root,"status","--porcelain").trim()) throw Error("Start Task B in a clean, linked Flask 3.1.3 worktree.");
    this.files=git(this.root,"ls-files","-s","-z").split("\0").flatMap(row=>{
      const hit=/^100(?:644|755) [a-f0-9]+ 0\t([^\x00-\x1f]+)$/.exec(row);
      return hit&&!hit[1].split("/").some(p=>p.startsWith("."))&&!isSensitivePath(hit[1])?[hit[1]]:[];
    });
  }
  setLog(log:Log){this.log=log;}
  invalidateReadTracking(files:string[]){
    const names=new Set(files);
    for(const file of names)this.readRanges.delete(file);
    for(const key of this.readCursors.keys()){try{if(names.has(JSON.parse(key)[0]))this.readCursors.delete(key);}catch{/* internal keys are JSON */}}
    if(this.lastReadFile&&names.has(this.lastReadFile))this.lastReadEnd=undefined;
  }
  resetForNewModel() {
    this.used=0;
    this.observed.clear();
    this.readCursors.clear();
    this.readRanges.clear();
    this.searchCache.clear();
    this.lastReadFile=undefined;
    this.lastReadEnd=undefined;
  }
  reduceBudget(){
    const next=Math.max(256,Math.floor(this.budget*0.65));
    this.budget=next;
    this.resetForNewModel();
    return next;
  }
  source(file:string) {
    if (!this.files.includes(file)) throw Error("Expected a tracked regular text file.");
    const target=path.join(this.root,file);
    if (realpathSync(target)!==target || !statSync(target).isFile() || statSync(target).size>262144) throw Error("Unsupported file.");
    const text=readFileSync(target,"utf8");
    if(text.includes("\0")) throw Error("Binary file.");
    return text;
  }
  accountIndexMetadata(value:unknown){
    const tokens=Math.ceil(Buffer.byteLength(JSON.stringify(value),"utf8")/3);
    if(this.used+tokens>this.budget)throw Error("Repository context budget exhausted. Use the context already returned.");
    this.used+=tokens;this.log({type:"context.symbol",estimatedTokens:tokens,used:this.used,budget:this.budget});
  }
  private emit(file:string,reason:string,block:string,first:number) {
    // Estimate using UTF-8 bytes / 3; provider usage is logged separately.
    const prefix=file+":"+first+"\n";
    if (this.observed.get(file)?.includes(block)) {
      this.log({type:"context.repeated",file,first,reason});
      return prefix+"[This excerpt was supplied earlier in this turn.]";
    }
    const remaining=(this.budget-this.used)*3-Buffer.byteLength(prefix);
    if(remaining<16) throw Error("Repository context budget exhausted. Use the context already returned.");
    const lines=block.split("\n");
    while(lines.length && Buffer.byteLength(lines.join("\n"))>remaining) lines.pop();
    if(!lines.length) throw Error("Repository context budget exhausted.");
    block=lines.join("\n");
    this.discovered.add(file);
    this.reasons.set(file,reason);
    this.observed.set(file,[...(this.observed.get(file)??[]),block]);
    this.evidence=[...this.evidence.filter(e=>e.path!==file||e.first!==first),{path:file,first,text:block.slice(0,600),sourceHash:createHash("sha256").update(this.source(file)).digest("hex")}].slice(-12);
    const result=prefix+block;
    const tokens=Math.ceil(Buffer.byteLength(result)/3);
    this.used+=tokens;
    this.log({type:"context",file,reason,first,lines:lines.length,estimatedTokens:tokens,used:this.used,budget:this.budget});
    return result;
  }
  directory(prefix="",suffix?:string) {
    if(prefix && (prefix.startsWith("/") || prefix.replace(/\/$/,"").split("/").some(p=>p===".."||p==="."||!p)))throw Error("Invalid directory.");
    const dir=prefix?prefix.replace(/\/$/,"")+"/":"";
    const entries=new Set<string>();
    for(const file of this.files) {
      if(!file.startsWith(dir)||suffix&&!file.endsWith(suffix))continue;
      const rest=file.slice(dir.length);
      const slash=rest.indexOf("/");
      entries.add(slash<0?file:dir+rest.slice(0,slash+1));
    }
    const names=[...entries].sort((a,b)=>Number(b.endsWith("/"))-Number(a.endsWith("/"))||a.localeCompare(b)).slice(0,30);
    const lines:string[]=[];
    for(const name of names) {
      const line=name+"\n";
      if(this.used+Math.ceil(Buffer.byteLength(line)/3)>this.budget)break;
      lines.push(name);
      this.used+=Math.ceil(Buffer.byteLength(line)/3);
      if(!name.endsWith("/")){this.discovered.add(name);this.reasons.set(name,"filename listed under "+(dir||"."));}
    }
    this.log({type:"context.directory",directory:dir||".",suffix,entries:lines,used:this.used,budget:this.budget});
    return lines.join("\n")||"No matching tracked files within context budget.";
  }
  /** GUI-launched VS Code may not inherit the user's shell PATH. */
  private searchLines(query:string,files:string[],whole:boolean,limit:number,cache:Map<string,string>):string {
    try {
      if(this.rgMissing)throw Object.assign(new Error("rg unavailable"),{code:"ENOENT"});
      return execFileSync("rg",["--no-config","--no-ignore","-i","-F",...(whole?["-w"]:[]),"-n","-H","-m",String(limit),"--max-columns",whole?"300":"400","-e",query,"--",...files],{cwd:this.root,encoding:"utf8",maxBuffer:2_000_000});
    } catch(error) {
      const e=error as NodeJS.ErrnoException & {status?:number};
      if(e.status===1)return "";
      if(e.code!=="ENOENT")throw Error(`Repository search failed (${e.code??e.status??"unknown"}).`);
      if(!this.rgMissing)this.log({type:"search.fallback",reason:"ripgrep unavailable in VS Code PATH; using bounded local search"});
      this.rgMissing=true;
      const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      const pattern=whole?new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`,"i"):undefined;
      const rows:string[]=[];
      for(const file of files){
        let text:string;try{const cached=cache.get(file);text=cached??this.source(file);if(cached===undefined)cache.set(file,text);}catch{continue;}
        let hits=0;const lines=text.split("\n");
        for(let i=0;i<lines.length&&hits<limit;i++){
          if(pattern?pattern.test(lines[i]):lines[i].toLowerCase().includes(query.toLowerCase())){
            rows.push(`${file}:${i+1}:${lines[i].slice(0,whole?300:400)}`);hits++;
          }
        }
      }
      return rows.join("\n");
    }
  }
  search(terms:string[],suffix?:string) {
    if (!terms.length) throw Error("Provide query or terms.");
    this.log({type:"search",terms,suffix});
    const files=this.files.filter(f=>!suffix||f.endsWith(suffix));
    const key=JSON.stringify([terms.map(x=>x.toLowerCase()),suffix??""]);
    const fingerprint=createHash("sha256");
    for(const file of files){try{fingerprint.update(file).update("\0").update(this.source(file)).update("\0");}catch{fingerprint.update(file).update("\0[unavailable]\0");}}
    const version=fingerprint.digest("hex"),previous=this.searchCache.get(key);
    if(previous?.fingerprint===version){this.log({type:"search.repeated",terms,suffix});return `Already searched at this source version. ${previous.summary} Use existing evidence or search for missing information.`;}

    if (!files.length) return "No matching file types.";
    const cache=new Map<string,string>();
    const hits=new Map<string,{score:number;line:number;matched:Set<string>}>();
    for (const q of terms) {
      const t=q.toLowerCase();
      for(const f of files.filter(f=>f.toLowerCase().includes(t))) {
        const h=hits.get(f)??{score:0,line:1,matched:new Set<string>()};
        h.score+=3;h.matched.add(q);hits.set(f,h);
      }
      const output=this.searchLines(q,files,false,4,cache);
      for(const line of output.split("\n")) {
        const m=/^([^:]+):(\d+):(.*)$/.exec(line);
        if(!m||!files.includes(m[1])) continue;
        const h=hits.get(m[1])??{score:0,line:0,matched:new Set<string>()};
        if (!h.line||h.line===1) h.line=Number(m[2]);
        h.score+=h.matched.has(q)?0.25:2;h.matched.add(q);hits.set(m[1],h);
      }
    }
    const ranked=[...hits].sort((a,b)=>b[1].score-a[1].score||a[0].length-b[0].length||a[0].localeCompare(b[0]));
    const out=[];
    for(const [f,h] of ranked.slice(0,this.searchResultLimit)) {
      if(this.used>=this.budget-10)break;
      const content=this.source(f).split("\n")[h.line-1]?.slice(0,180)??"";
      out.push(this.emit(f,"literal/path matches "+[...h.matched].join(", ")+"; score "+h.score,content,h.line));
    }
    this.searchCache.set(key,{fingerprint:version,summary:ranked.slice(0,this.searchResultLimit).map(([file,h])=>`${file}:${h.line}`).join(", ")||"No matches."});
    return out.join("\n")||"No matches.";
  }
  investigate(goal:string) {
    const stop=new Set(["the","and","with","from","that","this","into","must","will","have","been","when","where","which","their","your","new","add","any","for","all","values","value","containing","covered","documented","alongside","other","built","prints","print","loaded","application"]);
    const focus=goal.split(/\b(?:that|which|it must|so that)\b/i)[0];
    const focusTerms=new Set((focus.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g)??[]).filter(w=>!stop.has(w)));
    const terms=[...new Set((goal.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g)??[]).filter(w=>!stop.has(w)))].slice(0,14);
    if(!terms.length)throw Error("Describe the requested feature with searchable words.");
    const cache=new Map<string,string>();
    const evidence=new Map<string,{line:number;matches:Set<string>;pathMatches:Set<string>}>();
    const frequencies=new Map<string,number>();
    for(const term of terms) {
      const matching=new Set<string>();
      for(const file of this.files) {
        if(file.toLowerCase().includes(term)) {
          matching.add(file);
          const e=evidence.get(file)??{line:1,matches:new Set<string>(),pathMatches:new Set<string>()};
          e.pathMatches.add(term);evidence.set(file,e);
        }
      }
      const output=this.searchLines(term,this.files,true,2,cache);
      for(const row of output.split("\n")) {
        const hit=/^([^:]+):(\d+):/.exec(row);
        if(!hit||!this.files.includes(hit[1]))continue;
        matching.add(hit[1]);
        const e=evidence.get(hit[1])??{line:Number(hit[2]),matches:new Set<string>(),pathMatches:new Set<string>()};
        if(e.matches.size===0)e.line=Number(hit[2]);
        e.matches.add(term);evidence.set(hit[1],e);
      }
      frequencies.set(term,matching.size);
    }
    const role=(file:string)=> /^(docs?\/|README(?:\.|$))|\.(?:rst|md|txt)$/i.test(file)?"documentation":/(^|\/)(tests?|specs?)(\/|_|\.|$)/i.test(file)?"test":"implementation";
    const score=(file:string,e:{matches:Set<string>;pathMatches:Set<string>})=>
      [...new Set([...e.matches,...e.pathMatches])].reduce((sum,term)=>{
        const weight=1+Math.log2((this.files.length+1)/(1+(frequencies.get(term)??0)));
        return sum+weight*(e.pathMatches.has(term)?2.5:1)*(focusTerms.has(term)?3:0.2);
      },0);
    const ranked=[...evidence].map(([file,e])=>({file,e,kind:role(file),score:score(file,e)+
      (role(file)==="test"&&/(^|\/)(?:test|spec)[_\-.]/i.test(file)?3:0)-
      (role(file)==="test"&&!/\.(?:py|ts|js|rs|go)$/i.test(file)?6:0)}))
      .sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file));
    const primary=ranked.find(x=>x.kind==="implementation");
    const affinity=new Set(primary?.file.toLowerCase().match(/[a-z]{3,}/g)??[]);
    const result:Record<string,{path:string;line:number;score:number;reason:string;excerpt:string;navigation:{line:number;text:string}[]}[]>={implementation:[],test:[],documentation:[]};
    for(const kind of ["implementation","test","documentation"]){
      const selected=ranked.filter(x=>x.kind===kind).sort((a,b)=>
        (b.score+(kind!=="implementation"&&[...affinity].some(t=>b.file.toLowerCase().includes(t))?3:0))-
        (a.score+(kind!=="implementation"&&[...affinity].some(t=>a.file.toLowerCase().includes(t))?3:0))||a.file.localeCompare(b.file)).slice(0,1);
      for(const {file,e,score:rank} of selected){
        const sourceLines=this.source(file).split("\n");
        const testSymbol=kind==="test"&&e.line<10?sourceLines.findIndex(line=>/^\s*(?:def|async def|function|test\()\s*test/i.test(line)):-1;
        const hitLine=testSymbol>=0?testSymbol+1:e.line;
        const navigation=sourceLines.flatMap((line,index)=>{
          const lower=line.toLowerCase();
          const matched=[...focusTerms].filter(term=>lower.includes(term));
          if(!matched.length||!/^\s*(?:@|def |async def |class |function |export |.*\b(?:add|register|attach)_[a-z]+\b)/i.test(line))return [];
          return [{line:index+1,text:line.trim().slice(0,100),priority:matched.length*2+(/\b(?:add|register|attach)_[a-z]+\b/i.test(line)?4:0)+(/^\s*@/.test(line)?2:0)}];
        }).sort((a,b)=>b.priority-a.priority||a.line-b.line).slice(0,6);
        if(kind==="implementation"&&navigation.length)this.investigationAnchors.set(file,navigation.map(item=>item.line).sort((a,b)=>a-b));
        const first=Math.max(1,hitLine-4);
        const reason=kind+" candidate; path terms="+[...e.pathMatches].join(",")+"; content terms="+[...e.matches].join(",");
        const excerpt=this.emit(file,reason,sourceLines.slice(first-1,first+10).join("\n").slice(0,1200),first);
        result[kind].push({path:file,line:hitLine,score:Math.round(rank*10)/10,reason,excerpt,navigation:navigation.map(({line,text})=>({line,text}))});
      }
    }
    if(result.implementation[0])this.lastReadFile=result.implementation[0].path;
    this.log({type:"context.investigation",goalTerms:terms,selected:Object.fromEntries(Object.entries(result).map(([k,v])=>[k,v.map(x=>({path:x.path,reason:x.reason,score:x.score}))])),used:this.used,budget:this.budget});
    return result;
  }
  read(file:string,start:number|undefined,anchor:string|undefined,count:number,reason:string,charLimit=1800) {
    count=Math.min(Math.max(1,count),this.maxReadLines);
    const text=this.source(file);
    const hash=createHash("sha256").update(text).digest("hex");
    const lines=text.split("\n");
    if(lines.at(-1)==="")lines.pop();
    const key=JSON.stringify([file,start,anchor,count]);
    const first=anchor?lines.findIndex(l=>l.includes(anchor)):((start??1)-1);
    if(first<0||first>=lines.length)throw Error("Location not found.");
    const explicit=start!==undefined||anchor!==undefined;
    const prior=this.readRanges.get(file)??[];
    if(explicit&&prior.some(r=>r.hash===hash&&r.first<=first+1&&r.last>=Math.min(lines.length,first+count))){
      this.log({type:"context.overlap",file,first:first+1,last:Math.min(lines.length,first+count)});
      return `${file}:${first+1}\n[This range was already read at the current source version. Use the evidence already returned; read a different range if needed.]`;
    }
    if(explicit&&prior.some(r=>r.hash===hash&&r.first<=Math.min(lines.length,first+count)&&r.last>=first+1))this.log({type:"context.partial_overlap",file,first:first+1,last:Math.min(lines.length,first+count)});
    const continuation=start===undefined&&!anchor&&file===this.lastReadFile?this.lastReadEnd:undefined;
    let at=this.readCursors.get(key)??continuation??first;
    const anchors=this.investigationAnchors.get(file)??[];
    const nearby=anchors.some(line=>line>at&&line<=at+count+4);
    const evidenceLine=nearby?undefined:anchors.find(line=>line>at+count+4);
    if((this.readCursors.has(key)||continuation!==undefined)&&evidenceLine){
      const from=at+1;
      at=Math.max(0,evidenceLine-5);
      this.log({type:"context.evidence_jump",file,from,to:at+1,evidenceLine});
    }
    if(at>=lines.length){this.log({type:"context.end",file,first});return file+":"+lines.length+"\n[End of file; this read has no further lines.]";}
    const result=this.emit(file,at===first?reason:reason+" (continued repeated read)",lines.slice(at,at+count).join("\n").slice(0,Math.max(32,Math.min(1800,charLimit))),at+1);
    const delivered=result.slice(result.indexOf("\n")+1);
    if(!delivered.startsWith("[This excerpt was supplied earlier")){
      this.lastReadEnd=at+delivered.split("\n").length;
      this.readCursors.set(key,this.lastReadEnd);
      this.readRanges.set(file,[...prior.filter(r=>r.hash===hash),{hash,first:at+1,last:this.lastReadEnd}].slice(-50));
    }
    this.lastReadFile=file;
    return result;
  }
}
