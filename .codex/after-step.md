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

Override files must follow `.codex/overrides.md`; full-file replacement with `#replace` is invalid.

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

If this integrity check fails before git commit creation:

- stop;
- do not create a git commit;
- keep the current step active;
- report the problem;
- require `resync` or manual resolution.

If a problem is detected after git commit creation, stop and require `resync`.

## Step ID Rule

The next step id is:

```text
max(completed step ids in `.codex/history.md`, numeric report filenames in `.codex/reports/`) + 1
```

If no completed steps or numeric reports exist, the next step id is `1`.

The active step `Step ID` in `.codex/current-step.md` must match this id. If the id is ambiguous or `.codex/reports/<next-id>.md` already exists, Codex must stop and require `resync` or manual resolution.

## Pre-finalization Phase

After checks pass but before Codex writes completed-step metadata, Codex must capture a pre-finalization recovery snapshot.

The pre-finalization recovery snapshot must be sufficient to restore:

- active `.codex/current-step.md` for a normal step;
- active chain step and active chain metadata for an active `run-steps` chain;
- pre-finalization contents or absence of `.codex/reports/<id>.md`;
- pre-finalization contents or absence of `.codex/last-report.md`;
- pre-finalization contents of `.codex/history.md`;
- pre-finalization contents of `.codex/context.md`;
- pre-finalization contents of `.codex/next-step.md`;
- pre-finalization contents of `.codex/state.md`;
- any other versioned Codex metadata that finalization may create or update.

After the pre-finalization recovery snapshot is captured, Codex must prepare and write completed-step metadata:

- full report content;
- short report draft, without any final commit hash;
- history update;
- context update if needed;
- next-step update;
- inactive final `.codex/current-step.md`.

Git commit hash is not available yet in this phase. Versioned metadata must not require embedding the new commit's own hash.

## Git Sync Phase

Codex creates a commit only according to `.codex/commit-rules.md`.

When a git commit is created, it must include project changes and versioned completed-step metadata.

For a normal step or final `run-steps` chain, completed-step metadata is commit-worthy. If no commit-worthy changes exist after excluding transient runtime state, stop and require `resync` or manual resolution.

During an active `run-steps` chain, per-step git commit creation is deferred. Completed-step metadata is still written for each successful chain step, but the chain creates one final git commit after all chain steps complete successfully.

## Required Commit Failure Recovery

This recovery is mandatory when a normal step or final `run-steps` chain requires git commit creation and that required git commit fails after completed-step metadata was written.

If required git commit creation fails after completed-step metadata was written:

- the step or chain is not completed;
- runtime sync state must not be updated as completed, as `apply:<step-id>`, or as `run-steps:<first-id>-<last-id>`;
- if runtime sync state was changed during the failed finalization attempt, restore it from the pre-finalization recovery snapshot;
- restore `.codex/current-step.md` from the pre-finalization recovery snapshot so it again contains the active current step or active chain step;
- roll back metadata created or updated by the failed finalization attempt, including `.codex/reports/<id>.md`, `.codex/last-report.md`, `.codex/history.md`, `.codex/context.md`, `.codex/next-step.md`, and the inactive final `.codex/current-step.md`;
- keep the same active step or active chain step as the only valid continuation when exact recovery succeeds.

If exact restoration is impossible, the pre-finalization recovery snapshot is missing or incomplete, or ownership of any metadata change from the failed finalization attempt is ambiguous, Codex must stop and require `resync` or manual resolution.

## Post-finalization Phase

After git sync, Codex must:

- verify that completed-step metadata was saved;
- verify that `.codex/current-step.md` is in inactive final state;
- update `.codex/state.md` runtime sync state;
- capture the final commit hash for the user-facing short report if a commit was created;
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

Every successful completed Codex step must be recorded in `.codex/history.md`.

History records completed Codex steps. External sync events discovered by `resync` are runtime sync events, not completed step history entries.

For a completed normal step, record the git commit hash or message in the `Sync` field.

External sync events may be recorded in `.codex/state.md` and the resync report. They must not be appended to `.codex/history.md` by `resync`.

For a completed step inside an active `run-steps` chain, record:

```text
Sync: deferred to run-steps finalization
```

A final chain report is the short user-facing report emitted after the whole `run-steps` chain completes. It is not a `.codex/reports/<id>.md` completed-step report.

The final chain report and runtime sync state must report the final chain commit hash. Do not rewrite completed per-step history or reports solely to embed the final chain commit hash.

## next-step.md Update Policy

After every successful step, update `.codex/next-step.md`.

The next-step recommendation must be based on:

- `.codex/context.md`;
- `.codex/history.md`;
- current project and sync state;
- `.codex/steps.md`;
- the completed step result.

If a step chain is active, the next recommended step must respect the user-provided `.codex/steps.md` plan.

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
