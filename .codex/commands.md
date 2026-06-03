# Commands

## Exact Match Rule

A command is valid only when the entire user prompt exactly matches one of the command formats in this file.

If the prompt contains extra words, unsupported arguments, wrong quotes, wrong spacing, or invalid characters, it is not a command.

Codex must not infer, correct, or reinterpret commands.

If a syntactically valid command cannot be executed in the current state, Codex must return a clear informational response and do nothing unsafe.

## Normal Prompt Behavior

Before creating a new active step, Codex must pass the sync gate:

- git must be available as the base sync backend;
- `.codex/state.md` must have initialized `Last Known Revision` and `Last Known Branch`;
- the current git revision and branch must match `.codex/state.md`;
- pre-existing project changes must not be present.

If the sync gate fails, Codex must not create a new active step and must require `resync` or manual resolution.

If no active step exists, the sync gate passes, and the user sends a non-command prompt, Codex must create a new active step in `.codex/current-step.md`. The prompt becomes the task.

If an active step exists and the user sends a non-command prompt, Codex must treat it as part of the current step.

A new step cannot be created while another step is active.

Before `apply`, Codex must not modify project files. Updating `.codex/current-step.md` to create or maintain the active step is allowed workflow-state maintenance, not project execution.

When a normal step starts, `.codex/current-step.md` must record the current git revision and branch as the step base. If that revision or branch changes outside the Codex flow while the step is active, Codex must stop and require `resync` before applying the step.

## current-step.md Active Format

An active step must use this structure:

```md
# Current Step

Status: active
Step ID: <id>

Task:
<original user task>

Base Sync:
Backend: git
Base Revision: <git revision>
Base Branch: <git branch>

Decisions:
<record:<id> decisions, or none>

Open Questions:
<open questions, or none>

Working Notes:
<notes useful for completing this step, or none>
```

`Step ID` must be the next report id defined by `.codex/after-step.md`.

Only `Decisions`, `Open Questions`, and `Working Notes` may be updated during an active step before `apply`, except when `forget` removes recorded decisions.

## record

Format:

```text
record:<id> "description"
```

`<id>` must:

- contain only lowercase letters, numbers, and hyphens;
- not start with `-`;
- not end with `-`;
- not contain `--`.

`description` must not be empty.

Examples:

```text
record:api-v2 "Use the v2 endpoint."
record:asset-loading "Use AssetsManager instead of direct Pixi Assets calls."
```

Behavior:

- requires an active step;
- stores or updates a decision in `.codex/current-step.md`;
- acts as upsert: the same id replaces the previous value;
- does not modify project code;
- does not run checks;
- does not finalize the step or run sync actions.

If no active step exists, return:

```text
No active step.
```

## forget by id

Format:

```text
forget:<id>
```

Behavior:

- requires an active step;
- removes one decision from the current step;
- does not cancel the step.

If no active step exists, return:

```text
No active step.
```

If the id does not exist, return an informational message and make no unsafe change.

## forget all

Format:

```text
forget
```

Behavior:

- requires an active step;
- removes all recorded decisions from the current step;
- does not cancel the step;
- preserves task, open questions, and working notes.

If no active step exists, return:

```text
No active step.
```

## apply

Format:

```text
apply
```

Behavior:

- requires an active step;
- applies the current step according to the task, recorded decisions, and working notes;
- runs required project checks;
- if checks fail, stops and keeps the same step active;
- if checks pass, runs the after-step process;
- updates Codex memory and reports;
- uses git sync when the sync rules allow it;
- completes the step.

If no active step exists, return:

```text
No active step.
```

If pre-existing project changes are detected before starting a new normal step, Codex must not mix them with a new task. It must create or keep a special step:

```text
Resolve pre-existing changes
```

and require the user to resolve that step through normal step flow.

## status

Format:

```text
status
```

Behavior:

- read-only;
- shows the current system state;
- does not modify files;
- does not run checks;
- does not create a step.

If an active step exists, show:

- Step ID;
- Task;
- Decisions;
- Open Questions;
- Step Working Notes;
- relevant state warnings.

If no active step exists, show:

- no active step;
- last completed step if known from history;
- recommended next step from `.codex/next-step.md`;
- relevant state warnings.

## details

Format:

```text
details
```

Behavior:

- read-only;
- shows the latest full report from `.codex/last-report.md`;
- does not modify files.

If no reports are available, return:

