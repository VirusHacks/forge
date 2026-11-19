# Forge sidebar and Cline UI integration

Updated 19 November 2026.

## Cline inspection and attribution

Cline was cloned separately to `/private/tmp/forge-cline-reference` at commit `eff43e19b267e171f597ab03733bfed25090f72d` (Apache-2.0). The current VS Code frontend is `apps/vscode/webview-ui/src/`; its chat is in `components/chat`, common Markdown and code components are in `components/common`, history is in `components/history`, and the extension webview provider is `apps/vscode/src/hosts/vscode/VscodeWebviewProvider.ts`. Relevant dependencies include React, React Markdown, marked, DOMPurify, VS Code webview toolkit, Cline shared protocol, Cline state and gRPC clients.

The chat and Markdown components import Cline's generated protocol, state, tool and service clients. Importing them wholesale would bring in substantial unrelated infrastructure. Forge therefore adapts the accessible visually-hidden live-region styling from `components/common/ScreenReaderAnnounce.tsx` into `extension/media/forge.css`; its own small chat, activity, review and Markdown components use vanilla DOM and VS Code theme variables. The Apache license is included at `third_party/cline/LICENSE`; exact attribution and modifications are in `THIRD_PARTY_NOTICES.md`. No Cline agent loop, model provider, telemetry, billing, backend or other Cline code is included.

## Architecture and capabilities

The activity-bar Forge view uses `ForgeSidebar` (`extension/src/forgeSidebar.ts`) and a local webview (`extension/media/forge.js` and `forge.css`). A typed, discriminated message protocol connects the view to the existing Task B controller. The extension host alone connects to TrueForge; no provider or model traffic originates in the webview. The host validates model names, input length, active run, run ID, review digest and hunk indices. The existing validation, per-hunk diff preview, TrueForge approval, version checks, explicit save and rollback flow remain in force.

- Composer submits its actual text; **Use Task B request** fills the exact competition prompt. The current backend still requires a clean pinned Flask worktree, at least three files and the Task B-specific verifier; arbitrary coding tasks are not yet generally supported.
- The panel shows real streamed text, tool starts, selected paths/reasons, validation, model retries/fallback, errors, session and usage events. It provides Stop, a model selector, retry on error, workspace file and symbol reference pickers, in-memory session switching, and Undo through VS Code.
- Review opens existing VS Code diff tabs and presents per-hunk choices in the sidebar. Selected hunks are revalidated; the existing explicit Save All prompt controls disk writes. Stale review messages and invalid indices are rejected. Cancelling or closing a view with a pending review resolves it without approval.
- Markdown supports a safe subset: headings, bold, inline code, lists and fenced code with copy. Rendering uses DOM text nodes, never raw HTML. The webview uses a restrictive CSP, local assets, theme variables and keyboard-focus styling.

## Verification

- `npm --prefix extension run test:safety`: **48/48 passed**, including the two webview tests. These cover mocked webview streaming, task/model messages, safe text rendering, hunk decision and Stop, plus static theme variables.
- `VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm --prefix extension test`: **30/30 passed**, including five sidebar bridge tests and existing review, cancellation and transaction guards.
- `npm --prefix extension run check-types` and `node --check extension/media/forge.js`: passed. The frontend is shipped as local plain JavaScript/CSS and does not require a separate React build.
- No paid or live model calls were made in this sprint. No screenshots were captured. Visual light/dark theme review and a real sidebar-driven Task B turn remain for manual testing.

## Limitations

Session history lasts for the current extension-host lifetime; it is not restored after the host restarts. File and symbol attachments are textual references, not embedded file contents or autocomplete. Markdown is a deliberately limited subset; arbitrary links, images, tables and syntax highlighting are not rendered. Undo invokes VS Code's current undo action, so focus the edited document first. The existing Task A command and diff remain separate from the new Task B sidebar. The free-only setting filters the model selector to its allowlist; provider account billing/quota terms still apply. The new UI and changed request path have not been proven end-to-end against a live model.

## Launch

Start TrueForge, open `extension` in VS Code and press F5 using **Run Extension**. In the Extension Development Host, open a clean linked Flask worktree at commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, click the Forge lightning icon in the Activity Bar, choose a model, select **Use Task B request**, then Send. Review the real diff tabs and selected hunks; explicitly choose whether to save. Detailed Task B/C instructions and current benchmark status are in `reports/12-task-b-c-readiness.md`.
