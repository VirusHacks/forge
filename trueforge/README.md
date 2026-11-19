# TrueForge Phase 0 notes

The documented local startup is:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest
```

The current official quickstart says local mode serves the UI and API at `http://localhost:8790`, stores local state in SQLite, and does not need a token. The loopback allowlist is a documented TrueForge network-policy setting; without it, TrueForge rejects the extension's loopback MCP URL by default. The TypeScript SDK package is `@truefoundry/trueforge-sdk`; the SDK mental model is Agent → Session → Turn → Event → Delta. The SDK smoke test lives at `extension/scripts/trueforge-connectivity.mjs` and performs non-model checks by default.

To exercise a model turn without hard-coding a provider:

```bash
export TRUEFORGE_BASE_URL=http://localhost:8790
export TRUEFORGE_MODEL='provider/model-id-configured-in-TrueForge'
npm --prefix extension run trueforge:smoke
```

The Task A extension connects to the local runtime with `@truefoundry/trueforge-sdk`. It lists configured models via the TrueForge API, creates or updates a named `forge-task-a-<workspace-hash>` agent definition, creates a session, and consumes `createTurnStream`. The checked-in [agent definition example](agents/forge-task-a.example.json) shows the saved manifest shape; the extension supplies the model selected from TrueForge and the workspace-specific MCP connector name at runtime.

The extension starts a read-only Streamable HTTP MCP server bound to `127.0.0.1:8791` by default. It exposes only `read_file` and `search_repository`, both constrained to the open VS Code workspace. The agent cannot write files. The extension validates a one-file replacement against the captured document and displays it in VS Code's diff editor; a separate user approval is required before applying and saving the hunk.

Configure provider credentials through **TrueForge → Settings → Models**. No provider name or API key is embedded in the extension or agent template. If no model is configured, the extension stops before creating an agent session and prompts the user to configure one in TrueForge.

