# After Step Rules

## Purpose

This file defines what Codex must do after a step passes verification.

The after-step process keeps `.codex` memory, reports, and sync state consistent.

## System and Project Parts

The after-step process has two parts:

1. mandatory system actions;
2. optional project actions.

Mandatory system actions cannot be disabled by overrides.

Project-specific after-step actions may be added through `.codex/overrides/after-step.md`.

For `after-step.md`, `#replace` must not disable mandatory system actions.

## Integrity Check

Before finalizing a step, Codex must run a minimal integrity check.

Check at least:

- `.codex/state.md` exists and is readable;
- `.codex/history.md` exists and is readable;
- `.codex/reports/` exists;
- the next step id is valid;
- `.codex/reports/<next-id>.md` does not already exist;
- state/history/reports do not contain obvious contradictions;
- current sync state does not require `resync`.

If this integrity check fails before optional git commit creation:

- stop;
- do not create a git commit;
- keep the current step active;
- report the problem;
- require `resync` or manual resolution.

If a problem is detected after optional git commit creation, stop and require `resync`.

## Step ID Rule

The next step id is:

```text
max(completed step ids in `.codex/history.md`, numeric report filenames in `.codex/reports/`) + 1
```

If no completed steps or numeric reports exist, the next step id is `1`.

The active step `Step ID` in `.codex/current-step.md` must match this id. If the id is ambiguous or `.codex/reports/<next-id>.md` already exists, Codex must stop and require `resync` or manual resolution.

## Pre-finalization Phase

After checks pass but before optional git commit creation, Codex must prepare and write completed-step metadata:

- full report content;
- short report content;
- history update;
- context update if needed;
- next-step update;
- inactive final `.codex/current-step.md`.

Git commit hash is not available yet in this phase. Versioned metadata must not require embedding the new commit's own hash.

## Optional Git Sync Phase

Codex creates a commit only according to `.codex/commit-rules.md`.

When a git commit is created, it should include project changes and versioned completed-step metadata.

If no commit-worthy changes exist after excluding transient runtime state, skip commit creation.

## Post-finalization Phase

After optional git sync, Codex must:

- verify that completed-step metadata was saved;
- verify that `.codex/current-step.md` is in inactive final state;
- update `.codex/state.md` runtime sync state;
- capture the final commit hash for the short report if a commit was created;
- avoid creating uncommitted versioned metadata solely to store the new commit's own hash.

## current-step.md Final State

After a successful step, `.codex/current-step.md` must continue to exist and contain:

```text
No active step.

Last completed step: <id>
```

It must not include the new commit's literal hash when that hash would refer to the containing commit. If a commit was created, the final hash belongs in the post-finalization short report and runtime sync state.

Codex must not automatically create a new step from `.codex/next-step.md`.

## context.md Update Policy

Do not update `.codex/context.md` just because files changed.

Update it only when the step produced important project knowledge that is expensive to recover, architecturally meaningful, or useful for future Codex sessions.

Most steps should not update `context.md`.

## history.md Update Policy

Every successful completed step must be recorded in `.codex/history.md`.

This is true even if the step created no git commit.

History records completed Codex work, not only git commits.

If no git commit or external sync event exists, record:

```text
Sync: none
```

## next-step.md Update Policy

After every successful step, update `.codex/next-step.md`.

The next-step recommendation must be based on:

- `.codex/context.md`;
- `.codex/history.md`;
- current project and sync state;
- `.codex/steps.md`;
- the completed step result.

If a step chain is active, the next recommended step should respect the user-provided `.codex/steps.md` plan.

## Reports

The canonical full report for a step is:

```text
.codex/reports/<id>.md
```

`.codex/last-report.md` is a convenience copy of the latest full report.

Create/update reports during the pre-finalization phase in this order:

1. write `.codex/reports/<id>.md`;
2. copy/update `.codex/last-report.md`.

## Failed Apply

If checks fail during `apply`:

- the step remains active;
- recorded decisions remain;
- current-step.md is not cleared;
- no git commit is created;
- no completed report is created;
- history is not updated as a completed step;
- Codex reports the failure and continues inside the same step.

The only normal path forward is to fix the failed step and run `apply` again.
