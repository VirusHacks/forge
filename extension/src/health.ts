export type BackendStatus = "reachable" | "unreachable" | "not-configured";

export async function checkTrueForge(baseUrl: string): Promise<BackendStatus> {
  if (!baseUrl) return "not-configured";

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? "reachable" : "unreachable";
  } catch {
    return "unreachable";
  }
}

