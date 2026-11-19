// Writes the exact TrueForge agent definitions Forge registers at runtime to trueforge/agents/.
// The live specs are built by the same functions, so these files cannot drift from the code.
//   npm run compile && node scripts/export-agents.mjs
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildAgentSpec, AGENT_NAME } = require("../out/src/agent/agentRun.js");
const { buildInlineSpec, INLINE_AGENT } = require("../out/src/inline/inlineEdit.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../trueforge/agents");
mkdirSync(out, { recursive: true });

const settings = {
  contextBudget: 0, maxResultChars: 0, maxOutputTokens: 0, compactAt: 0, tightBudgetProviders: ["groq"],
  maxModelCalls: 40, iterationLimit: 80, allowedCommands: [], commandTimeoutMs: 120000, sandboxCommands: true,
  repoMap: true, codeMode: false, router: {},
};
const MODEL = "<model configured in TrueForge, e.g. google-gemini/gemini-3-5-flash>";
const CONNECTOR = "forge-workspace-<hash of workspace path>";
const files = {
  [`${AGENT_NAME}.json`]: { name: AGENT_NAME, description: "Forge agent mode (Task B). The model and MCP URL are filled in at runtime; profile shown: standard.", manifest: buildAgentSpec(MODEL, CONNECTOR, settings) },
  [`${INLINE_AGENT}.json`]: { name: INLINE_AGENT, description: "Forge inline edit (Tasks A and C).", manifest: buildInlineSpec(MODEL, CONNECTOR + "-inline", settings) },
};
for (const [name, value] of Object.entries(files)) writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");
console.log("wrote", Object.keys(files).map(f => path.join(out, f)).join(", "));
