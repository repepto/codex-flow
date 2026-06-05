# Git Sync Rules

## Purpose

This file defines how `apply` and `adopt-step` use git as the default sync backend.

The flow core is step state, reports, history, context, and next-step recommendations. Git is required to detect external project changes and create the required commit for each completed normal step or adopted manual step.

There is no standalone Codex `commit` command. If the user wants manual commits, they should use git directly, after which Codex must reconcile through `resync`.

## Step Sync Model

One completed normal step or adopted manual step must create exactly one git commit.

The base workflow requires git sync. If git is unavailable, normal steps and `adopt-step` must not start.

A successful normal `apply` creates a git commit only when:

- the current git revision matches the step base revision;
- commit-worthy changes exist, including project changes or versioned Codex metadata;
- all required checks pass;
- the changes are allowed by commit rules;
- the commit is not empty.

Because a successful normal `apply` writes completed-step metadata, a successful normal step must create a git commit. If no commit-worthy changes exist after excluding transient runtime state, the step state is inconsistent; Codex must stop and require `resync` or manual resolution.

A successful `adopt-step` creates a git commit only when:

- no normal step is active;
- the current git revision and branch match `.codex/state.md`;
- commit-worthy manual working-tree changes exist after excluding transient runtime state;
- all required checks pass;
- the changes are allowed by commit rules;
- the commit is not empty.

Because a successful `adopt-step` writes completed-step metadata, a successful adopted manual step must create a git commit. If no commit-worthy changes exist after excluding transient runtime state, Codex must stop and require manual cleanup, `resync`, or manual resolution.

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

`apply` and `adopt-step` must run the required project checks before completed-step metadata is written and before git commit creation.

Required project checks are discovered from:

- explicit user instructions for the active step or adopted manual step;
- project-specific overrides;
- package/build configuration;
- scripts or commands conventionally named `test`, `lint`, `typecheck`, `check`, or equivalent for the detected stack;
- language or framework configuration files that define verification commands.

When an internal finalization helper is available, including `finalize-step` or `finalize-adopt-step`, it must discover and run configured checks from supported project configuration before writing completed-step metadata. Codex may provide additional explicit check commands to the helper for stacks or project conventions that cannot be discovered mechanically.

Required checks must run with a finite timeout so a hung test, linter, typechecker, or custom verification command cannot block `apply` or `adopt-step` forever.

The default required-check timeout is 10 minutes per command. Implementations may allow project runtime configuration or environment variables to extend or reduce this timeout, but they must not run required checks without any timeout.

If a required check times out, Codex must treat it as a check failure:

- no git commit is created;
- no completed-step metadata is created;
- history is not updated;
- the active normal step or manual adoption diff remains available for correction or retry.

If no configured checks are found, this is not a check failure. Codex must report:

```text
No configured checks found.
```

and may continue finalization.

If configured checks exist but cannot be run because tools, dependencies, or configuration are missing, Codex must treat that as a check failure unless the user explicitly accepts skipping them.

If checks fail during `apply`:

- no git commit is created;
- no completed-step metadata is created;
- history is not updated;
- `.codex/current-step.md` remains active;
- the step remains active;
- Codex reports the failure;
- the user continues within the same step.

If checks fail during `adopt-step`:

- no git commit is created;
- no completed-step metadata is created;
- history is not updated;
- `.codex/current-step.md` is not changed into an active or completed step;
- the manual working-tree diff remains for the user to fix or retry.

A completed step implies required verification succeeded. Reports do not need a separate verification section.

## No Empty Commits

If there are no commit-worthy changes, Codex must not create an empty commit.

For a normal step or adopted manual step, absence of commit-worthy changes after successful metadata preparation is inconsistent because completed-step metadata should be commit-worthy. Codex must stop and require `resync` or manual resolution.

## Sync Baseline

`.codex/state.md` stores runtime sync state such as the selected backend and last known revision.

Default state format:

```text
Sync Backend: git
Last Known Revision: <git revision or none>
Last Known Branch: <git branch or none>
Last Sync Source: <apply:<step-id> | adopt-step:<step-id> | resync | external | none>
Strict Mode: <true | false>
Discussion Mode: <none | active>
```

State lifecycle:

- missing `.codex/state.md`, `Last Known Revision: none`, or `Last Known Branch: none` means the sync baseline is uninitialized;
- missing `Strict Mode` means `true` until initialized or changed by the `strict:true` or `strict:false` command;
- missing `Discussion Mode` means `none` until initialized or changed by the `discuss` or `discuss:close` command;
- Codex must not start a normal step or `adopt-step` while sync state is uninitialized;
- Codex must not start a normal step or `adopt-step` while `Discussion Mode: active`;
- `resync` may initialize the baseline only after confirming the git project state is clean and unambiguous, with no staged changes, no unstaged tracked-file changes, and no untracked files that are not ignored by git;
- `strict:true`, `strict:false`, `discuss`, or `discuss:close` may create a missing `.codex/state.md` only as an uninitialized default state skeleton;
- a new active step must record the current git revision and branch as its base revision and branch;
- before `apply`, Codex must compare the active step base revision with the current git revision;
- if the current revision or branch changed outside the Codex flow, Codex must stop and require `resync`;
- after the Codex-created commit, Codex updates `.codex/state.md` with the new git revision.
- after a successful `adopt-step`, Codex updates `.codex/state.md` with `Last Sync Source: adopt-step:<step-id>` and the adopted step commit revision.
When `Discussion Mode: active`, non-command prompts are read-only discussion prompts and must not create active steps or project changes.

