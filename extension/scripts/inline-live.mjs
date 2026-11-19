// Headless live inline edit through TrueForge. The reviewer stub prints the diff and writes nothing.
//   node scripts/inline-live.mjs <workspace> <file> <startLine> <endLine> "<instruction>" model1,model2
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { runInlineEdit } = require("../out/src/inline/inlineEdit.js");
const { createClient } = require("../out/src/core/trueforge.js");
const { diffLines, hunkPreview } = require("../out/src/core/diff.js");

const [root, file, start, end, instruction, modelList] = process.argv.slice(2);
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const text = readFileSync(path.join(root, file), "utf8");
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
let out = "";
const result = await runInlineEdit({
  client: await createClient(baseUrl), baseUrl, root, file, languageId: "python", text,
  startLine: Number(start) - 1, endLine: Number(end) - 1, instruction, models: modelList.split(","), signal: new AbortController().signal,
  settings: { contextBudget: 0, maxResultChars: 0, maxOutputTokens: 0, compactAt: 0, tightBudgetProviders: ["groq"], maxModelCalls: 6, iterationLimit: 6,
    allowedCommands: [], commandTimeoutMs: 1000, sandboxCommands: true, repoMap: false, codeMode: false, router: { maxSwitches: 2, maxRetriesPerModel: 1, maxRateLimitWaits: 3, maxRetryDelayMs: 65000 } },
  emit: e => { if (e.type === "assistant.delta" || e.type === "reasoning.delta") { out += e.text; return; } console.log(stamp(), e.type, JSON.stringify(e).slice(0, 260)); },
  review: async p => {
    for (const h of diffLines(p.base, p.next)) console.log(`--- hunk @${h.startLine + 1}\n${hunkPreview(h, 60)}`);
    console.log("EXPLANATION:", p.explanation);
    return { applied: true, selected: diffLines(p.base, p.next).map((_, i) => i), files: [p.path] };
  },
});
if (out.trim()) console.log("STREAMED TEXT:", out.trim().slice(0, 400));
console.log(stamp(), "RESULT", JSON.stringify(result));
