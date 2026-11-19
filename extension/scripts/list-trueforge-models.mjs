import {TrueForge} from "@truefoundry/trueforge-sdk";

const baseUrl=process.env.TRUEFORGE_BASE_URL??"http://localhost:8790";
try {
  const client=new TrueForge({baseUrl,token:process.env.TRUEFORGE_TOKEN,maxRetries:0,timeoutInSeconds:10});
  const result=await client.models.list({maxRetries:0});
  const names=result.data.map(model=>model.name).filter(Boolean).sort();
  console.log(names.join("\n")||"No models configured in TrueForge.");
} catch(error) {
  console.error(`Could not list TrueForge models: ${error instanceof Error?error.name:"Error"}`);
  process.exitCode=1;
}
