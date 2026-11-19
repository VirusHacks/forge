# Environment audit

Audit date: 2026-11-18 (Asia/Calcutta). Workspace: `<repo>`.

The target directory was empty at the start of Phase 0. It was not an existing Git repository, and `git init` was blocked by the desktop sandbox's read-only treatment of the root `.git` path. The isolated Flask fixture and scratch copies are separate Git repositories and remain usable.

| Item | Installed version | Required/compatible | Status | Action |
|---|---|---|---|---|
| OS | macOS Darwin 27.3.0 | macOS supported by VS Code and TrueForge local mode | PASS | Keep host OS. |
| Architecture | arm64 | TrueForge docs support macOS; package runs on this host | PASS | Keep native arm64. |
| Node.js on PATH | v26.7.0 | TrueForge requires Node >=22.14.0; starter is compatible | PASS | No upgrade. |
| npm | 11.19.0 | Required by starter and `npx` workflow | PASS | Use local project install. |
| pnpm | 11.25.0 fallback path | Available, but not needed for this workspace | AVAILABLE | Do not switch package managers in Phase 0. |
| Yarn | Not found | Not required | N/A | No action. |
| Homebrew | Available at `/opt/homebrew/bin/brew` | Convenient host package manager | AVAILABLE | No global packages installed for this phase. |
| Bun | Available at `/opt/homebrew/bin/bun` | Not required | AVAILABLE | No action. |
| Python 3 on PATH | 3.15.2 | Flask project declares >=3.9; its lockfile/test matrix is centered on 3.14 | COMPATIBLE WITH CAVEAT | Use uv-selected CPython 3.14.8 for the benchmark. |
| uv | 0.13.6 | Supported by Flask's project configuration and lockfile workflow | PASS | Use isolated scratch venv. |
| pip | 26.2.2 | Available | PASS | Not used for the reproducible fixture install. |
| Git | 2.55.0 | Required for fixture checkout | PASS | Flask tag resolves to required commit. |
| Git configuration | `credential.helper=osxkeychain`; Git LFS filters configured; no `user.name` or `user.email` set | Needed for private remotes/commits only | PASS FOR PUBLIC READ / NO COMMIT IDENTITY | No credentials printed or used. |
| VS Code CLI | 1.146.0 | Compatible with extension engine `^1.100.0` | PASS | F5/manual GUI verification remains. |
| VS Code extensions | `continue.continue`, `anthropic.claude-code`, `openai.chatgpt`, Python/Pylance and related tools are present | No required extension beyond VS Code itself | AVAILABLE | Existing extensions were not modified. |
| TrueForge CLI | Not installed globally | Official workflow is `npx @truefoundry/trueforge@latest` | PASS VIA NPX | Keep package local to npm cache. |
| TrueForge server | v0.185.1 from `@truefoundry/trueforge@latest` | Official docs specify localhost:8790 | PASS | Starts in standalone SQLite mode. |
| TrueForge SDK | `@truefoundry/trueforge-sdk@0.185.0` in `extension/package.json` | Official TypeScript SDK package; Node >=22 | PASS | Pin exact SDK version; server minor version is one patch newer. |
| Root Git repository | None; `git init` blocked by sandbox | Useful but not required to run scaffold | BLOCKED | Initialize in a normal terminal if repository history is desired. |
| Flask fixture | Git checkout at `22d924701a6ae2e4cd01e9a15bbaf3946094af65` | Flask 3.1.3 / requested commit | PASS | Do not edit; use scratch clones for experiments. |
| Python virtual environments | New `scratch/flask-3.1.3-venv`; unrelated existing venvs elsewhere | Isolated benchmark venv | PASS | Keep benchmark venv outside pristine fixture. |
| Package registry access | npm/uv worked with approved external access; default sandbox DNS/cache writes failed | Public package access required | PASS WITH SANDBOX CAVEAT | Rerun network-dependent setup with normal host access. |

## Compatibility decisions

- Node 26.7.0 satisfies the current TrueForge requirement; no upgrade was performed.
- The system `python3` is 3.15.2, but `uv` selected `/opt/homebrew/Caskroom/miniforge/base/bin/python` 3.14.8 for the Flask environment. That choice matches the pinned project's current lockfile/test matrix more closely.
- `npm ci` completed for the extension. `npm audit` reported 12 advisories in the test/development dependency tree (1 low, 5 moderate, 6 high; no fixes currently offered by npm). `npm audit --omit=dev` reported zero runtime dependency advisories. No automatic dependency upgrades were applied.
- TrueForge started in standalone mode with auth disabled and SQLite at `~/Library/Application Support/trueforge/db/db.sqlite`. No user provider credentials were read or changed.

## Reproduction commands

```bash
./scripts/verify-environment.sh
npm --prefix extension install
npm --prefix extension test
```

Sources checked: [TrueForge quickstart](https://trueforge.dev/quickstart), [TrueForge SDK quickstart](https://trueforge.dev/api/quickstart), [VS Code extension quickstart](https://code.visualstudio.com/api/get-started/your-first-extension), and the [Flask 3.1.3 release](https://github.com/pallets/flask/releases).

