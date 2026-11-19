# Implementation roadmap

## Smallest next milestone

Build a **read-only, preview-only Task A vertical slice**:

1. Add a VS Code command that captures the current selection and document version.
2. Open a TrueForge session using a configured agent and a local read-only MCP server.
3. Stream events into an output channel or simple webview, showing session ID, turn ID, tool calls, deltas, and terminal state.
4. Ask TrueForge for a proposed patch but do not apply it.
5. Render the proposal in the standard VS Code diff editor.
6. Add an explicit “accept all / reject all” boundary only after the preview is stable.

This milestone exercises A1, A3, B2, and B4 without prematurely building autonomous writes or a custom agent loop.

## Ranked engineering risks

| Priority | Area | Marks affected | Difficulty | Risk | Dependencies | Relative effort | Recommendation |
|---:|---|---:|---:|---:|---|---:|---|
| 1 | Diff safety / transactional apply | A1, B2, A3 | High | High | Selection identity, patch model, cancellation | High | Make every write preview-first, version-checked, and undoable. |
| 2 | TrueForge session + streaming adapter | A3, B4, B3 | Medium-high | High | Model config, SDK version, event index | Medium-high | Persist session/turn/sequence IDs and handle terminal states explicitly. |
| 3 | MCP editor tools | A2, B2, B4 | High | High | TrueForge agent spec, approval policy | High | Start read-only: open document, selection, search; add writes behind approvals. |
| 4 | Repository discovery/context | A2, B1 | High | Medium-high | Workspace indexing, budgets, ranking | High | Begin lexical search and open-file context; defer vector DB. |
| 5 | Multi-file patch proposal | A2, B2 | High | High | MCP tools, patch model, diff UI | Medium-high | Apply as a transaction after all hunks are approved. |
| 6 | Cancellation and stale-state recovery | A3, B2, B3 | Medium-high | High | SDK cancel/resume, document versions | Medium | Treat cancellation as a state transition; ignore late events. |
| 7 | Provider fallback | B3, B4 | Medium | Medium-high | Two configured models, error classification | Medium | First verify native support; otherwise coordinate fallback at application boundary. |
| 8 | Demo/write-up/video | C1, C2 | Medium | Medium | Stable vertical slice and evidence | Medium | Capture repeatable evidence after each milestone. |

## Suggested phases

### Phase 1 — Read-only agent plumbing

- Add configuration validation and a bounded health check.
- Use TrueForge SDK sessions and streams.
- Add a local MCP server with read-only editor/repository tools.
- Render raw structured events in an output panel.
- Record session and turn IDs.

### Phase 2 — Safe single-file edit

- Capture `@file` / `@symbol` and current selection.
- Request a patch from TrueForge.
- Render the patch with `vscode.diff` and a proposal model.
- Add accept/reject all, then per-hunk state.
- Apply through a version-checked `WorkspaceEdit` and preserve undo.

### Phase 3 — Multi-file autonomous task

- Add repository search and related-file discovery tools.
- Expose write tools with TrueForge approval requirements.
- Present all resulting hunks before commit.
- Run validation commands through a controlled tool and report output.

### Phase 4 — Resilience and benchmark rehearsals

- Fault-inject unreachable server, invalid credentials, timeout, disconnect, and cancellation.
- Ensure no writes occur on any pre-approval or failed path.
- Verify Task A and Task B using a disposable Flask clone.
- Verify fallback only after a real two-provider local setup.

## Explicit non-goals

Do not add a vector database, model training, cloud deployment, user auth, marketplace publishing, tab autocomplete, or a separate custom agent loop during these phases.

