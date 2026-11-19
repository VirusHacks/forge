# VS Code extension starter decision

## Decision

Use the official TypeScript VS Code extension starter shape, implemented in `extension/`, with a small direct dependency on `@truefoundry/trueforge-sdk`. This is the lowest-risk eligibility path: the extension owns editor UX and MCP-facing integration points, while TrueForge remains the agent loop. The scaffold deliberately stops at an environment-status command and does not build a competing agent loop.

The official VS Code guide recommends Yeoman / `generator-code`, TypeScript, an unbundled project, npm, and F5 into an Extension Development Host. The current scaffold mirrors that layout and workflow without installing a global generator.

## Decision matrix

Scores are relative setup judgments for this Phase 0, not competition marks. Higher is better except for risk and complexity.

| Approach | Setup effort | Inline diff support | Accept/reject UI | Chat / streaming UI | TrueForge integration | Replace upstream loop | License / attribution | Dependency complexity | Maintainability | Eligibility risk | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A. Official TypeScript starter | Low | Low initially; VS Code APIs are direct | Low initially; must build | Low initially | High | High; no upstream loop | High; new code and standard metadata | Low | High | Low | **Selected** |
| B. Cline reuse/fork | Medium-high | High existing surface | High existing surface | High existing surface | Medium | Low-medium; agent loop is deeply integrated | Apache-2.0; preserve notices and review boundaries | High | Medium | High | Reference only |
| B. Continue components | Medium-high | Medium-high; edit/diff UI exists | Medium-high | High | Medium | Medium; IDE protocol and server/agent assumptions are substantial | Apache-2.0; preserve notices | High | Medium | Medium-high | Reference selected UI ideas only |
| B. Roo Code | High | High historically | High historically | High historically | Medium | Low-medium | Apache-2.0; repository archived May 15, 2026 | High | Low for a new fork | Medium-high | Do not start here |
| B. OpenCode VS Code SDK | Medium | Low-medium; extension mainly launches CLI | Low | Low-medium | Medium | Medium; CLI is the center of gravity | MIT | Medium | Medium | Medium | Not aligned with editor-native Phase 0 |
| C. Lightweight custom TypeScript + selected UI | Medium | Medium if components are chosen carefully | Medium if built deliberately | Medium | High | High | Depends on every reused component | Medium | High if kept small | Low-medium | Possible Phase 1 evolution |

## Findings

- Cline provides the richest directly reusable coding-agent surface, but its own orchestration, tools, permissions, and provider assumptions make it the least clean boundary for a competition where TrueForge must own the active loop.
- Continue clearly contains VS Code edit/chat/agent surfaces, but its extension communicates with a larger Continue IDE/server architecture. Reusing isolated UI or diff ideas is more defensible than forking the full runtime.
- Roo Code is not a sound foundation now because the official repository is archived and read-only as of 2026-05-15.
- OpenCode's official VS Code SDK is a thin integration around the OpenCode CLI. That is useful as a reference for terminal/session affordances but does not give us a TrueForge-owned editor loop.
- The official starter does not give inline diff UX or streaming UI for free, but that absence is a feature at the eligibility boundary: there is no hidden competing loop to disentangle.

## Foundation delivered

`extension/` contains:

- `package.json` with the VS Code contribution point `forge.environmentStatus` and pinned SDK dependency.
- TypeScript compilation, watch, unit test, and optional Extension Development Host test scripts.
- `.vscode/launch.json` with **Run Extension** and **Extension Tests** configurations, both using a temporary profile.
- `.vscode/tasks.json` for compile/watch.
- `Forge: Environment Status`, which reports activation, workspace, active file, and a bounded `/healthz` check.
- Three automated tests driven by the VS Code Test CLI: extension activation/command registration and two health-check cases.

## License and reuse rule

Do not copy an upstream extension wholesale during Phase 0. If a future milestone reuses a component, record its repository, commit, license, copyright notice, and any bundled third-party notices in an attribution file. Keep the TrueForge session/turn loop in the SDK integration layer owned by this project.

Sources: [VS Code first extension](https://code.visualstudio.com/api/get-started/your-first-extension), [Cline](https://github.com/cline/cline), [Continue](https://github.com/continuedev/continue), [Roo Code](https://github.com/RooCodeInc/Roo-Code), and [OpenCode VS Code SDK](https://github.com/anomalyco/opencode/tree/dev/sdks/vscode).

