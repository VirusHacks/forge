# Third-party notices

## Cline

- Repository: https://github.com/cline/cline
- Reference commit: `eff43e19b267e171f597ab03733bfed25090f72d`
- License: Apache License 2.0. A copy is provided in [third_party/cline/LICENSE](third_party/cline/LICENSE).
- Adapted source: `apps/vscode/webview-ui/src/components/common/ScreenReaderAnnounce.tsx`, specifically its visually hidden live-region CSS declarations, adapted to the `.screen-reader-announcement` rule in `extension/media/forge.css`. The original React component was changed into a CSS class and vanilla DOM element.
- Other Cline components and the repository were inspected for design and integration, but no other Cline source code, backend, assets, dependencies, trademarks or branding were copied.

The Cline project and its contributors retain their respective rights. The adapted rule is distributed under Apache 2.0; Forge's existing licensing continues to apply to its own code.

## RepoMap

- Repository: https://github.com/SylphxAI/repomap
- Source inspected: `0195f264a08b296801025926d5e94449abfe5c5e`; installed npm package `@sylphx/repomap` and its platform binary are pinned to `1.9.0`.
- License: MIT, Copyright (c) 2026 SylphxAI. The full notice is in [third_party/repomap/LICENSE](third_party/repomap/LICENSE).
- Forge invokes RepoMap's unmodified local MCP binary; it does not copy its indexing or graph implementation. Embedding downloads are disabled by default.
