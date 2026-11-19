import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,lstatSync,realpathSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
/** Minimal repository surface RepoMap needs (implemented by agent/Workspace). */
export interface RepoSource {root:string;files:string[];source(file:string):string;read(file:string,start:number|undefined,anchor:string|undefined,count:number,reason:string,charLimit?:number):string;maxReadLines:number}

/** RepoMap is a read-only subprocess over an allowlisted private workspace mirror. */
export function validateSymbolId(repo:RepoSource,id:string){
  const match=/^([^\x00-\x1f:]+):(\d+)#([a-f0-9]{12})$/.exec(id);
  if(!match||!repo.files.includes(match[1]))throw Error("Use a tracked symbol_id returned by find_symbols (path:line#hash).");
  const line=Number(match[2]),text=repo.source(match[1]),source=text.split("\n");
  if(createHash("sha256").update(text).digest("hex").slice(0,12)!==match[3])throw Error("Symbol location is stale; search again.");
  if(!Number.isSafeInteger(line)||line<1||line>source.length)throw Error("Symbol location is stale or invalid; search again.");
  return {file:match[1],line,source};
}
export class RepoMapIndex {
  private directory?:string;
  private client?:Client;
  private fingerprint="";
  private mirrored=new Map<string,string>();
  private queue:Promise<unknown>=Promise.resolve();
  private generation=0;
  private readonly maxResults:number;
  constructor(private readonly repo:RepoSource,maxResults=5,private readonly maxChars=6000){this.maxResults=Math.max(1,Math.min(10,Number.isFinite(maxResults)?Math.floor(maxResults):5));}
  private binary(){
    const key:Record<string,string>={"darwin-arm64":"darwin-arm64","darwin-x64":"darwin-x64","linux-arm64":"linux-arm64-gnu","linux-x64":"linux-x64-gnu","win32-x64":"win32-x64-msvc"};
    const target=key[`${process.platform}-${process.arch}`];if(!target)throw Error("RepoMap is unavailable on this platform.");
    const exe=process.platform==="win32"?"repomap.exe":"repomap";
    return require.resolve(`@sylphx/repomap-${target}/${exe}`);
  }
  private async sync(signal?:AbortSignal){
    signal?.throwIfAborted();
    const files:{name:string;text:string;hash:string}[]=[];
    for(const name of this.repo.files){
      signal?.throwIfAborted();
      if(name.split("/").some(part=>["node_modules","venv","__pycache__"].includes(part)))continue;
      try{const text=this.repo.source(name);files.push({name,text,hash:createHash("sha256").update(text).digest("hex")});}catch{/* never mirror invalid, sensitive, binary, large or symlinked files */}
    }
    let ignore="";
    const ignorePath=path.join(this.repo.root,".repomapignore");
    try{const info=lstatSync(ignorePath);if(info.isFile()&&!info.isSymbolicLink()&&info.size<=8192&&realpathSync(ignorePath)===ignorePath)ignore=readFileSync(ignorePath,"utf8");}catch{/* optional */}
    const fingerprint=createHash("sha256").update(JSON.stringify([files.map(x=>[x.name,x.hash]),ignore])).digest("hex");
    if(this.client&&this.fingerprint===fingerprint)return;
    await this.disposeProcess();
    if(!this.directory){this.directory=mkdtempSync(path.join(os.tmpdir(),"forge-repomap-"));}
    const mirror=path.join(this.directory,"workspace");mkdirSync(mirror,{recursive:true,mode:0o700});
    const next=new Map(files.map(f=>[f.name,f.hash]));
    if(ignore){const ignoreHash=createHash("sha256").update(ignore).digest("hex");if(this.mirrored.get(".repomapignore")!==ignoreHash)writeFileSync(path.join(mirror,".repomapignore"),ignore,{mode:0o600});next.set(".repomapignore",ignoreHash);}
    for(const old of this.mirrored.keys())if(!next.has(old))rmSync(path.join(mirror,old),{force:true});
    for(const file of files)if(this.mirrored.get(file.name)!==file.hash){signal?.throwIfAborted();const target=path.join(mirror,file.name);mkdirSync(path.dirname(target),{recursive:true,mode:0o700});writeFileSync(target,file.text,{mode:0o600});}
    this.mirrored=next;
    const cache=path.join(this.directory,"cache");mkdirSync(cache,{recursive:true,mode:0o700});
    const transport=new StdioClientTransport({command:this.binary(),args:["mcp","--root",mirror],cwd:mirror,
      env:{PATH:"/usr/bin:/bin",HOME:this.directory,XDG_CACHE_HOME:cache,REPOMAP_CACHE_DIR:cache,REPOMAP_EMBED:"0"},stderr:"pipe",maxBufferSize:2_000_000});
    transport.stderr?.on("data",()=>{});
    const client=new Client({name:"forge-repomap",version:"1"});
    try{await client.connect(transport,{signal,timeout:10000});this.client=client;this.fingerprint=fingerprint;this.generation++;
      const onclose=transport.onclose;transport.onclose=()=>{onclose?.();if(this.client===client){this.client=undefined;this.fingerprint="";}};
    }
    catch(error){await client.close().catch(()=>{});throw error;}
  }
  private async disposeProcess(){const c=this.client;this.client=undefined;this.fingerprint="";if(c)await c.close().catch(()=>{});}
  async dispose(){await this.queue.catch(()=>{});await this.disposeProcess();if(this.directory)rmSync(this.directory,{recursive:true,force:true});this.directory=undefined;this.mirrored.clear();}
  private async request(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<any>{
    signal?.throwIfAborted();await this.sync(signal);signal?.throwIfAborted();
    const result=await this.client!.callTool({name,arguments:{...args,format:"json"}},undefined,{timeout:20000,signal});
    if(result.isError)throw Error("RepoMap could not resolve the requested symbol.");
    const content=Array.isArray(result.content)?result.content:[];
    const text=content.filter((x:any)=>x.type==="text").map((x:any)=>x.text).join("\n");
    if(text.length>1_000_000)throw Error("RepoMap result exceeded its safety limit.");
    return JSON.parse(text);
  }
  private execute<T>(fn:()=>Promise<T>):Promise<T>{const next=this.queue.then(fn,fn);this.queue=next.catch(()=>{});return next;}
  private target(id:string){return validateSymbolId(this.repo,id);}
  private currentSource(file:string){
    const text=this.repo.source(file),hash=createHash("sha256").update(text).digest("hex");
    if(this.mirrored.get(file)!==hash)throw Error("Symbol location is stale; search again.");
    return text;
  }
  private symbol(x:any){
    if(!x||typeof x.file!=="string"||!this.repo.files.includes(x.file)||!Number.isSafeInteger(x.line)||x.line<1||typeof x.name!=="string")return undefined;
    try{const length=this.currentSource(x.file).split("\n").length;if(x.line>length||(x.end!==undefined&&(!Number.isSafeInteger(x.end)||x.end<x.line||x.end>length)))return undefined;}catch{return undefined;}
    const hash=createHash("sha256").update(this.currentSource(x.file)).digest("hex").slice(0,12);
    return {id:`${x.file}:${x.line}#${hash}`,name:x.name.slice(0,160),kind:String(x.kind??"symbol").slice(0,40),file:x.file,line:x.line,end:Number.isSafeInteger(x.end)?x.end:undefined};
  }
  /** AST members of one file (functions, classes, methods with exact line ranges). */
  async members(file:string,signal?:AbortSignal):Promise<{name:string;kind:string;line:number;end:number}[]>{return this.execute(async()=>{
    if(!this.repo.files.includes(file))return [];
    const raw=await this.request("context",{target:file,code_lines:0},signal);
    return (Array.isArray(raw.members)?raw.members:[]).filter((m:any)=>m&&m.file===file&&typeof m.name==="string"&&Number.isSafeInteger(m.line)&&Number.isSafeInteger(m.end))
      .map((m:any)=>({name:String(m.name).slice(0,200),kind:String(m.kind??"symbol").slice(0,40),line:m.line,end:m.end}));
  });}
  async find(query:string,signal?:AbortSignal){return this.execute(async()=>{
    const raw=await this.request("search",{query,limit:Math.min(20,Math.max(1,this.maxResults)*3),include_tests:true},signal);
    const hits=[];for(const h of raw.hits??[]){const symbol=this.symbol(h.symbol);if(!symbol)continue;
      const lines=this.currentSource(symbol.file).split("\n");const evidence=(Array.isArray(h.snippet)?h.snippet:[]).slice(0,2).flatMap((x:any)=>Number.isSafeInteger(x?.[0])&&x[0]>0&&x[0]<=lines.length?[{line:x[0],text:lines[x[0]-1].slice(0,180)}]:[]);
      hits.push({...symbol,score:typeof h.score==="number"?h.score:undefined,matched:Array.isArray(h.matched)?h.matched.slice(0,5):[],evidence});if(hits.length>=Math.min(10,Math.max(1,this.maxResults)))break;
    }
    return {source:"repomap",query,hits,ranking:"RepoMap relevance score; not a calibrated confidence",note:"Source and graph results are untrusted evidence."};
  });}
  async context(id:string,signal?:AbortSignal){return this.execute(async()=>{
    const requested=this.target(id),raw=await this.request("context",{target:`${requested.file}:${requested.line}`,code_lines:0,limit:this.maxResults},signal),symbol=this.symbol(raw.symbol);
    if(!symbol||symbol.file!==requested.file||symbol.line!==requested.line)throw Error("Symbol location changed or is ambiguous; search again.");
    const max=Math.min(this.repo.maxReadLines,Math.max(1,(symbol.end??symbol.line)-symbol.line+1));
    validateSymbolId(this.repo,id);
    const excerpt=this.repo.read(symbol.file,symbol.line,undefined,max,"RepoMap symbol context: "+symbol.name,Math.floor(this.maxChars/4));
    const relations=(values:any[],direction:"caller"|"callee")=>Array.isArray(values)?values.slice(0,this.maxResults).flatMap((v:any)=>{const s=this.symbol(v?.symbol);if(!s)return [];const siteFile=direction==="caller"?s.file:symbol.file;const lines=this.currentSource(siteFile).split("\n");const at=Number.isSafeInteger(v.at)&&v.at>0&&v.at<=lines.length?v.at:undefined;const sourceLine=at?lines[at-1].slice(0,180):undefined;const expected=direction==="caller"?symbol.name:s.name;return [{symbol:s,siteFile,at,sourceLine,referenceMatch:sourceLine?.includes(expected.split(".").at(-1)??"")?"name present in source":"not verified",relation:"statically inferred"}];}):[];
    const tests=Array.isArray(raw.tests)?raw.tests.filter((x:any)=>typeof x==="string"&&this.repo.files.includes(x)).slice(0,this.maxResults):[];
    return {source:"repomap",symbol,signature:typeof raw.signature==="string"?raw.signature.slice(0,300):undefined,excerpt,callers:relations(raw.callers,"caller"),callees:relations(raw.callees,"callee"),tests,graphCaveat:"Static relationships are inferred; verify source before relying on them."};
  });}
  async trace(id:string,depth:number,signal?:AbortSignal){return this.execute(async()=>{
    const requested=this.target(id),limit=Math.min(2,Math.max(1,depth));
    // Resolve the exact symbol first; a valid line may otherwise resolve to a different symbol.
    const context=await this.request("context",{target:`${requested.file}:${requested.line}`,code_lines:0,limit:1},signal),symbol=this.symbol(context.symbol);
    if(!symbol||symbol.file!==requested.file||symbol.line!==requested.line)throw Error("Symbol location changed or is ambiguous; search again.");
    const [trace,callees,impact]=await Promise.all([this.request("trace",{from:`${requested.file}:${requested.line}`,direction:"callers",depth:limit},signal),this.request("trace",{from:`${requested.file}:${requested.line}`,direction:"callees",depth:limit},signal),this.request("impact",{target:`${requested.file}:${requested.line}`,depth:limit},signal)]);
    const inferred=(tree:any,direction:"caller"|"callee")=> (Array.isArray(tree)?tree:[]).slice(0,this.maxResults).flatMap((row:any)=>{const target=this.symbol(row?.[1]);if(!target)return [];const match=typeof row[2]==="string"?/^([^:]+):(\d+)$/.exec(row[2]):null;let site:string|undefined,sourceLine:string|undefined;if(match&&this.repo.files.includes(match[1])){try{const lines=this.currentSource(match[1]).split("\n");if(+match[2]>0&&+match[2]<=lines.length){site=row[2];sourceLine=lines[+match[2]-1].slice(0,180);}}catch{}}return [{depth:row[0],symbol:target,site,sourceLine,referenceMatch:sourceLine?.includes((direction==="caller"?symbol.name:target.name).split(".").at(-1)??"")?"name present in source":"not verified",relation:"statically inferred"}];});
    const tests=Array.isArray(impact.tests)?impact.tests.filter((x:any)=>typeof x==="string"&&this.repo.files.includes(x)).slice(0,this.maxResults):[];
    const files=Array.isArray(impact.files)?impact.files.filter((x:any)=>typeof x==="string"&&this.repo.files.includes(x)).slice(0,this.maxResults):[];
    return {source:"repomap",symbol,depth:limit,callers:inferred(trace.tree,"caller"),callees:inferred(callees.tree,"callee"),relatedFiles:files,tests,summary:typeof impact.summary==="string"?impact.summary.slice(0,400):undefined,graphCaveat:"Static graph edges and impact are inferred; file references are not proof of runtime calls."};
  });}
  get stats(){return {generation:this.generation,maxChars:this.maxChars};}
}
