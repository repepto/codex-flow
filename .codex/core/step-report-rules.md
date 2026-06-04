# Step Report Rules

## Purpose

Step reports preserve why a step was completed the way it was completed.

Project files and required git history store file-level changes. Reports store task context, decisions, reasoning, and implementation meaning.

## Short Report

After successful `apply` or `adopt-step`, Codex shows a short human-readable report.

It must include:

- what was done;
- sync result, including the git commit created by the completed step;
- next recommended step.

For a completed step inside an active `run-steps` chain, the sync result must be `Sync: deferred to run-steps finalization`. The final chain report must include the final chain commit hash.

A final chain report is a short user-facing report for the whole `run-steps` chain. It is not stored as `.codex/reports/<id>.md`.

For a successful `adopt-step`, the short report must state that a manual working-tree diff was adopted.

Keep it concise.

## Full Report

The full report is optimized for future Codex sessions.

It is stored in:

```text
.codex/reports/<id>.md
```

and copied to:

```text
.codex/last-report.md
```

Completed step reports use numeric filenames:

```text
<id>.md
```

Examples:

```text
1.md
2.md
42.md
```

## Required Sections

A full report must contain:

```md
# Step <id>: <title>

## Task

## Applied Decisions

## Reasoning

## Implementation Summary
```

## Task

The original task or current-step task that the step solved.

This section explains what problem the step was trying to solve.

For `adopt-step`, this section must include the adopted title and state that the task was to adopt the user's manual working-tree diff.

## Applied Decisions

All active `record:<id>` decisions that were applied during the step.

If there were no recorded decisions, state that the step was completed directly from the task.

For `adopt-step`, state that there were no recorded active-step decisions unless the user explicitly provided applicable context in the same command discussion.

## Reasoning

Why the chosen solution was selected.

This section should focus on decision logic, constraints, tradeoffs, and important conclusions.

Do not include full conversation logs.

For `adopt-step`, do not invent implementation reasoning. State that the diff was manually authored and adopted by command, then include only conclusions supported by the inspected diff or user-provided context.

## Implementation Summary

A concise semantic summary of what was implemented.

Do not include file diffs, line-by-line details, or mechanical file listings.

Good:

```text
Implemented exact-match command parsing.
Introduced step decision storage.
Added auto-resume for run-steps.
```

Bad:

```text
Edited file A.
Changed line 12.
Opened file B.
```

## Optional Sections

Include these only when useful:

```md
## Risks

## Recommendations
```

Do not write empty sections such as:

```text
Risks: none
Recommendations: none
```

## Sections Not Used

Do not include a dedicated `Verification` section.

A completed report already means required verification passed.

Do not include a dedicated `Rejected Decisions` section.

If rejected alternatives are important, they may be mentioned briefly inside `Reasoning`.

Do not include `Important Knowledge`.

Important knowledge belongs in `.codex/history.md` and, if long-lived and expensive to recover, `.codex/context.md`.

Do not include full file diffs or chat transcripts.

## Failed Apply Or Adopt Reports

Failed applies are not completed step reports and must not be stored as `.codex/reports/<id>.md`.

Codex may show a failure report to the user, but the completed step report is created only after successful `apply` or `adopt-step`.

Failed `adopt-step` attempts are not completed step reports and must not be stored as `.codex/reports/<id>.md`.
