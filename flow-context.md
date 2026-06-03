# Flow Context

This file summarizes the accepted Codex workflow design so the discussion can continue in another chat.

## Core Architecture

The project uses a root `AGENTS.md` and a `.codex/` folder next to it.

Final structure:

```text
AGENTS.md

.codex/
  commands.md
  commit-rules.md
  after-step.md
  step-report-rules.md
  overrides.md

  context.md
  history.md
  current-step.md
  next-step.md
  state.md

  steps.md
  run-step-examples.md

  last-report.md
  reports/
    README.md

  overrides/  # optional; present only when project-specific overrides exist
```

## Global Principles

### Think, do not blindly execute

User points are guidance, not mindless orders. Codex should reason, detect problems, suggest better options, and discuss when something looks wrong.

### Exact command rule

A command is valid only when the whole user prompt exactly matches a command format in `commands.md`.

If there are extra words, symbols, wrong syntax, or unsupported arguments, it is not a command.

### Step model

A step is the period between the previous successful `apply` and the next successful `apply`.

A step can include discussion, analysis, records, changes of mind, and final execution.

While a step is active, every non-command prompt belongs to that step. A new step cannot start until the current one completes.

### No project file changes without apply

During a step, Codex may inspect, analyze, discuss, propose, and maintain limited workflow state.

Codex must not modify project files until the exact `apply` command is given.

Before `apply`, Codex may update `.codex/current-step.md` only to create or maintain the active step, including task text, recorded decisions, open questions, and working notes.

Other `.codex` files are updated only by `apply`, `resync`, or step-chain control commands.

### Single source of truth

Minimize duplication.

Do not store derived state if it can be reliably computed without adding complexity.

Duplication is allowed only when it substantially simplifies the system or reduces risk.

### User chaos is not covered

The system should be robust against reasonable errors and Codex/git mismatch. It does not need to protect against a user manually corrupting `.codex` files or changing the plan during execution.

If the user does chaotic manual edits, they can resolve it manually, use git reset, or run `resync`.

## Accepted Commands

Final command set:

```text
record:<id> "description"

forget:<id>
forget

apply

status

details
details:<id>

ls-steps:<n>

run-steps
abort-steps

resync
```

Removed commands:

```text
commit
commit "message"
apply-only
run-steps:auto
```

Manual commits are done by the user directly with git.

## record / forget

`record:<id> "description"` saves or updates a decision inside `current-step.md`.

`<id>`:

- lowercase letters, numbers, hyphens;
- no leading/trailing hyphen;
- no `--`.

Repeated `record` with the same id is upsert.

`forget:<id>` removes one decision.

`forget` removes all recorded decisions from the current step.

Forget does not cancel the step.

## apply

`apply` is the only normal execution command.

It:

1. applies agreed work;
2. runs required checks;
3. stops if checks fail;
4. runs after-step;
5. creates commit if allowed and needed;
6. writes reports/history/next-step/state;
7. completes the step.

If checks fail, the same step remains active. The only normal path forward is fixing the step and running `apply` again.

## Commit Policy

No standalone commit command.

`apply` creates at most one commit.

Default commit message format is Conventional Commits:

```text
feat: ...
fix: ...
refactor: ...
docs: ...
test: ...
chore: ...
build: ...
ci: ...
style: ...
perf: ...
```

Codex workflow memory is versioned with the project.

