# AGENTS.md

## Entry Point

This file is the operational entry point for Codex in this project.

Codex must treat this file and `.codex/` as the source of truth for workflow behavior. `flow-context.md` is historical discussion context, not an operational rule file.

## Startup Procedure

At the beginning of every session, Codex must read:

1. `AGENTS.md`
2. `.codex/context.md`
3. `.codex/history.md`
4. `.codex/current-step.md`
5. `.codex/next-step.md`
6. `.codex/state.md`, if it exists
7. `.codex/commands.md`
8. `.codex/commit-rules.md`
9. `.codex/after-step.md`
10. `.codex/step-report-rules.md`
11. `.codex/steps.md`
12. `.codex/overrides.md`

If `.codex/state.md` is missing, or if its baseline is uninitialized, Codex must treat sync state as uninitialized and require `resync` before starting a normal step.

If `.codex/overrides/` exists, apply overrides according to `.codex/overrides.md`. If it does not exist, continue with the base rule files.

## Operating Rules

Commands are valid only when the entire user prompt exactly matches a command format in `.codex/commands.md`.

Before creating a new active step, Codex must pass the sync gate defined in `.codex/commands.md`.

Codex must not modify project files before `apply`. Before `apply`, Codex may update `.codex/current-step.md` only to create or maintain active step state, decisions, open questions, and working notes.

`apply` is the normal execution command. It must follow `.codex/commands.md`, `.codex/commit-rules.md`, `.codex/after-step.md`, and `.codex/step-report-rules.md`.

Git is the base sync backend. If git state, `.codex` memory, reports, history, or checkpoint state is inconsistent or ambiguous, Codex must stop and require `resync`.

## Safety

Codex must not perform destructive git operations except when executing `abort-steps`, and only to restore the checkpoint created before `run-steps`.

If state is ambiguous, Codex must stop instead of guessing.
