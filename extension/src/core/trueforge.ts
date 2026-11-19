/**
 * Thin helpers around the TrueForge TypeScript SDK.
 *
 * The extension never talks to a model provider. Every model call is made by the
 * TrueForge server; this module only creates agents, sessions and turns.
 */
export type TrueForgeSdk = typeof import("@truefoundry/trueforge-sdk");
export type TrueForgeClient = InstanceType<TrueForgeSdk["TrueForge"]>;
export type AgentSpec = Record<string, unknown>;

// The extension host is CommonJS; the SDK is consumed through its ESM entry.
const dynamicImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<TrueForgeSdk>;

export async function createClient(baseUrl: string, timeoutInSeconds = 900): Promise<TrueForgeClient> {
  const { TrueForge } = await dynamicImport("@truefoundry/trueforge-sdk");
  return new TrueForge({
    baseUrl,
    ...(process.env.TRUEFORGE_TOKEN ? { token: process.env.TRUEFORGE_TOKEN } : {}),
    timeoutInSeconds,
    // Retries are owned by Forge's ModelRouter so they are visible and bounded.
    maxRetries: 0,
    stream: { reconnectionEnabled: false, maxReconnectionAttempts: 0 },
  });
}

export interface ModelInfo { name: string; modelId: string; contextLength?: number; maxOutputTokens?: number }

export async function listModels(client: TrueForgeClient): Promise<ModelInfo[]> {
  const response = await client.models.list({ maxRetries: 0 });
  return response.data.map((m: any) => ({
    name: m.name,
    modelId: m.modelId,
    contextLength: m.properties?.contextLength,
    maxOutputTokens: m.properties?.maxOutputTokens,
  }));
}

/** Create or update a named agent so it is visible under /agents/<name> in the TrueForge UI. */
export async function upsertAgent(client: TrueForgeClient, name: string, description: string, manifest: AgentSpec, signal?: AbortSignal) {
  signal?.throwIfAborted();
  for await (const agent of await client.agents.list({}, { maxRetries: 0 })) {
    if ((agent as any).name === name) {
      await client.agents.update((agent as any).id, { description, manifest } as any, { maxRetries: 0 });
      return;
    }
  }
  signal?.throwIfAborted();
  await client.agents.create({ name, description, manifest } as any, { maxRetries: 0 });
}

/** Register Forge's loopback MCP endpoint as a remote MCP server in TrueForge. */
export async function upsertMcpServer(client: TrueForgeClient, name: string, url: string, description: string) {
  await client.settings.mcpServers.createOrUpdate({ manifest: { name, type: "remote", url, description } } as any);
}

export function sessionUrl(baseUrl: string, sessionId: string) {
  return `${baseUrl.replace(/\/$/, "")}/sessions/${sessionId}`;
}