Because git commits cannot contain their own final hash, `.codex/state.md` is runtime sync state, not completed step memory.

## Versioned Codex Memory

Completed Codex workflow memory is versioned with the project.

By default, Codex must include changed project files and changed completed Codex metadata produced by the successful step in the required commit:

```text
AGENTS.md
.gitignore
.codex/core/bootstrap.md
.codex/core/config.toml
.codex/core/commands.md
.codex/core/commit-rules.md
.codex/core/after-step.md
.codex/core/step-report-rules.md
.codex/core/overrides.md
.codex/config.toml
.codex/context.md
.codex/current-step.md
.codex/history.md
.codex/next-step.md
.codex/last-report.md
.codex/reports/<numeric-id>.md
.codex/overrides/*.md
```

The optional `.codex/overrides/` directory does not need to exist until project-specific overrides are needed.

`.codex/current-step.md` must be included when it changed and is in its inactive final state. It must be excluded while it contains an active step.

## Transient Runtime Files

Codex must not commit transient runtime state:

```text
.codex/state.md
.codex/tmp/**
```

`.codex/current-step.md` must not be committed while it contains an active step.

After a successful `apply` or `adopt-step`, `.codex/current-step.md` must be committed when it changed and is in its inactive final state:

```text
No active step.

Last completed step: <id>
```

A project may extend commit policy through `.codex/overrides/commit-rules.md` if `.codex/overrides/` exists, but only within the limits defined by `.codex/core/overrides.md`. Overrides must not disable or weaken the required git backend, required commit creation, no-empty-completion stop behavior, or required versioned metadata commit scope.

## Commit Scope

By default, Codex commits all git-visible project changes and versioned Codex metadata produced by the current successful step, except files excluded by commit rules. Git-visible project changes include tracked-file changes and untracked files that are not ignored by git.

Codex must not guess which files are generated, temporary, or undesirable if the repository itself tracks them. Additional exclusions belong in project overrides.

Codex must not blindly use `git add .` if that would include active-step content or excluded transient files.

## Pre-existing Project Changes

If staged changes, unstaged tracked-file changes, or untracked files that are not ignored by git exist before starting a new normal step, that is an abnormal state.

Codex must not start a new normal step and mix those changes into it.

Codex must stop and require manual cleanup or `resync` after the tree is clean.

Codex must not create a special active step for pre-existing project changes.

The exact `adopt-step "title"` command is the only exception: it may intentionally adopt pre-existing manual working-tree changes as one completed Codex step when all `adopt-step` gates pass.

Ignored transient runtime files do not by themselves count as pre-existing project changes, but inconsistent or ambiguous workflow state still requires `resync` or manual resolution.

## External Git Changes

If the git revision changes outside the Codex `apply` or `adopt-step` flow, Codex must require `resync`.

External commits are not normal Codex steps.

## Rollback and Reset

If reset, checkout, rebase, revert, pull, merge, or branch switch changes history unexpectedly, Codex must require `resync`.

Codex must not perform destructive git operations.

## Apply Finalization Order

Normal `apply` must follow this order:

1. verify the git sync baseline;
2. apply project changes;
3. verify that at least one commit-worthy payload change exists before completed-step metadata is written;
4. run the Stability Safety Gate against any stability-sensitive payload diff;
5. run required checks against the current working tree;
6. capture a pre-finalization recovery snapshot;
7. prepare and write completed-step metadata;
8. create one git commit;
9. update runtime sync state in `.codex/state.md`;
10. complete the step.

Versioned metadata must not require embedding the new commit's own hash, because a commit cannot contain its own final hash. Runtime sync state may record the final hash after the commit.

If required git commit creation fails after completed-step metadata was written, Codex must run Required Commit Failure Recovery from `.codex/core/after-step.md`. If recovery succeeds, the same active step continues. Otherwise Codex must stop and require `resync` or manual resolution.

If metadata verification fails after git commit creation, Codex state is inconsistent and `resync` is required before continuing.

`adopt-step` finalization must follow this order:

1. verify that no active step exists;
2. verify the git sync baseline and current branch still match `.codex/state.md`;
3. inspect the manual working-tree diff and exclude transient runtime state from commit-worthy payload;
4. reject pre-existing manual changes in versioned Codex memory/config files that are owned by adopted-step finalization;
5. run the Stability Safety Gate against the manual diff;
6. run required checks against the current working tree;
7. capture a pre-finalization recovery snapshot;
8. prepare and write completed-step metadata for an adopted manual step;
9. create one git commit;
10. update runtime sync state in `.codex/state.md`;
11. complete the adopted step.

When `codex-flow internal state finalize-adopt-step --title <title>` is available, Codex must use it for adopted-step metadata, commit creation, runtime sync update, and commit-failure recovery instead of manually editing those files.

If required git commit creation fails after adopted-step metadata was written, Codex must run Required Commit Failure Recovery from `.codex/core/after-step.md`. If exact recovery succeeds, the manual working-tree diff remains the only valid payload for a later `adopt-step` retry. Otherwise Codex must stop and require `resync` or manual resolution.
