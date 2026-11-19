const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawnSync}=require("node:child_process");
const script=path.join(__dirname,"recover-task-b.mjs");
function fixture(items){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"forge-recovery-")));
 const files=items.map((item,index)=>{const name=item.path||`file-${index}.txt`;const target=path.join(root,name);fs.writeFileSync(target,item.current);return {path:name,originalBase64:Buffer.from(item.original).toString("base64"),proposedBase64:Buffer.from(item.proposed).toString("base64")};});
 const journal=path.join(root,"journal.json");fs.writeFileSync(journal,JSON.stringify({version:1,root,files:files.map(f=>({...f,originalBase64:Buffer.from(items[files.indexOf(f)].original).toString("base64")}))}));
 return {root,journal};
}
function run(root,journal,flag="--rollback"){return spawnSync(process.execPath,[script,journal,root,flag],{encoding:"utf8"});}

test("explicit recovery restores approved bytes and removes the completed journal",()=>{
 const f=fixture([{path:"a.py",original:"before",proposed:"after",current:"after"},{path:"b.py",original:"old",proposed:"new",current:"old"}]);
 try{const result=run(f.root,f.journal);assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(path.join(f.root,"a.py"),"utf8"),"before");assert.equal(fs.readFileSync(path.join(f.root,"b.py"),"utf8"),"old");assert.equal(fs.existsSync(f.journal),false);}
 finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("recovery preflights every file and preserves conflicts without partial writes",()=>{
 const f=fixture([{path:"a.py",original:"before",proposed:"after",current:"after"},{path:"b.py",original:"old",proposed:"new",current:"external"}]);
 try{const result=run(f.root,f.journal);assert.notEqual(result.status,0);assert.equal(fs.readFileSync(path.join(f.root,"a.py"),"utf8"),"after");assert.equal(fs.readFileSync(path.join(f.root,"b.py"),"utf8"),"external");assert.equal(fs.existsSync(f.journal),true);}
 finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("recovery requires an explicit rollback flag",()=>{
 const f=fixture([{path:"a.py",original:"before",proposed:"after",current:"after"}]);
 try{const result=run(f.root,f.journal,"--no-op");assert.equal(result.status,2);assert.equal(fs.readFileSync(path.join(f.root,"a.py"),"utf8"),"after");}
 finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
