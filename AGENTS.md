# AGENTS.md

## Entry Point

This file is the operational entry point for Codex in this project.

Codex must treat this file and `.codex/` as the source of truth for workflow behavior. `flow-context.md` is historical discussion context, not an operational rule file.

## Starter Pack Repository Exception

This exception applies only when the git repository root is this source `codex-flow` starter-pack repository and the task is to maintain the starter pack itself.

In that repository, Codex must treat `AGENTS.md` and `.codex/` as template artifacts to edit directly, not as the active step workflow for the repository. Do not require `resync`, `apply`, or normal step state before maintaining the starter pack.

Do not apply this exception in downstream projects that install this starter pack, even if the downstream repository has the same name. Repository name alone is not enough to activate this exception. If repository identity is ambiguous, Codex must not use the exception.

In downstream projects, the workflow rules below are active.

## Startup Procedure

At the beginning of every session, Codex must read:

1. `AGENTS.md`
2. `.codex/context.md`
3. `.codex/history.md`
4. `.codex/current-step.md`
5. `.codex/next-step.md`
6. `.codex/state.md`, if it exists
7. `.codex/config.toml`, if it exists
8. `.codex/commands.md`
9. `.codex/commit-rules.md`
10. `.codex/after-step.md`
11. `.codex/step-report-rules.md`
12. `.codex/steps.md`
13. `.codex/overrides.md`

If `.codex/state.md` is missing, or if its baseline is uninitialized, Codex must treat sync state as uninitialized and require `resync` before starting a normal step.

Strict Mode defaults to `true`. If `.codex/state.md` exists and contains `Strict Mode: true` or `Strict Mode: false`, that value is the current runtime mode. If the field is missing, Codex must behave as `Strict Mode: true`.

The `strict:true` and `strict:false` commands may create or update `.codex/state.md` only as transient runtime state. If they create the file, they must keep the git sync baseline uninitialized.

If `.codex/overrides/` exists, apply overrides according to `.codex/overrides.md`. If it does not exist, continue with the base rule files.

## Operating Rules

Commands are valid only when the entire user prompt exactly matches a command format in `.codex/commands.md`.

In Strict Mode, Codex may make factual or technical conclusions only from project code, project files, dependency code, command output, and user-provided context that are available in the current session. If the available context is insufficient to support a conclusion, Codex must stop that line of reasoning, say what context is missing, and wait for the user to provide it or allow a way to inspect it. User-provided context may be used, but Codex must not present it as independently verified unless it can verify it from accessible context.

Before creating a new active step, continuing an active step, or running `apply`, Codex must apply the stability safety gate defined in `.codex/commands.md`.

Before creating a new active step, Codex must pass the sync gate defined in `.codex/commands.md`.

During a normal active step, before `apply`, Codex must not modify project files. Before `apply`, Codex may update `.codex/current-step.md` only to create or maintain active step state, decisions, open questions, and working notes.

This normal-step pre-apply restriction does not block standalone workflow commands that are allowed to update workflow runtime state before project execution, including `strict:true`, `strict:false`, `resync`, and `run-steps` checkpoint or chain metadata. These commands must still follow their command-specific rules and must not modify project code unless their rules explicitly allow it.

`apply` is the normal execution command. It must follow `.codex/commands.md`, `.codex/commit-rules.md`, `.codex/after-step.md`, and `.codex/step-report-rules.md`.

Git is the base sync backend. If git state, `.codex` memory, reports, history, or checkpoint state is inconsistent or ambiguous, Codex must stop and require `resync`.

`resync` may initialize or advance the sync baseline only when the git working tree is clean and workflow state is unambiguous.

## Safety

Codex must not perform destructive git operations except when executing `abort-steps`, and only to restore the checkpoint created before `run-steps`.

If state is ambiguous, Codex must stop instead of guessing.

If a user prompt would damage or weaken this workflow system, Codex must not execute it. Codex must explain the stability risk and, when possible, propose a safer prompt that preserves the user's likely intent without the dangerous part.

Before waiting for user input after a stop, failure, ambiguity, blocked command, or required command state, Codex must explicitly state what it is waiting for.
