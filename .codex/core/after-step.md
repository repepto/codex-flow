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

Override files must follow `.codex/core/overrides.md`; full-file replacement with `#replace` is invalid.

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

For normal `apply`, the active step `Step ID` in `.codex/current-step.md` must match this id. For `adopt-step`, the adopted manual step id must be this id and `.codex/current-step.md` must not contain an active step. If the id is ambiguous or `.codex/reports/<next-id>.md` already exists, Codex must stop and require `resync` or manual resolution.

## Pre-finalization Phase

After checks pass but before Codex writes completed-step metadata, Codex must capture a pre-finalization recovery snapshot.

The pre-finalization recovery snapshot must be sufficient to restore:

- active `.codex/current-step.md` for a normal step;
- inactive `.codex/current-step.md` and the manual working-tree diff for `adopt-step`;
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

For `adopt-step`, completed-step metadata must clearly identify the step as an adopted manual working-tree diff and must not imply that Codex originally implemented the diff.

Git commit hash is not available yet in this phase. Versioned metadata must not require embedding the new commit's own hash.

## Git Sync Phase

Codex creates a commit only according to `.codex/core/commit-rules.md`.

When a git commit is created, it must include project changes and versioned completed-step metadata.

For a normal step or adopted manual step, completed-step metadata is commit-worthy. If no commit-worthy changes exist after excluding transient runtime state, stop and require `resync` or manual resolution.

## Required Commit Failure Recovery

This recovery is mandatory when a normal step or adopted manual step requires git commit creation and that required git commit fails after completed-step metadata was written.

If required git commit creation fails after completed-step metadata was written:

- the step is not completed;
- runtime sync state must not be updated as completed or as `apply:<step-id>`;
- for `adopt-step`, runtime sync state must not be updated as `adopt-step:<step-id>`;
- if runtime sync state was changed during the failed finalization attempt, restore it from the pre-finalization recovery snapshot;
- restore `.codex/current-step.md` from the pre-finalization recovery snapshot so it again contains the active current step or inactive pre-adoption state;
- roll back metadata created or updated by the failed finalization attempt, including `.codex/reports/<id>.md`, `.codex/last-report.md`, `.codex/history.md`, `.codex/context.md`, `.codex/next-step.md`, and the inactive final `.codex/current-step.md`;
- keep the same active step or manual working-tree diff as the only valid continuation when exact recovery succeeds.

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

`.codex/context.md` stores important long-lived project knowledge that is expensive to recover.

It is not project documentation, not a general stack description, and not a chronological log.

Do not store obvious facts such as "project uses Git" or "project has package.json".

Useful context categories include:

- architecture knowledge;
- non-obvious project constraints;
- durable important decisions;
- known pitfalls, fragile areas, surprising behavior, and previously discovered failure modes.

Before adding a new context entry, Codex must check existing entries.

If new information refines, extends, replaces, corrects, or generalizes existing knowledge, update the existing entry instead of creating a duplicate.

If unsure whether to update or create, prefer updating an existing entry.

Use stable, descriptive headings.

Do not store chat transcripts.

If an entry grows too large, around 100 lines is a review trigger, not an automatic split rule.

When an entry reaches the review trigger:

1. remove duplication;
2. merge similar ideas;
3. rewrite more compactly;
4. remove obsolete details;
5. raise the abstraction level where possible.

Do not lose important information during compaction.

Split an entry only if it still contains multiple independent logical knowledge blocks after compaction.

Never split mechanically by size or line count.

## history.md Update Policy

Every successful completed Codex step must be recorded in `.codex/history.md`.

History records completed Codex steps. External sync events discovered by `resync` are runtime sync events, not completed step history entries.

`.codex/history.md` is Codex working memory for completed steps.

It is not a human-friendly changelog and not a full report archive.

Full reports live in `.codex/reports/<id>.md`.

Each completed Codex step must use this structure:

```md
## Step <id>

Title:
<short title used by ls-steps>

Sync:
<git commit hash/message>

Summary:
<what the step achieved>

Important Knowledge:
<knowledge useful for future Codex sessions>

Report:
reports/<id>.md
```

For a completed normal step or adopted manual step, record the git commit hash or message in the `Sync` field.

For an adopted manual step, `Summary` must state that `adopt-step` accepted the user's manual working-tree diff as a completed Codex step.

External sync events may be recorded in `.codex/state.md` and the resync report. They must not be appended to `.codex/history.md` by `resync`.

## next-step.md Update Policy

After every successful step, update `.codex/next-step.md`.

The next-step recommendation must be based on:

- `.codex/context.md`;
- `.codex/history.md`;
- current project and sync state;
- the completed step result.

## Reports

The canonical full report for a step is:

```text
.codex/reports/<id>.md
```

`.codex/last-report.md` is a convenience copy of the latest full report.

Create/update reports during the pre-finalization phase in this order:

1. write `.codex/reports/<id>.md`;
2. copy/update `.codex/last-report.md`.

## Failed Apply Or Adopt

If checks fail during `apply`:

- the step remains active;
- recorded decisions remain;
- current-step.md is not cleared;
- no git commit is created;
- no completed report is created;
- history is not updated as a completed step;
- Codex reports the failure and continues inside the same step.

The only normal path forward is to fix the failed step and run `apply` again.

If checks fail during `adopt-step`:

- the manual working-tree diff remains unchanged;
- `.codex/current-step.md` is not changed into an active or completed step;
- no git commit is created;
- no completed report is created;
- history is not updated as a completed step;
- Codex reports the failure and waits for the user to fix the manual diff, clean it up, or retry `adopt-step`.
