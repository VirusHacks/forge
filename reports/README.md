# Engineering log

These reports record how Forge was built, including failed attempts, in the order they happened. They are kept as written at the time, so early reports describe designs that were later replaced. **Start with [21-harness-v2.md](21-harness-v2.md)** for the current design and results.

| Phase | Reports |
|---|---|
| Setup and baseline | [00 environment audit](00-environment-audit.md) · [01 starter decision](01-extension-starter-decision.md) · [02 task baseline](02-task-baseline.md) · [03 issue log](03-issue-log.md) · [04 roadmap](04-implementation-roadmap.md) · [05 verification matrix](05-verification-matrix.md) |
| v1: Task A slice | [06 Task A vertical slice](06-task-a-vertical-slice.md) |
| v1: Task B attempts | [07](07-task-b-vertical-slice.md) · [08](08-working-state.md) · [09](09-implementation-checkpoint.md) · [10](10-engineering-readiness.md) · [11 first live run](11-task-b-live-run.md) · [12](12-task-b-c-readiness.md) · [14 UI recovery](14-task-b-ui-recovery.md) · [15 optimization](15-task-b-execution-optimization.md) · [17 reliability](17-task-b-reliability.md) · [18 repair guidance](18-task-b-repair-guidance.md) · [20 recovery](20-task-b-recovery-and-readiness.md) |
| v1: UI, RepoMap, resilience | [13 Cline UI study](13-cline-ui-integration.md) · [14 RepoMap integration](14-repomap-integration.md) · [15 RepoMap live](15-repomap-live-task-b.md) · [16 readiness audit](16-submission-readiness-audit.md) · [19 Task C resilience](19-task-c-resilience.md) |
| **v2: current design** | **[21 harness v2: context pack, code graph, auto-verification, same-session fallback; Tasks A, B and C live](21-harness-v2.md)** |

Raw session transcripts and checkpoints (`evidence/task-b/`) are kept private and are git-ignored. [evidence/task-b-v2-run.jsonl](evidence/task-b-v2-run.jsonl) is the event log of the successful v2 Task B run.
