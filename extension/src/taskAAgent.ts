import type { TrueForge } from "@truefoundry/trueforge-sdk";

const TASK_A_REQUEST =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

const AGENT_INSTRUCTIONS = "Inspect only the selected Python function. Call search_repository and read_file with the supplied arguments in one batch if possible. After the tools return, answer with one JSON object: path, originalText, replacementText, explanation. In the docstring describe the behavior of an unset variable, an explicitly empty string, and every recognized literal. Copy the original selected function exactly. Preserve unrelated behavior.";

export function taskARequest(file: string, selection: string, start: number) {
  const end = start + selection.trimEnd().split("\n").length - 1;
  return [
    TASK_A_REQUEST,
    `search_repository: ${JSON.stringify({query: "def get_debug_flag("})}`,
    `read_file: ${JSON.stringify({path: file, start_line: start, end_line: end})}`,
    `Selected source:\n${selection}`,
  ].join("\n");
}

export async function registerTaskA(client: TrueForge, modelName: string, agentName: string, mcpName: string, url: string, workspace: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name: mcpName,
      type: "remote",
      url,
      description: `Local read-only VS Code workspace tools for ${workspace}`,
    },
  });

  signal?.throwIfAborted();
  const agentSpec = {
    model: { name: modelName, params: { maxTokens: 900, temperature: 0 } },
    instructions: AGENT_INSTRUCTIONS,
    config: {
      iterationLimit: 5,
      sandbox: { enabled: false },
      askUserQuestions: { enabled: false },
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: false },
    },
    mcpServers: [{ name: mcpName, enableTools: ["read_file", "search_repository"], preload: true }],
  };
  let existingAgent: { id: string } | undefined;
  for await (const agent of await client.agents.list({}, { maxRetries: 0 })) {
    if (agent.name === agentName) {
      existingAgent = agent;
      break;
    }
  }
  signal?.throwIfAborted();
  if (existingAgent) {
    await client.agents.update(existingAgent.id, {
      description: "TrueForge agent for the selected-function Flask Task A rehearsal.",
      manifest: agentSpec,
    }, { maxRetries: 0 });
  } else {
    await client.agents.create({
      name: agentName,
      description: "TrueForge agent for the selected-function Flask Task A rehearsal.",
      manifest: agentSpec,
    }, { maxRetries: 0 });
  }
}
