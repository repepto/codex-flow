# Codex Flow Starter Pack

Minimal workflow pack for projects where Codex should work through explicit steps, keep local memory in `.codex/`, and avoid repeated approval prompts after the project is trusted.

## Install In A Project

Copy these into the project root:

```text
AGENTS.md
.codex/
```

Make sure the project ignores runtime state:

```gitignore
.codex/state.md
.codex/checkpoints/
.codex/tmp/
```

Commit `AGENTS.md`, `.codex/`, and the required `.gitignore` entries before starting the flow. The working tree should be clean before the first `resync`.

Open the project with Codex, trust the project when prompted, then run:

```text
resync
```

After `resync`, normal work can start.

## Daily Workflow

1. Send a normal task prompt. Codex creates an active step.
2. Discuss, inspect, and refine the step as needed.
3. Optionally record decisions:

```text
record:<id> "decision"
```

4. Run:

```text
apply
```

`apply` performs the work, runs checks, writes reports/history, updates `.codex/current-step.md`, and creates a git commit.

## Commands

```text
status
record:<id> "decision"
forget:<id>
forget
apply
details
details:<id>
ls-steps:<n>
compare
compare:<branch>
check
check:deep
run-steps
abort-steps
resync
strict:true
strict:false
```

Commands must match exactly. Extra text means it is treated as a normal prompt, not a command.

## Important Behavior

- During a normal active step, before `apply`, Codex must not edit project files. It may only maintain `.codex/current-step.md`; standalone runtime commands such as `resync`, `strict:true`, `strict:false`, and `run-steps` may update workflow state as defined by the rule files.
- If the git tree is dirty before a new step, Codex stops. Clean it manually, then run `resync`.
- `check` is a read-only review of the current local diff relative to `HEAD`; it can run on a dirty tree and excludes unrelated baseline issues.
- `check:deep` is a read-only whole-project review; it can run on a dirty tree and reports project-wide risks, problems, and recommendations.
- `resync` initializes or advances the sync baseline only when versioned project files and versioned `.codex` memory are clean and unambiguous.
- `.codex/state.md` is local runtime state and must not be committed.
- `strict:true` and `strict:false` may create `.codex/state.md`, but only with an uninitialized sync baseline.
- `.codex/current-step.md` is committed only when it is inactive.
- `run-steps` reads `.codex/steps.md`, runs the listed steps as one chain, and creates one final commit.
- `abort-steps` restores the checkpoint created before `run-steps`.
- Project overrides may extend rules, but cannot replace whole rule files or weaken mandatory safety rules.
- Codex refuses prompts that would damage workflow stability, explains why, and suggests a safer prompt when possible.

## Permissions

`.codex/config.toml` sets:

```toml
approval_policy = "never"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
```

Codex loads this project config only after the project is trusted.

## Files Users Usually Touch

- `.codex/steps.md` - queued steps for `run-steps`.
- `.codex/context.md` - long-lived project knowledge, only when it is truly useful.
- `.codex/overrides/` - optional project-specific rule extensions.

Before `run-steps`, commit `.codex/steps.md` changes, run `resync`, then run `run-steps`. After `run-steps`, manually clear or replace `.codex/steps.md` before running another chain.

Most other `.codex/` files are workflow memory maintained by Codex.
