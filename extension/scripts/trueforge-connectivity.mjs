import { TrueForge, TrueForgeError } from "@truefoundry/trueforge-sdk";

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const token = process.env.TRUEFORGE_TOKEN;
const safeBaseUrl = (() => {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "invalid-url";
  }
})();
let client;

const result = {
  baseUrl: safeBaseUrl,
  healthz: "not-run",
  sdk: "not-run",
  sessions: "not-run",
  modelTurn: "not-run",
  events: [],
};

try {
  client = new TrueForge({
    baseUrl,
    ...(token ? { token } : {}),
    timeoutInSeconds: 10,
  });
  const health = await fetch(`${baseUrl.replace(/\/$/, "")}/healthz`, {
    signal: AbortSignal.timeout(3000),
  });
  result.healthz = `${health.status} ${health.ok ? "ok" : "not-ok"}`;
  if (!health.ok) throw new Error(`healthz returned ${health.status}`);

  const agents = await client.agents.list();
  let agentCount = 0;
  for await (const _agent of agents) agentCount += 1;
  const sessions = await client.sessions.list();
  let sessionCount = 0;
  for await (const _session of sessions) sessionCount += 1;
  result.sdk = "reachable";
  result.sessions = "accessible";
  result.agentCount = agentCount;
  result.sessionCount = sessionCount;

  if (process.env.TRUEFORGE_MODEL) {
    const { data: session } = await client.sessions.create({
      agent: {
        spec: {
          model: { name: process.env.TRUEFORGE_MODEL },
          instructions: "Reply with the single word READY.",
        },
      },
    });
    result.sessions = `created:${session.id}`;
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: "user.message", content: "READY" }],
    });
    for await (const event of stream) {
      result.events.push(event.type);
      if (event.type === "turn.done") result.modelTurn = event.state.status;
    }
  } else {
    result.modelTurn = "skipped-no-TRUEFORGE_MODEL";
  }
} catch (error) {
  result.error = error instanceof TrueForgeError
    ? { type: "TrueForgeError", statusCode: error.statusCode }
    : { type: error?.constructor?.name ?? "Error" };
  process.exitCode = 2;
}

console.log(JSON.stringify(result, null, 2));

