import { open, sleep } from "./vscode.mjs";
const v = await open({ emulate: true });
console.log("holding emulation"); for (;;) await sleep(60000);
