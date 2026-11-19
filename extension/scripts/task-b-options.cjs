exports.iterationLimit=(override,configured)=>{
  const value=override===undefined?configured:Number(override);
  if(!Number.isSafeInteger(value)||value<1||value>1024)throw Error("Task B iteration limit must be an integer between 1 and 1024.");
  return value;
};

exports.fallbackModels=(setting)=>{
 if(setting?.trim().toLowerCase()==="none")return [];
 return (setting??"google-gemini/gemini-3-5-flash-lite,openrouter/openrouter-free").split(",").map(x=>x.trim()).filter(Boolean);
};

exports.resumeCheckpoint=(file)=>{
 if(!file)return undefined;
 try{const fs=require("node:fs");if(fs.statSync(file).size>2_000_000)throw Error("too large");const value=JSON.parse(fs.readFileSync(file,"utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw Error("invalid");return value;}
 catch{throw Error("Could not read the Task B checkpoint.");}
};