```text
No reports available.
```

## details by id

Format:

```text
details:<id>
```

`<id>` must be a positive integer.

Examples:

```text
details:1
details:42
```

Behavior:

- read-only;
- shows `.codex/reports/<id>.md`;
- does not modify files.

If the report does not exist, return:

```text
No report found for step <id>.
```

## ls-steps

Format:

```text
ls-steps:<n>
```

`<n>` must be a positive integer.

Behavior:

- read-only;
- shows the last `n` completed steps from `.codex/history.md`;
- output order must be chronological, with the latest step last;
- each row should include step id and title.

Example output:

```text
38 | Fix anticipation timing
39 | Add command system
40 | Introduce resync
```

## run-steps

Format:

```text
run-steps
```

Behavior:

- requires no active step;
- reads executable pending steps only from `.codex/steps.md`;
- never reads or executes `.codex/run-step-examples.md`;
- executes `.codex/steps.md` as an automatic atomic step chain;
- requires an initialized git sync backend;
- creates an internal checkpoint sufficient to restore project files and `.codex` state;
- the checkpoint must include transient `.codex` state that is not committed, including `.codex/state.md`, `.codex/current-step.md`, and any active chain metadata;
- active chain metadata must be stored in `.codex/state.md`;
- does not mutate `.codex/steps.md`;
- executes steps in the order written by the user;
- each chain step is applied through the normal `apply` process;
- if a step fails checks, the chain pauses inside that active step;
- after the user fixes the active step and `apply` succeeds, the chain continues automatically;
- if the chain completes successfully, the checkpoint may be discarded.

If an active step already exists, return:

```text
Active step already exists.

Continue the current step before running steps.md.
```

If `.codex/steps.md` contains `No pending steps.` or no executable step entries, return:

```text
No pending steps.
```

If git sync is unavailable or a reliable checkpoint cannot be created, do not start the chain.

## run-steps State Format

When a `run-steps` chain is active, `.codex/state.md` must include:

```text
Step Chain Mode: active
Step Chain Checkpoint: <checkpoint-id>
Step Chain Current: <step-id or title>
```

When no chain is active, `.codex/state.md` must include:

```text
Step Chain Mode: none
```

The checkpoint id must identify the project and `.codex` state snapshot needed by `abort-steps`.

## abort-steps

Format:

```text
abort-steps
```

Behavior:

- cancels an active `run-steps` chain;
- restores project files and `.codex` state to the checkpoint created before `run-steps`;
- may use destructive git rollback only to restore the checkpoint created before `run-steps`;
- must not perform partial rollback silently;
- must output an abort report.

If no step chain is active, return an informational message.

If full rollback is impossible or ambiguous, stop, explain the issue, and require manual resolution or `resync`.

## resync

Format:

```text
resync
```

Behavior:

- reconciles Codex flow memory with the current project sync state;
- uses git as the base sync backend;
- does not apply project code changes;
- does not create commits;
- does not continue an active step chain automatically unless state is clean and unambiguous.

Codex must require `resync` when it detects:

- the git revision changed outside the Codex flow;
- the git branch changed unexpectedly;
- reset, rebase, checkout, pull, merge, or revert changed history unexpectedly;
- `.codex` memory does not match current flow state;
- reports/history/state are inconsistent;
- checkpoint state is ambiguous.

`resync` must:

1. detect the current sync backend from `.codex/state.md` and the project environment;
2. verify that the base workflow can use git as its sync backend;
3. read the current git revision and compare it with the last known revision in `.codex/state.md`;
4. inspect working tree changes that could affect the active step;
5. inspect `.codex/history.md`;
6. inspect `.codex/reports/`;
7. inspect `.codex/current-step.md`;
8. determine whether the mismatch is an uninitialized baseline, external commit, rollback, branch switch, dirty project state, missing report, future report, or unknown flow state;
9. update Codex memory only when safe;
10. never delete reports automatically;
11. output a clear resync report.

External git commits must not be converted into normal Codex steps. They may be recorded as external sync events if useful.

If rollback or rewritten history invalidates reports, Codex must mark or explain affected memory as detached/outdated rather than deleting it automatically.

If an active step was based on an old git revision, Codex must suspend it or require user review.

## Removed Commands

The following commands do not exist:

```text
commit
commit "message"
apply-only
run-steps:auto
```

Manual commits should be done directly with git by the user.
