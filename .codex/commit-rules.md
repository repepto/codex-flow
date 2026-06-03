# Git Sync Rules

## Purpose

This file defines how `apply` uses git as the default sync backend.

The flow core is step state, reports, history, context, and next-step recommendations. Git is required to detect external project changes, provide rollback/checkpoint support when available, and create the required commit for each completed normal step or completed `run-steps` chain.

There is no standalone Codex `commit` command. If the user wants manual commits, they should use git directly, after which Codex must reconcile through `resync`.

## Step Sync Model

One completed normal step must create exactly one git commit.

A `run-steps` chain must create exactly one git commit for the whole chain. Intermediate chain steps must not create git commits; their project changes and completed-step metadata remain accumulated chain-owned changes until the chain finalizes.

The base workflow requires git sync. If git is unavailable, normal steps and `run-steps` must not start.

A successful normal `apply` creates a git commit only when:

- the current git revision matches the step base revision;
- commit-worthy changes exist, including project changes or versioned Codex metadata;
- all required checks pass;
- the changes are allowed by commit rules;
- the commit is not empty.

Because a successful normal `apply` writes completed-step metadata, a successful normal step must create a git commit. If no commit-worthy changes exist after excluding transient runtime state, the step state is inconsistent; Codex must stop and require `resync` or manual resolution.

During an active `run-steps` chain, `apply` must skip git commit creation for each intermediate chain step. After the final chain step passes verification and completed-step metadata is written, Codex creates one final chain commit when:

- the current git revision and branch still match the chain checkpoint base;
- only chain-owned accumulated changes and allowed versioned Codex metadata are included;
- all required checks for the final chain state pass;
- the changes are allowed by commit rules;
- the commit is not empty.

Because a successful `run-steps` chain writes completed-step metadata, successful chain finalization must create a git commit. If no commit-worthy changes exist at chain finalization after excluding transient runtime state, the chain state is inconsistent; Codex must stop and require `resync` or manual resolution.

## Commit Message Format

Default auto-generated commit messages must use Conventional Commits:

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

`apply` must run the required project checks before git commit creation.

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

For a normal step or final `run-steps` chain, absence of commit-worthy changes after successful metadata preparation is inconsistent because completed-step metadata should be commit-worthy. Codex must stop and require `resync` or manual resolution.

## Sync Baseline

`.codex/state.md` stores runtime sync state such as the selected backend and last known revision.

Default state format:

```text
Sync Backend: git
Last Known Revision: <git revision or none>
Last Known Branch: <git branch or none>
Last Sync Source: <apply:<step-id> | run-steps:<first-id>-<last-id> | resync | external | none>
Strict Mode: <true | false>
Step Chain Mode: <none | active>
```

State lifecycle:

- missing `.codex/state.md`, `Last Known Revision: none`, or `Last Known Branch: none` means the sync baseline is uninitialized;
- missing `Strict Mode` means `true` until initialized or changed by the `strict:true` or `strict:false` command;
- Codex must not start a normal step or `run-steps` while sync state is uninitialized;
- `resync` may initialize the baseline only after confirming the git project state is clean and unambiguous;
- `strict:true` or `strict:false` may create a missing `.codex/state.md` only as an uninitialized default state skeleton;
- a new active step must record the current git revision and branch as its base revision and branch;
- before `apply`, Codex must compare the active step base revision with the current git revision;
- if the current revision or branch changed outside the Codex flow, Codex must stop and require `resync`;
- after the Codex-created commit, Codex updates `.codex/state.md` with the new git revision.
- after a successful `run-steps` chain, Codex updates `.codex/state.md` with `Last Sync Source: run-steps:<first-id>-<last-id>` and the final chain commit revision.

When `Step Chain Mode: active`, `.codex/state.md` must also contain the active chain checkpoint id and current chain item as defined in `.codex/commands.md`.

Because git commits cannot contain their own final hash, `.codex/state.md` is runtime sync state, not completed step memory.

## Versioned Codex Memory

Completed Codex workflow memory is versioned with the project.

By default, Codex must include changed project files and changed completed Codex metadata produced by the successful step in the required commit:

