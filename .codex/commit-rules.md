# Git Sync Rules

## Purpose

This file defines how `apply` uses git as the default sync backend.

The flow core is step state, reports, history, context, and next-step recommendations. Git is used to detect external project changes, provide rollback/checkpoint support when available, and optionally create a commit for a completed step.

There is no standalone Codex `commit` command. If the user wants manual commits, they should use git directly, after which Codex must reconcile through `resync`.

## Step Sync Model

One completed step may create at most one git commit when commit creation is allowed.

The base workflow expects git sync. If git is unavailable, normal steps and `run-steps` must not start unless project-specific overrides define another sync backend.

A successful `apply` creates a git commit only when:

- the current git revision matches the step base revision;
- commit-worthy changes exist, including project changes or versioned Codex metadata;
- all required checks pass;
- the changes are allowed by commit rules;
- the commit is not empty.

If no commit-worthy changes exist after excluding transient runtime state, the step may still complete successfully without a git commit.

## Commit Message Format

Default auto-generated commit messages should use Conventional Commits:

```text
<type>: <short summary>
```

Allowed default types:

```text
feat
fix
refactor
docs
test
chore
build
ci
style
perf
```

Examples:

```text
feat: add command parser
fix: correct reel stop timing
docs: add codex workflow rules
refactor: extract asset loading service
```

A project may override this format through `.codex/overrides/commit-rules.md`.

## Verification

`apply` must run the required project checks before optional git commit creation.

Required project checks are discovered from:

- explicit user instructions for the active step;
- project-specific overrides;
- package/build configuration;
- scripts or commands conventionally named `test`, `lint`, `typecheck`, `check`, or equivalent for the detected stack;
- language or framework configuration files that define verification commands.

If no configured checks are found, this is not a check failure. Codex must report:

```text
No configured checks found.
```

and may continue finalization.

If configured checks exist but cannot be run because tools, dependencies, or configuration are missing, Codex must treat that as a check failure unless the user explicitly accepts skipping them.

If checks fail:

- no git commit is created;
- the step remains active;
- Codex reports the failure;
- the user continues within the same step.

A completed step implies required verification succeeded. Reports do not need a separate verification section.

## No Empty Commits

If there are no commit-worthy changes, Codex must not create an empty commit.

The step may still complete and must report:

```text
Step completed without git commit.
```

## Sync Baseline

`.codex/state.md` stores runtime sync state such as the selected backend and last known revision.

Default state format:

```text
Sync Backend: git
Last Known Revision: <git revision or none>
Last Known Branch: <git branch or none>
Last Sync Source: <apply:<step-id> | resync | external | none>
Step Chain Mode: <none | active>
```

State lifecycle:

- missing `.codex/state.md`, `Last Known Revision: none`, or `Last Known Branch: none` means the sync baseline is uninitialized;
- Codex must not start a normal step or `run-steps` while sync state is uninitialized;
- `resync` may initialize the baseline only after confirming the git project state is clean and unambiguous;
- a new active step must record the current git revision and branch as its base revision and branch;
- before `apply`, Codex must compare the active step base revision with the current git revision;
- if the current revision or branch changed outside the Codex flow, Codex must stop and require `resync`;
- after an optional Codex-created commit, Codex updates `.codex/state.md` with the new git revision.

When `Step Chain Mode: active`, `.codex/state.md` must also contain the active chain checkpoint id and current chain item as defined in `.codex/commands.md`.

Because git commits cannot contain their own final hash, `.codex/state.md` is runtime sync state, not completed step memory.

## Versioned Codex Memory

Completed Codex workflow memory is versioned with the project.

By default, Codex should commit changed project files and changed completed Codex metadata produced by the successful step:

```text
AGENTS.md
.codex/commands.md
.codex/commit-rules.md
.codex/after-step.md
.codex/step-report-rules.md
.codex/overrides.md
.codex/context.md
.codex/history.md
.codex/next-step.md
.codex/last-report.md
.codex/reports/*.md
.codex/run-step-examples.md
.codex/overrides/*.md
```

The optional `.codex/overrides/` directory does not need to exist until project-specific overrides are needed.

`.codex/current-step.md` may be included only in its inactive final state. It must be excluded while it contains an active step.

## Transient Runtime Files

Codex must not commit transient runtime state:

```text
.codex/state.md
.codex/checkpoints/**
.codex/tmp/**
```

Transient runtime state must still be included in `run-steps` checkpoints so `abort-steps` can restore the full flow state.

`.codex/current-step.md` must not be committed while it contains an active step.

After a successful `apply`, `.codex/current-step.md` may be committed only in its inactive final state:

```text
No active step.

Last completed step: <id>
```

A project may override commit policy through `.codex/overrides/commit-rules.md` if `.codex/overrides/` exists.

## Commit Scope

By default, Codex commits all git-tracked project changes and versioned Codex metadata produced by the current successful step, except files excluded by commit rules.

Codex should not guess which files are generated, temporary, or undesirable if the repository itself tracks them. Additional exclusions belong in project overrides.

Codex must not blindly use `git add .` if that would include active-step content or excluded transient files.

## Pre-existing Project Changes

If staged or unstaged project changes exist before starting a new step, that is an abnormal state.

Codex must not start a new normal step and mix those changes into it.

Instead, Codex must create or keep a special active step:

```text
Resolve pre-existing changes
```

The user must resolve that step through normal step flow.

## External Git Changes

If the git revision changes outside the Codex `apply` flow, Codex must require `resync`.

External commits are not normal Codex steps.

## Rollback and Reset

If reset, checkout, rebase, revert, pull, merge, or branch switch changes history unexpectedly, Codex must require `resync`.

Codex must not perform destructive git operations except when executing `abort-steps`, and only to restore the checkpoint created before `run-steps`.

## Apply Finalization Order

`apply` must follow this order:

1. verify the git sync baseline;
2. apply project changes;
3. run required checks;
4. prepare and write completed-step metadata;
5. create one git commit if allowed and needed;
6. update runtime sync state in `.codex/state.md`;
7. complete the step.

Versioned metadata must not require embedding the new commit's own hash, because a commit cannot contain its own final hash. Runtime sync state may record the final hash after the commit.

If metadata verification fails after optional git commit creation, Codex state is inconsistent and `resync` is required before continuing.
