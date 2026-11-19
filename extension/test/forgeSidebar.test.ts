import assert from "node:assert/strict";
import * as vscode from "vscode";
import {suite,test} from "mocha";
import {ForgeSidebar} from "../src/forgeSidebar";

suite("Forge sidebar bridge",()=>{
  function setup(){
    const messages:any[]=[];
    const context={extensionUri:vscode.Uri.file("/tmp/forge"),subscriptions:[]} as unknown as vscode.ExtensionContext;
    const sidebar=new ForgeSidebar(context),internal=sidebar as any;
    internal.view={webview:{postMessage:async(message:unknown)=>{messages.push(message);return true;}}};
    internal.models=["google-gemini/gemini-3-5-flash-lite"];
    return {sidebar,internal,messages};
  }
  test("validates model and input before starting and ignores duplicate starts",async()=>{
    const {sidebar,internal,messages}=setup(),starts:any[]=[];sidebar.setStart(r=>starts.push(r));
    await internal.receive({type:"start",task:"hello",model:"unknown"});assert.equal(starts.length,0);
    await internal.receive({type:"start",task:"hello",model:"google-gemini/gemini-3-5-flash-lite"});assert.equal(starts.length,1);
    await internal.receive({type:"start",task:"again",model:"google-gemini/gemini-3-5-flash-lite"});assert.equal(starts.length,1);
    assert.ok(messages.some(m=>m.type==="notice"));sidebar.dispose();
  });
  test("correlates review to run and digest; rejects invalid decisions",async()=>{
    const {sidebar,internal,messages}=setup();internal.runs=[{id:"run-1",task:"task",model:"m",status:"running",events:[]}];
    const signal=new AbortController();
    const review=sidebar.review("run-1","digest",[{hunk:{path:"a.py"},line:2},{hunk:{path:"b.py"},line:3}] as any,signal.signal);
    assert.equal(messages.at(-1).type,"review");
    await internal.receive({type:"decision",runId:"old",digest:"digest",indices:[0]});assert.ok(internal.pending);
    await internal.receive({type:"decision",runId:"run-1",digest:"wrong",indices:[0]});assert.ok(internal.pending);
    await internal.receive({type:"decision",runId:"run-1",digest:"digest",indices:[2]});assert.ok(internal.pending);
    await internal.receive({type:"decision",runId:"run-1",digest:"digest",indices:[1]});assert.deepEqual(await review,[1]);assert.equal(internal.pending,undefined);sidebar.dispose();
  });
  test("cancelled review and late events cannot approve or alter completed runs",async()=>{
    const {sidebar,internal}=setup();internal.runs=[{id:"r",task:"t",model:"m",status:"running",events:[]}];
    const c=new AbortController(),review=sidebar.review("r","d",[{hunk:{path:"a"},line:1}] as any,c.signal);c.abort();assert.equal(await review,undefined);
    sidebar.finish("r","cancelled","cancelled");const count=internal.runs[0].events.length;sidebar.event("r",{type:"delta",text:"late"});assert.equal(internal.runs[0].events.length,count);
    await internal.receive({type:"decision",runId:"r",digest:"d",indices:[0]});assert.equal(internal.pending,undefined);sidebar.dispose();
  });
  test("streams coalesce in history and session switching preserves state",async()=>{
    const {sidebar,internal,messages}=setup();internal.runs=[{id:"one",task:"a",model:"m",status:"running",events:[]},{id:"two",task:"b",model:"m",status:"complete",events:[]}];
    sidebar.event("one",{type:"delta",text:"hel"});sidebar.event("one",{type:"delta",text:"lo"});
    assert.equal(internal.runs[0].events.length,1);assert.equal(internal.runs[0].events[0].text,"hello");
    await internal.receive({type:"history",runId:"two"});assert.equal(messages.at(-1).current,"two");
    await internal.receive({type:"history",runId:"unknown"});assert.equal(internal.current,"two");sidebar.dispose();
  });
  test("webview HTML uses local resources and a restrictive CSP",()=>{
    const {sidebar}=setup();let handler:unknown;
    const webview={options:{},cspSource:"vscode-webview:",asWebviewUri:(uri:vscode.Uri)=>uri,html:"",onDidReceiveMessage:(fn:unknown)=>{handler=fn;return {dispose(){}};}};
    const view={webview,onDidDispose:()=>({dispose(){}})};
    sidebar.resolveWebviewView(view as unknown as vscode.WebviewView);
    assert.match(webview.html,/default-src 'none'/);assert.match(webview.html,/script-src 'nonce-/);assert.doesNotMatch(webview.html,/unsafe-inline/);assert.ok(handler);sidebar.dispose();
  });
  test("continue preserves the previous original task and asks to resume",async()=>{
    const {sidebar,internal,messages}=setup(),starts:any[]=[];sidebar.setStart(r=>starts.push(r));
    internal.runs=[{id:"old",task:"Add the original feature",model:"m",status:"error",events:[]}];internal.current="old";
    await internal.receive({type:"start",task:"please continue",model:"google-gemini/gemini-3-5-flash-lite"});
    assert.equal(starts[0].task,"Add the original feature");assert.equal(starts[0].resume,true);
    sidebar.finish(starts[0].runId,"error","failed");internal.runs=[];internal.current=undefined;
    await internal.receive({type:"start",task:"continue",model:"google-gemini/gemini-3-5-flash-lite"});
    assert.equal(starts.length,1);assert.ok(messages.some(m=>m.type==="notice"&&/earlier task/.test(m.text)));sidebar.dispose();
  });
});
