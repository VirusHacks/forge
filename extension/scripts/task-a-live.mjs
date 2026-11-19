import { readFile } from "node:fs/promises";
import { rehearsalRoot } from "./task-a-worktree.mjs";
import path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { WorkspaceMcpServer } from "../out/src/workspaceMcp.js";
import { registerTaskA, taskARequest } from "../out/src/taskAAgent.js";
import { parseTaskAProposal, buildProposedDocument } from "../out/src/patchSafety.js";

const model = process.env.TRUEFORGE_MODEL;
if (!model) throw new Error("Set TRUEFORGE_MODEL to a model configured in TrueForge.");
const root = rehearsalRoot();
const file = "src/flask/helpers.py";
const source = await readFile(path.join(root, file), "utf8");
const selection = source.match(/^def get_debug_flag\([^\n]*\n(?:[ \t]+[^\n]*\n)+/m);
if (!selection) throw new Error("Could not locate get_debug_flag.");
const start = source.slice(0, selection.index).split("\n").length;
const server = new WorkspaceMcpServer(0);
const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790", token: process.env.TRUEFORGE_TOKEN, maxRetries: 0, stream: { reconnectionEnabled: false } });
const metrics = { model, modelMessages: 0, sdkRetries: 0, events: {}, usage: null };
try {
  const url = await server.start(root);
  await registerTaskA(client, model, "forge-task-a-probe", "forge-task-a-probe-tools", url, "Task A disposable worktree");
  const {data: session} = await client.sessions.create({agent: {name: "forge-task-a-probe"}});
  metrics.session = session.id;
  let completed = false;
  const stream = await client.sessions.createTurnStream(session.id, {input: [{type: "user.message", content: taskARequest(file, selection[0], start)}]}, {timeoutInSeconds: 120});
  for await (const event of stream) {
    metrics.events[event.type] = (metrics.events[event.type] ?? 0) + 1;
    if (event.type === "turn.created") metrics.turn = event.turnId;
    if (event.type === "model.message") {
      metrics.modelMessages++;
      console.log("tool requests", event.toolCalls?.map(t => t.function.name) ?? []);
    }
    if (event.type === "turn.done") {
      metrics.usage = event.state.metrics;
      if (event.state.status !== "done") throw new Error(event.state.message ?? event.state.status);
      const content = event.state.output?.content;
      const proposal = parseTaskAProposal(typeof content === "string" ? content : content?.map(p => p.text ?? "").join("\n") ?? "");
      buildProposedDocument(source, selection[0], file, proposal);
      if (!server.toolCounts.read_file || !server.toolCounts.search_repository) throw new Error("Required workspace tools were not both called.");
      console.log("Validated proposal", JSON.stringify(proposal));
      completed = true;
    }
  }
  if (!completed) throw new Error("Stream ended without a completed proposal.");
} catch (error) {
  console.error(String(error).replace(/gsk_[\w-]+|org_[\w-]+/g, "[redacted]"));
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify({...metrics, tools: server.toolCounts}));
  await server.stop();
}
