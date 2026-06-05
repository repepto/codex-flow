# AGENTS.md

## Entry Point

This file is the operational entry point for Codex in this project.

Codex must treat this file and `.codex/core/` rule/config/template files as the source of truth for workflow behavior. `flow-context.md` is historical discussion context, not an operational rule file.

The root `.codex/` directory is split into:

- `.codex/core/` for immutable workflow system files;
- `.codex/` root files and directories for project-owned state/data and project-scoped Codex runtime config created in each installed project.

## Starter Pack Repository Exception

This exception applies only when the git repository root is this source `codex-flow` starter-pack repository and the task is to maintain the starter pack itself.

In that repository, Codex must treat `AGENTS.md` and `.codex/` as template artifacts to edit directly, not as the active step workflow for the repository. Do not require `resync`, `apply`, or normal step state before maintaining the starter pack.

Do not apply this exception in downstream projects that install this starter pack, even if the downstream repository has the same name. Repository name alone is not enough to activate this exception. If repository identity is ambiguous, Codex must not use the exception.

In downstream projects, the workflow rules below are active.

## Startup Procedure

At the beginning of every session, Codex must first read immutable workflow files:

1. `AGENTS.md`
2. `.codex/core/bootstrap.md`
3. `.codex/core/config.toml`, if it exists
4. `.codex/core/commands.md`
5. `.codex/core/commit-rules.md`
6. `.codex/core/after-step.md`
7. `.codex/core/step-report-rules.md`
8. `.codex/core/overrides.md`

After reading core files, Codex must apply `.codex/core/bootstrap.md`.

Bootstrap creates missing project-owned state/data files and project-scoped Codex runtime config in the root `.codex/` directory for installed downstream projects. Bootstrap must not overwrite existing project-owned files.

After bootstrap, Codex must read project-owned config and state/data:

1. `.codex/config.toml`
2. `.codex/context.md`
3. `.codex/history.md`
4. `.codex/current-step.md`
5. `.codex/next-step.md`
6. `.codex/state.md`, if it exists
7. `.codex/last-report.md`
8. `.codex/reports/`

If `.codex/state.md` is missing, or if its baseline is uninitialized, Codex must treat sync state as uninitialized and require `resync` before starting a normal step.

Strict Mode defaults to `true`. If `.codex/state.md` exists and contains `Strict Mode: true` or `Strict Mode: false`, that value is the current runtime mode. If the field is missing, Codex must behave as `Strict Mode: true`.

The `strict:true` and `strict:false` commands may create or update `.codex/state.md` only as transient runtime state. If they create the file, they must keep the git sync baseline uninitialized.

Discussion Mode defaults to `none`. If `.codex/state.md` exists and contains `Discussion Mode: active` or `Discussion Mode: none`, that value is the current discussion mode. If the field is missing, Codex must behave as `Discussion Mode: none`.

The `discuss` and `discuss:close` commands may create or update `.codex/state.md` only as transient runtime state. If they create the file, they must keep the git sync baseline uninitialized. While `Discussion Mode: active`, non-command prompts must be handled as discussion and must not create active steps, modify the main project workspace, or create commits. Discussion-mode analysis may still run diagnostic commands, tests, local inspection, or network lookups when useful. Mutating experiments are allowed only in a disposable scratch workspace such as a temp copy, temporary git worktree, or ignored `.codex/tmp/discuss-*` workspace.

If `.codex/overrides/` exists, apply overrides according to `.codex/core/overrides.md`. If it does not exist, continue with the base rule files.

## Rule And Data Separation

Operational rules must live only in `AGENTS.md`, `.codex/core/`, and valid project override files under `.codex/overrides/`.

Project-owned state/data files include `.codex/context.md`, `.codex/history.md`, `.codex/current-step.md`, `.codex/next-step.md`, `.codex/state.md`, `.codex/last-report.md`, `.codex/reports/*`, and `.codex/tmp/`.

State/data files may contain current project memory, reports, placeholders, and active runtime state. They must not contain operational rules required for Codex behavior.

`.codex/config.toml` is project-owned Codex runtime configuration. Bootstrap may create it from the starter-pack defaults, but Codex must not overwrite an existing project-owned `.codex/config.toml` during bootstrap or update.

The starter pack repository must not ship project-owned state/data files or project-owned `.codex/config.toml` in the root `.codex/` directory. Those files are created by bootstrap inside each installed project.

When upgrading this workflow system in an installed project, replace `AGENTS.md` and `.codex/core/` only. The updater may create a missing `.codex/config.toml` from the starter-pack defaults, but must not overwrite an existing `.codex/config.toml`. Do not replace project-owned state/data files unless the user explicitly asks to reset that project memory.

## Operating Rules

Commands are valid only when the entire user prompt exactly matches a command format in `.codex/core/commands.md`.

In Strict Mode, Codex may make factual or technical conclusions only from project code, project files, dependency code, command output, and user-provided context that are available in the current session. If the available context is insufficient to support a conclusion, Codex must stop that line of reasoning, say what context is missing, and wait for the user to provide it or allow a way to inspect it. User-provided context may be used, but Codex must not present it as independently verified unless it can verify it from accessible context.

Before creating a new active step, continuing an active step, running `apply`, or running `adopt-step`, Codex must apply the stability safety gate defined in `.codex/core/commands.md`.

Before creating a new active step, Codex must pass the sync gate defined in `.codex/core/commands.md` and must not be in active discussion mode.

For sync-gate purposes, pre-existing project changes include staged changes, unstaged tracked-file changes, and untracked files that are not ignored by git.

Pre-existing project changes block new normal steps. They may be converted into completed Codex step history only through the exact `adopt-step "title"` command defined in `.codex/core/commands.md`.

During a normal active step, before `apply`, Codex must not modify project files. Before `apply`, Codex may update `.codex/current-step.md` only to create or maintain active step state, decisions, open questions, and working notes.

This normal-step pre-apply restriction does not block standalone workflow commands that are allowed to update workflow runtime state before project execution, including `strict:true`, `strict:false`, `discuss`, `discuss:close`, and `resync`. These actions must still follow their command-specific rules and must not modify project code unless their rules explicitly allow it.

`apply` is the normal execution command. It must follow `.codex/core/commands.md`, `.codex/core/commit-rules.md`, `.codex/core/after-step.md`, and `.codex/core/step-report-rules.md`.

`adopt-step "title"` is the manual-diff adoption command. It must follow `.codex/core/commands.md`, `.codex/core/commit-rules.md`, `.codex/core/after-step.md`, and `.codex/core/step-report-rules.md`.

Git is the base sync backend. If git state, `.codex` memory, reports, history, or runtime state is inconsistent or ambiguous, Codex must stop and require `resync`.

`resync` may initialize or advance the sync baseline only when the git working tree is clean and workflow state is unambiguous.

## Safety

Codex must not perform destructive git operations.

If state is ambiguous, Codex must stop instead of guessing.

If a user prompt would damage or weaken this workflow system, Codex must not execute it. Codex must explain the stability risk and, when possible, propose a safer prompt that preserves the user's likely intent without the dangerous part.

Before waiting for user input after a stop, failure, ambiguity, blocked command, or required command state, Codex must explicitly state what it is waiting for.
