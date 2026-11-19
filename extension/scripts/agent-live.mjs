// Headless live run of Forge agent mode through TrueForge (no VS Code).
// The reviewer is a stub: it prints the proposal and writes nothing unless FORGE_APPLY=1.
//
//   node scripts/agent-live.mjs <workspace> "<request>" model1,model2
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { runAgent } = require("../out/src/agent/agentRun.js");
const { createClient } = require("../out/src/core/trueforge.js");

const [root, request, modelList] = process.argv.slice(2);
if (!root || !request || !modelList) { console.error("usage: agent-live.mjs <workspace> <request> <model[,fallback...]>"); process.exit(2); }
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const client = await createClient(baseUrl);
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
let text = "";
const result = await runAgent({
  client, baseUrl, root: path.resolve(root), request, mentions: { files: [], symbols: [] },
  models: modelList.split(","), signal: controller.signal,
  settings: {
    contextBudget: Number(process.env.FORGE_CONTEXT_BUDGET ?? 0), maxResultChars: 0, maxOutputTokens: 0, compactAt: 0,
    tightBudgetProviders: ["groq"], maxModelCalls: Number(process.env.FORGE_MAX_CALLS ?? 40), iterationLimit: 60,
    allowedCommands: ["python", "python3", "pytest", "flask"], python: process.env.FORGE_PYTHON, commandTimeoutMs: 120000, sandboxCommands: true,
    repoMap: process.env.FORGE_REPOMAP !== "0", codeMode: false, autoVerify: true, router: { maxRetriesPerModel: 2, maxRetryDelayMs: 65000, maxSwitches: 2 },
  },
  emit: e => {
    if (e.type === "assistant.delta") { text += e.text; return; }
    if (e.type === "reasoning.delta") return;
    if (text) { console.log(stamp(), "ASSISTANT:", text.trim().slice(0, 600).replace(/\n/g, " ⏎ ")); text = ""; }
    if (e.type === "context.pack") console.log(stamp(), "CONTEXT", `${e.tokens}/${e.budget} tok in ${e.ms}ms graph=${e.graph}`, "\n" + e.files.map(f => `   - ${f.path} [${f.role}] ${f.tokens}t ${f.ranges.join(",")} :: ${f.reasons.join("; ")}`).join("\n"));
    else if (e.type === "tool.end") console.log(stamp(), "TOOL.END", e.ok ? "ok " : "ERR", `${e.ms}ms`, e.summary);
    else if (e.type === "tool.start") console.log(stamp(), "TOOL", e.title);
    else if (e.type === "usage") console.log(stamp(), "USAGE", e.inputTokens, "/", e.outputTokens, JSON.stringify(e.breakdown ?? {}));
    else console.log(stamp(), e.type.toUpperCase(), JSON.stringify(e).slice(0, 400));
  },
  review: async proposal => {
    console.log(stamp(), "REVIEW", proposal.hunks.length, "hunks", JSON.stringify(proposal.verification), proposal.note ?? "", "\n" + proposal.summary);
    const out = path.join(process.env.FORGE_OUT ?? "/tmp", "forge-proposal");
    mkdirSync(out, { recursive: true });
    for (const f of proposal.files) { const p = path.join(out, f.path); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, f.next); }
    for (const h of proposal.hunks) console.log(`--- hunk ${h.index} ${h.path}:${h.startLine + 1}\n` + [...h.removed.map(l => "-" + l), ...h.added.map(l => "+" + l)].join("").slice(0, 1500));
    return { applied: true, selected: proposal.hunks.map(h => h.index), files: proposal.files.map(f => f.path) };
  },
});
console.log(stamp(), "RESULT", JSON.stringify(result));
