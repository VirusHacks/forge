# TrueForge setup for Forge

Forge is a client of a local TrueForge server. TrueForge runs the agent loop and makes every model call; Forge creates sessions and turns through the TypeScript SDK and exposes the editor as MCP tools.

## Start TrueForge

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' MODEL_HTTP_MAX_RETRIES=0 npx @truefoundry/trueforge@0.185.1
```

- `OUTBOUND_URL_ALLOWED_HOSTS` lets TrueForge reach Forge's loopback MCP server.
- `MODEL_HTTP_MAX_RETRIES=0` leaves retries to Forge's router, so every retry and fallback is visible in the editor.

Open http://localhost:8790 and add model providers under **Settings → Models**. See [config/model-providers.example.json](config/model-providers.example.json); keys stay in TrueForge, never in this repository.

## Agent definitions

[agents/forge-agent.json](agents/forge-agent.json) (agent mode) and [agents/forge-inline.json](agents/forge-inline.json) (inline edit) are exported from the same functions that build the live specs (`npm --prefix extension run compile && node extension/scripts/export-agents.mjs`). At runtime Forge fills in the selected model and its MCP connector URL, registers the named agent, and opens each session with an inline copy of the spec so a fallback can update the model of the running session.

TrueForge features used:

| Feature | Where | Why |
|---|---|---|
| Sessions, turns, streamed events | every run | streaming text, reasoning, tool calls; cancellation via `sessions.cancel` |
| Remote MCP server | editor tools | the agent decides what to search, read, stage and run |
| `requireApprovalForTools` | `submit_for_review`, `propose_edit` | TrueForge's approval request drives the per-hunk diff review |
| Deferred tool loading (`preloadTools`) | agent mode | 5 core tools preloaded; `find_symbol`, `list_files`, `view_staged`, `discard_staged` load on demand via `list_tools`, shown in the sidebar timeline |
| Context compaction | agent mode | triggered per model profile (5.2k tokens on tight free tiers, 18k otherwise); visible as compaction events in the session and the sidebar |
| Large tool response handling | both agents | oversized tool output is handled by the harness instead of flooding context |
| `sessions.update` + `previousTurnId` | fallback | switch models inside the same session without losing tool results |

Code Mode (TrueForge's local sandbox) is available behind `forge.codeMode`. We measured it adding ~1.8k harness tokens per request (213 → 1,978), which cuts throughput on Groq's 7k tokens-per-minute free tier by about 3×, so batched MCP tools are the default.

## Task C provider

For the resilience demo, create the `forge-demo-broken` provider from the example file (an endpoint nothing listens on). Select `forge-demo-broken/unreachable` in Forge and either list a working model in `forge.fallbackModels` (automatic fallback) or leave it empty (clear error). In both cases the workspace stays unchanged.