```text
AGENTS.md
.codex/commands.md
.codex/config.toml
.codex/commit-rules.md
.codex/after-step.md
.codex/step-report-rules.md
.codex/overrides.md
.codex/context.md
.codex/current-step.md
.codex/history.md
.codex/next-step.md
.codex/last-report.md
.codex/reports/*.md
.codex/run-step-examples.md
.codex/overrides/*.md
```

The optional `.codex/overrides/` directory does not need to exist until project-specific overrides are needed.

`.codex/current-step.md` must be included when it changed and is in its inactive final state. It must be excluded while it contains an active step.

## Transient Runtime Files

Codex must not commit transient runtime state:

```text
.codex/state.md
.codex/checkpoints/**
.codex/tmp/**
```

Transient runtime state must still be included in `run-steps` checkpoints so `abort-steps` can restore the full flow state.

`.codex/current-step.md` must not be committed while it contains an active step.

After a successful `apply`, `.codex/current-step.md` must be committed when it changed and is in its inactive final state:

```text
No active step.

Last completed step: <id>
```

A project may extend commit policy through `.codex/overrides/commit-rules.md` if `.codex/overrides/` exists, but only within the limits defined by `.codex/overrides.md`. Overrides must not disable or weaken the required git backend, required commit creation, no-empty-completion stop behavior, or required versioned metadata commit scope.

## Commit Scope

By default, Codex commits all git-tracked project changes and versioned Codex metadata produced by the current successful step, except files excluded by commit rules.

Codex must not guess which files are generated, temporary, or undesirable if the repository itself tracks them. Additional exclusions belong in project overrides.

Codex must not blindly use `git add .` if that would include active-step content or excluded transient files.

## Pre-existing Project Changes

If staged or unstaged project changes exist before starting a new normal step, that is an abnormal state.

Codex must not start a new normal step and mix those changes into it.

Codex must stop and require manual cleanup or `resync` after the tree is clean.

Codex must not create a special active step for pre-existing project changes.

During an active `run-steps` chain, accumulated changes created by earlier chain steps are chain-owned changes and do not count as pre-existing changes for later steps in the same chain.

## External Git Changes

If the git revision changes outside the Codex `apply` flow, Codex must require `resync`.

External commits are not normal Codex steps.

## Rollback and Reset

If reset, checkout, rebase, revert, pull, merge, or branch switch changes history unexpectedly, Codex must require `resync`.

Codex must not perform destructive git operations except when executing `abort-steps`, and only to restore the checkpoint created before `run-steps`.

## Apply Finalization Order

Normal `apply` must follow this order:

1. verify the git sync baseline;
2. apply project changes;
3. run required checks;
4. capture a pre-finalization recovery snapshot;
5. prepare and write completed-step metadata;
6. create one git commit;
7. update runtime sync state in `.codex/state.md`;
8. complete the step.

Versioned metadata must not require embedding the new commit's own hash, because a commit cannot contain its own final hash. Runtime sync state may record the final hash after the commit.

If required git commit creation fails after completed-step metadata was written, Codex must run Required Commit Failure Recovery from `.codex/after-step.md`. If recovery succeeds, the same active step continues. Otherwise Codex must stop and require `resync` or manual resolution.

If metadata verification fails after git commit creation, Codex state is inconsistent and `resync` is required before continuing.

For an intermediate step inside an active `run-steps` chain, the same order applies except git commit creation is skipped until the chain finalization phase. The required sync result for that intermediate chain step is `Sync: deferred to run-steps finalization`, and the step completes only inside the active chain.

Chain finalization must then:

1. verify the git sync baseline still matches the chain checkpoint base;
2. verify the accumulated final working tree;
3. capture a pre-finalization recovery snapshot for chain finalization state;
4. create one git commit;
5. update runtime sync state in `.codex/state.md`;
6. complete the chain and clear active chain metadata.

If final chain commit creation fails after completed-step metadata was written, Codex must run Required Commit Failure Recovery from `.codex/after-step.md` and keep the active chain state as the only valid continuation when exact recovery succeeds.
