exports.iterationLimit=(override,configured)=>{
  const value=override===undefined?configured:Number(override);
  if(!Number.isSafeInteger(value)||value<1||value>64)throw Error("Task B iteration limit must be an integer between 1 and 64.");
  return value;
};