By default, successful `apply` commits include project changes and completed Codex metadata when those files changed:

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
.codex/state.md
.codex/last-report.md
.codex/reports/*.md
.codex/run-step-examples.md
.codex/overrides/*.md
```

Transient runtime state is not committed:

```text
.codex/checkpoints/**
.codex/tmp/**
```

`.codex/current-step.md` must not be committed while it contains an active step. After a successful `apply`, it may be committed only in its inactive final state.

A project can override commit rules in `.codex/overrides/commit-rules.md` if `.codex/overrides/` exists.

No empty commits.

If no repository changes exist, the step can still complete and report:

```text
Step completed without repository changes.
```

## Pre-existing Changes

If staged or unstaged changes exist before a new step, that is abnormal.

Codex must not start a new normal step and mix them into it.

Instead, create/keep a special step:

```text
Resolve pre-existing changes
```

## Resync

`resync` is required when git history or `.codex` memory is inconsistent.

Examples:

- external commits;
- reset;
- rebase;
- checkout;
- branch switch;
- pull/merge/revert changing history unexpectedly;
- reports/history/state mismatch.

`resync`:

- does not create commits;
- does not apply project code changes;
- does not delete reports automatically;
- marks/explains outdated or detached memory instead of silently removing it;
- suspends active steps if their base state is invalid.

## run-steps

`steps.md` is a user-maintained executable plan.

Codex must not mutate `steps.md` during `run-steps`.

`steps.md` contains only real pending steps or `No pending steps.`

Examples live in `.codex/run-step-examples.md`.

`run-steps` reads only `.codex/steps.md` and must never execute `.codex/run-step-examples.md`.

`run-steps` is automatic. `run-steps:auto` was removed.

Before running, Codex creates an internal checkpoint.

The chain is atomic:

```text
either all steps complete
or abort-steps restores the checkpoint
```

If an apply fails inside the chain, the chain pauses inside that step. After the user fixes the step and `apply` succeeds, the chain continues automatically.

## abort-steps

`abort-steps` cancels an active `run-steps` chain and restores the checkpoint from before the chain.

It may use destructive git rollback only for that checkpoint restoration.

If complete rollback is impossible, Codex must stop and require manual resolution or `resync`.

Better to stop than to perform a partial incorrect rollback.

## after-step

Mandatory system after-step actions cannot be disabled by overrides.

After-step has:

- pre-commit phase;
- commit phase;
- post-commit phase.

It performs integrity checks before finalization.

If integrity fails before commit, no commit is created and the step remains active.

Completed-step metadata is prepared before commit so it can be included in the step commit.

If metadata verification fails after commit, state is inconsistent and `resync` is required.

After a successful step, `current-step.md` remains but says:

```text
No active step.

Last completed step: <id>
```

## Reports

Short report: shown to the user after successful `apply`.

Full report: saved in:

```text
.codex/reports/<id>.md
```

and copied to:

```text
.codex/last-report.md
```

Full reports focus on why, not git diff.

Required sections:

```text
Step ID / title
Task
Applied Decisions
Reasoning
Implementation Summary
```

Optional:

```text
Risks
Recommendations
```

No mandatory Verification section, because completed report already implies checks passed.

No Important Knowledge section in reports; that belongs in `history.md` and maybe `context.md`.

## history.md

`history.md` is Codex working memory for completed steps, not a human-friendly changelog.

Each step contains:

- Step ID;
- Step Title;
- Commit;
- Summary;
- Important Knowledge;
- Report reference.

It should store useful conclusions and knowledge for future Codex sessions, not mechanical logs.

## context.md

`context.md` stores long-lived, important project knowledge that is expensive to recover.

It is not general project docs.

It uses sections:

- Architecture Knowledge;
- Project Constraints;
- Important Decisions;
- Known Pitfalls.

Before adding new knowledge, update existing relevant entries if possible.

If an entry grows too large, compact it first. Split only into logical complete blocks if needed.

## next-step.md

Contains:

- Recommended Step;
- Reasoning;
- Implementation Suggestions;
- Risks;
- Alternatives.

It is a recommendation, not an automatic next task.

A new step is not created automatically from `next-step.md`.

## state.md

Minimal state.

Current accepted content:

```text
Last Known HEAD
```

Do not store active step id or last completed step id here; they are derived from `current-step.md` and `history.md`.

## Overrides

Overrides live in:

```text
.codex/overrides/
```

The directory is optional. If it does not exist, Codex uses only the base rule/config files.

For rule/config files only.

If the first non-empty line is:

```text
#replace
```

the override replaces the base file.

Otherwise it extends the base file and wins conflicts.

State/data files such as context/history/current-step/next-step/state/steps/reports are not override targets.

## Final Audit Results

After simplification:

Removed:

- `apply-only`;
- `run-steps:auto`;
- `commit`;
- `commit "message"`;
- `Step Chain Mode` from `state.md`.

No major contradictions remain.

Main safety points:

- `run-steps` requires checkpoint;
- `abort-steps` is the only destructive rollback mechanism;
- `resync` handles git/Codex memory mismatch;
- active step blocks new steps;
- failed apply keeps the same step active.
