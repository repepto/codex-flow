# Commands

## Exact Match Rule

A command is valid only when the entire user prompt exactly matches one of the command formats in this file.

If the prompt contains extra words, unsupported arguments, wrong quotes, wrong spacing, or invalid characters, it is not a command.

Codex must not infer, correct, or reinterpret commands.

If a syntactically valid command cannot be executed in the current state, Codex must return a clear informational response and do nothing unsafe.

Before waiting for user input after a stop, failure, ambiguity, blocked command, or required command state, Codex must explicitly state what it is waiting for.

## Internal CLI Guardrails

The `codex-flow` terminal CLI may provide internal machine-check helpers such as:

```text
codex-flow internal parse-command --prompt <prompt>
codex-flow internal validate-state
codex-flow internal next-step-id
codex-flow internal commit-plan
codex-flow internal preflight apply
codex-flow internal state resync
codex-flow internal state start-step --prompt <prompt>
codex-flow internal state start-recommended-step
codex-flow internal state record --id <id> --description <description>
codex-flow internal state discard-step
codex-flow internal state finalize-step --title <title> --next-step <recommendation>
codex-flow internal state finalize-adopt-step --title <title> --next-step <recommendation>
codex-flow internal gate start-step
codex-flow internal gate apply
codex-flow internal gate adopt-step --title <title>
codex-flow internal gate resync
codex-flow internal gate stability
```

These internal helpers are not Codex chat workflow commands. A user prompt that says `codex-flow internal ...` or `internal ...` is not a workflow command unless it is an ordinary user request to run a terminal command.

When the matching `codex-flow internal` helper is available in the environment, Codex must prefer it for binary workflow invariants before making state-changing decisions, including command parsing, sync gates, apply preflight, adopt-step preflight and finalization, stability-sensitive diff checks, resync clean-tree gates, next step id calculation, workflow state validation, normal-flow state transitions, and commit-scope planning.

If an internal helper is unavailable or cannot run, Codex must fall back to the rule files in `AGENTS.md` and `.codex/core/`, state that the machine helper was unavailable when that matters to the decision, and stop rather than guessing when the rule-file-only result is ambiguous.

## strict

Formats:

```text
strict:true
strict:false
```

Behavior:

- valid only as a standalone command received while Codex is waiting for user input;
- may be run whether or not an active step exists;
- may be run when sync state requires `resync`;
- may be run while discussion mode is active;
- does not require the sync gate;
- updates only the `Strict Mode` field in `.codex/state.md` when the file exists;
- preserves all other `.codex/state.md` fields;
- does not create a step;
- does not modify project code;
- does not run checks;
- does not create commits.

`strict:true` and `strict:false` are allowed runtime-mode switches. They are not unsafe merely because they update `.codex/state.md`, but they must preserve every other state field and must not be combined with any other requested action.

If `.codex/state.md` is missing, create the default state skeleton with the requested `Strict Mode` value, `Last Known Revision: none`, `Last Known Branch: none`, `Last Sync Source: none`, and `Discussion Mode: none`.

Creating this skeleton does not initialize sync. The sync baseline remains uninitialized until a later successful `resync`.

`strict:true` enables Strict Mode.

`strict:false` disables Strict Mode and returns Codex to its default reasoning behavior.

In Strict Mode, Codex may make factual or technical conclusions only from project code, project files, dependency code, command output, and user-provided context that are available in the current session. If the available context is insufficient to support a conclusion, Codex must stop that line of reasoning, say what context is missing, and wait for the user to provide it or allow a way to inspect it.

## ok

Format:

```text
ok
```

Behavior:

- valid only as a standalone command received while Codex is waiting for user input;
- starts a new active step from the recommended next step in `.codex/next-step.md`;
- is allowed only when the user could otherwise send a normal task prompt to create a new active step;
- requires no active step, discussion mode inactive, initialized matching sync state, and a clean git working tree;
- requires `.codex/next-step.md` to contain a substantive `## Recommended Step` value;
- treats `No recommendation yet.` as no substantive recommendation;
- follows the same sync gate, stability safety gate, and step-start reporting requirements as a normal task prompt;
- updates `.codex/current-step.md` with the active step state;
- does not modify project files;
- does not run checks;
- does not create commits.

If `.codex/next-step.md` has no substantive recommendation yet, `ok` must not create an active step. Codex must say that no recommendation has been recorded yet and recommend that the user explicitly provide the next task prompt or run `discuss` to decide one.

When the internal helper `codex-flow internal state start-recommended-step` is available, Codex must prefer it to parse `.codex/next-step.md`, apply the start-step gate, and create the active step.

## Stability Safety Gate

Before creating or updating workflow state, creating a new active step, continuing an active step, executing a state-changing command, running `apply`, or running `adopt-step`, Codex must check whether the requested work could damage or weaken the workflow system.

Codex must run this gate for:

- a non-command prompt that would create a new active step;
- any prompt that would continue an active step;
- `record` and any other command that creates or updates `.codex/current-step.md` or `.codex/state.md`;
- `adopt-step` before adopting manual working-tree changes;
- `apply`.

Stability-sensitive surfaces include:

- `AGENTS.md`;
- `.codex/core/` rule, config, and template files;
- `.codex/` project memory, report, override, and runtime files;
- `.gitignore` entries required for `.codex/state.md` and `.codex/tmp/`;
- git sync state, history, reports, step ids, and active step state;
- command definitions, sync gates, after-step rules, commit rules, report rules, override rules, and mandatory safety rules.

A prompt is unsafe when it asks Codex to delete, overwrite, bypass, disable, weaken, or silently corrupt a stability-sensitive surface, or when the requested change would likely remove required workflow protections.

Examples of unsafe prompts:

- delete `.codex/`;
- delete or rewrite `AGENTS.md` without preserving the workflow entry point;
- replace `.gitignore` with content that drops required `.codex` runtime ignores;
- remove sync gates, `resync`, after-step integrity checks, required commit failure recovery, transient-state exclusions, or destructive git restrictions;
- allow full-file override replacement or weaken mandatory system actions.

If a prompt is unsafe, Codex must not:

- create or update an active step;
- store or update decisions, open questions, working notes, or other workflow state;
- modify project files;
- run checks;
- create commits;
- partially execute the safe-looking parts of the prompt.

Instead, Codex must respond with:

- a brief explanation that the prompt is unsafe for workflow stability;
- the specific risky part or file when identifiable;
- a safer replacement prompt when the user's likely intent can be preserved safely.

If no safe replacement prompt exists, Codex must say that the request cannot be safely reformulated for this workflow.

Safe reformulation should preserve required stability content. For example, a request to replace `.gitignore` while adding unrelated ignores should be reformulated as a request to append or merge those ignores while preserving:

```gitignore
.codex/state.md
.codex/tmp/
```

When the internal helper `codex-flow internal gate stability` is available, Codex must run it before applying or adopting a diff that touches stability-sensitive workflow files. The helper is a minimum machine guardrail, not a complete semantic proof. A passing helper result does not allow Codex to ignore the textual Stability Safety Gate, but a failing helper result must block the state-changing command until the diff is fixed or the ambiguity is resolved.

The machine stability gate must at minimum reject workflow diffs that remove required rule anchors, corrupt the documented command surface, remove required `.gitignore` runtime entries, introduce unsupported override files, or use unsupported override replacement markers.

## Normal Prompt Behavior

If `Discussion Mode: active` is present in `.codex/state.md`, non-command user prompts are discussion prompts:

- do not create a new active step;
- do not update `.codex/current-step.md`;
- do not modify project files, project-owned `.codex` memory, reports, or runtime state;
- may inspect project files, dependency files, local git state, command output, and external documentation or network resources when needed to answer;
- may run diagnostic commands, including tests, lint/typecheck/build commands, dependency inspection, and network lookups, when useful for analysis;
- may perform experimental project edits, generation, installs, builds, migrations, or other mutating diagnostics only in a disposable scratch workspace such as a temp copy, temporary git worktree, or ignored `.codex/tmp/discuss-*` workspace;
- must preserve the main project workspace exactly as it was before discussion-mode reasoning, except for user-approved in-place diagnostics;
- must not run commands likely to mutate the main project workspace unless the user explicitly asks for in-place diagnostics and Codex first captures the initial state and states the restore plan;
- must not create commits.

While discussion mode is active, state-changing or execution workflow commands other than `strict:true`, `strict:false`, and `discuss:close` must return:

```text
Discussion mode is active.

Close discussion with discuss:close before running this command.
```

Read-only commands `help`, `status`, `compare`, `check`, `check:deep`, `details`, `details:<id>`, and `ls-steps:<n>` may run while discussion mode is active.

Before creating a new active step, Codex must pass the sync gate:

- git must be available as the base sync backend;
- `.codex/state.md` must have initialized `Last Known Revision` and `Last Known Branch`;
- the current git revision and branch must match `.codex/state.md`;
- pre-existing project changes must not be present, including staged changes, unstaged tracked-file changes, and untracked files that are not ignored by git.

For sync-gate purposes, pre-existing project changes are git-visible local changes that existed before the step started. Ignored transient runtime files do not by themselves block the sync gate, but ambiguous workflow state still requires `resync` or manual resolution.

If the sync gate fails, Codex must not create a new active step.

If pre-existing project changes are present before a normal step starts, Codex must stop and require manual cleanup or `resync` after the tree is clean. Pre-existing changes are not converted into a special step.

For any other sync-gate failure, Codex must require `resync` or manual resolution.

If no active step exists, the sync gate passes, and the user sends any non-command prompt, Codex must create a new active step in `.codex/current-step.md`. The prompt becomes the task.

After creating a new active step, Codex must respond with a concise step-start report, not a generic waiting message.

The step-start report must include:

- step id and a short task title;
- changed workflow state, usually `.codex/current-step.md` with the active step, task, base revision, and base branch;
- an explicit statement that project files have not been modified;
- expected project-file scope when it can be reasonably inferred from the task or quick inspection.

The step-start report must not claim that project files changed before `apply`.

Example:

```text
Step 12 created: Add compact mode setting.

Changed:
- .codex/current-step.md: recorded the active step, task, and git base.

Project files not changed.

Expected scope:
- src/settings.ts: add compact mode preference handling.
- test/settings.test.ts: cover persistence.

Next: `apply`.
```

If an active step exists and the user sends a non-command prompt, Codex must treat it as part of the current step.

A new step cannot be created while another step is active.

During a normal active step, before `apply`, Codex must not modify project files. Updating `.codex/current-step.md` to create or maintain the active step is allowed workflow-state maintenance, not project execution.

When a normal step starts, `.codex/current-step.md` must record the current git revision and branch as the step base. If that revision or branch changes outside the Codex flow while the step is active, Codex must stop and require `resync` before applying the step.

## current-step.md Active Format

An active step must use this structure:

```md
# Current Step

Status: active
Step ID: <id>

Task:
<original user task>

Base Sync:
Backend: git
Base Revision: <git revision>
Base Branch: <git branch>

Decisions:
<record:<id> decisions, or none>

Open Questions:
<open questions, or none>

Working Notes:
<notes useful for completing this step, or none>
```

`Step ID` must be the next report id defined by `.codex/core/after-step.md`.

Only `Decisions`, `Open Questions`, and `Working Notes` may be updated during an active step before `apply`, except when `forget` removes recorded decisions.

## discuss

Formats:

```text
discuss
discuss:close
```

Behavior:

- valid only as standalone commands received while Codex is waiting for user input;
- does not require the sync gate;
- does not create an active step;
- does not modify project code;
- does not run checks;
- does not create commits.

`discuss` enters read-only discussion mode by setting `Discussion Mode: active` in `.codex/state.md`.

`discuss` must not run while an active step exists. If an active step exists, return:

```text
Active step already exists.

Continue or complete the current step before starting discussion mode.
```

If `.codex/state.md` is missing, `discuss` may create the default state skeleton with `Last Known Revision: none`, `Last Known Branch: none`, `Last Sync Source: none`, `Strict Mode: true`, and `Discussion Mode: active`. Creating this skeleton does not initialize sync.

When `discuss` succeeds, return a concise message that discussion mode is active and that non-command prompts will not create steps until `discuss:close`.

`discuss:close` exits discussion mode by setting `Discussion Mode: none` in `.codex/state.md`.

`discuss:close` may run when sync state requires `resync` and whether or not discussion mode is already active.

If `.codex/state.md` is missing, `discuss:close` may create the default state skeleton with `Last Known Revision: none`, `Last Known Branch: none`, `Last Sync Source: none`, `Strict Mode: true`, and `Discussion Mode: none`. Creating this skeleton does not initialize sync.

Updates to discussion mode must preserve all other `.codex/state.md` fields, including `Strict Mode` and sync baseline fields.

## record

Format:

```text
record:<id> "description"
```

`<id>` must:

- contain only lowercase letters, numbers, and hyphens;
- not start with `-`;
- not end with `-`;
- not contain `--`.

`description` must not be empty.

Examples:

```text
record:api-v2 "Use the v2 endpoint."
record:asset-loading "Use AssetsManager instead of direct Pixi Assets calls."
```

Behavior:

- requires an active step;
- stores or updates a decision in `.codex/current-step.md`;
- must pass the Stability Safety Gate before storing or updating the decision;
- acts as upsert: the same id replaces the previous value;
- does not modify project code;
- does not run checks;
- does not finalize the step or run sync actions.

If no active step exists, return:

```text
No active step.
```

## forget by id

Format:

```text
forget:<id>
```

Behavior:

- requires an active step;
- removes one decision from the current step;
- must pass the Stability Safety Gate before removing the decision;
- does not cancel the step.

If no active step exists, return:

```text
No active step.
```

If the id does not exist, return an informational message and make no unsafe change.

## forget all

Format:

```text
forget
```

Behavior:

- requires an active step;
- removes all recorded decisions from the current step;
- must pass the Stability Safety Gate before removing decisions;
- does not cancel the step;
- preserves task, open questions, and working notes.

If no active step exists, return:

```text
No active step.
```

## apply

Format:

```text
apply
```

Behavior:

- requires an active step;
- applies the current step according to the task, recorded decisions, and working notes;
- must produce at least one commit-worthy payload change before completed-step metadata is written;
- must not complete as a metadata-only step;
- runs required project checks;
- if checks fail, stops and keeps the same step active;
- if checks pass, runs the after-step process;
- updates Codex memory and reports;
- uses required git sync and completes the step only after the required git commit succeeds.

If the required git commit cannot be created, `apply` must stop and the step must not complete.

If no active step exists, return:

```text
No active step.
```

If pre-existing project changes are detected before starting a new normal step, Codex must stop and require manual cleanup or `resync` after the tree is clean. Codex must not create a special step for pre-existing changes.

The only command that may intentionally convert pre-existing manual working-tree changes into completed Codex step history is `adopt-step "title"`.

## discard-step

Format:

```text
discard-step
```

Behavior:

- requires an active step;
- abandons the active step without applying work;
- updates `.codex/current-step.md` back to inactive state;
- derives `Last completed step` from completed history/reports;
- does not modify project code;
- does not run checks;
- does not create completed-step metadata;
- does not update `.codex/history.md`, `.codex/last-report.md`, `.codex/reports/`, `.codex/next-step.md`, or `.codex/context.md`;
- finalizes versioned workflow state automatically so the git working tree is clean after success;
- creates at most one cleanup git commit when inactive versioned workflow state differs from `HEAD` after clearing the active step;
- updates transient `.codex/state.md` after a cleanup commit when doing so will not make the git working tree dirty;
- does not create completed-step history, reports, or next-step recommendations;
- leaves no active step and no pending git-visible workflow state changes after success.

`discard-step` is for intentionally abandoning stale, mistaken, or no-longer-needed active steps. It is a terminal workflow operation, but it is not a completed Codex step and must not be recorded as one.

Before discarding, Codex must inspect git-visible working-tree changes. If any staged, unstaged tracked-file, or untracked non-ignored changes are present other than `.codex/current-step.md`, Codex must stop and report those paths. Codex must not use `discard-step` to hide or orphan project work.

If clearing the active step leaves commit-worthy versioned workflow state changes, Codex must commit those changes before reporting success. The cleanup commit must not create completed-step metadata and must not commit `.codex/current-step.md` while it contains an active step.

If cleanup commit creation fails, Codex must restore the pre-discard active step state and stop. The step remains active when exact recovery succeeds.

If no active step exists, return:

```text
No active step.
```

After a successful `discard-step`, `resync` must be immediately possible because the working tree is clean and `.codex/current-step.md` is inactive.

## adopt-step

Format:

```text
adopt-step "title"
```

`title` must not be empty after trimming whitespace and must not contain line breaks.

Behavior:

- requires no active step;
- adopts the current manual working-tree diff as one completed Codex step;
- is the only command that may intentionally convert pre-existing staged changes, unstaged tracked-file changes, or untracked non-ignored files into a completed Codex step;
- requires an initialized git sync backend in `.codex/state.md`;
- requires the current git revision and branch to match `Last Known Revision` and `Last Known Branch` in `.codex/state.md`;
- requires at least one commit-worthy manual change after excluding transient runtime state;
- must not treat transient runtime files as commit-worthy payload;
- must not commit transient runtime files;
- must not adopt pre-existing manual changes in versioned Codex memory/config files; those files may be changed only by the adopted-step finalization process after gates and checks pass;
- must run the Stability Safety Gate against the manual diff before running checks or writing completed-step metadata;
- must run required project checks against the current working tree;
- if checks fail, stops without creating completed-step metadata, without updating history, without clearing or creating an active step, and without creating a git commit;
- if checks pass, runs the after-step process for an adopted manual step;
- writes reports and history that clearly state the step adopted a manual working-tree diff through `adopt-step`;
- must not invent reasoning that is not supported by the inspected diff or user-provided context;
- creates exactly one git commit for the adopted step;
- updates `.codex/state.md` after the commit with the final git revision and `Last Sync Source: adopt-step:<step-id>`.

Manual working-tree diff means all staged changes, unstaged tracked-file changes, and untracked files that are not ignored by git at the moment `adopt-step` starts.

Transient runtime files are:

```text
.codex/state.md
.codex/tmp/**
```

Versioned Codex memory/config files protected from pre-existing manual adoption are:

```text
.codex/config.toml
.codex/context.md
.codex/history.md
.codex/current-step.md
.codex/next-step.md
.codex/last-report.md
.codex/reports/*
```

If no active step exists but the current git revision or branch does not match `.codex/state.md`, Codex must stop and require `resync` or manual resolution before adoption.

If the only changes are transient runtime files, Codex must return:

```text
No commit-worthy manual changes to adopt.
```

If an active step already exists, return:

```text
Active step already exists.

Continue the current step before adopting manual changes.
```

## help

Format:

```text
help
```

Behavior:

- read-only;
- shows state-aware guidance for the current workflow state;
- does not modify files;
- does not run project verification commands;
- does not create a step;
- does not require an active step;
- does not require the sync gate;
- does not require a clean working tree;
- does not require `resync`;
- may run while discussion mode is active;
- may run while an active step exists.

`help` must inspect enough local state to avoid generic advice when state is available:

- git availability, current branch, current revision, and working-tree cleanliness;
- `.codex/state.md` existence, sync baseline, Strict Mode, and Discussion Mode;
- `.codex/current-step.md` active or inactive state;
- latest completed step or report availability when useful.

The output must include:

- current workflow state summary;
- required next action when the workflow is blocked, uninitialized, dirty, ambiguous, in discussion mode, or inside an active step;
- available actions that are valid in the current state;
- blocked actions and the reason they are blocked;
- a brief explanation of what each available action will do.

When no active step exists, discussion mode is inactive, sync state is initialized, and the git tree is clean, `help` should explain at least these available paths:

- send a normal task prompt to create a new active step;
- run `ok` to create a new active step from the recommended next step when `.codex/next-step.md` contains a substantive recommendation;
- run `discuss` to enter discussion mode before choosing executable work;
- run read-only review commands such as `status`, `check`, `check:deep`, `compare`, `details`, or `ls-steps:<n>` when useful.

When no active step exists, discussion mode is inactive, sync state is initialized, and the git tree is clean, the `help` output must end with the recommended next step from `.codex/next-step.md`, in addition to the other state-aware guidance. If `.codex/next-step.md` has no substantive recommendation yet, `help` must end by saying that no recommendation has been recorded yet and recommend that the user explicitly provide the next task prompt or run `discuss` to decide one.

When sync state is missing or uninitialized, `help` must explain the install-to-work sequence:

1. review and commit versioned workflow files created by bootstrap;
2. make sure the git working tree is clean;
3. run `resync`;
4. then send a normal task prompt or run `discuss`.

When the git tree is dirty before a normal step starts, `help` must distinguish:

- clean or commit the manual changes, then run `resync` when the tree is clean;
- run `check` for a read-only current-diff review;
- run `adopt-step "title"` only when the user intentionally wants to convert the manual diff into one completed Codex step and all `adopt-step` gates can pass.

When an active step exists, `help` must explain that a new step, `discuss`, and `adopt-step` are blocked until the current step is completed or resolved. It must list valid current-step actions such as:

- continue discussing or refining the active step;
- use `record:<id> "description"` to store a decision;
- use `forget:<id>` or `forget` to remove recorded decisions;
- run `apply` to execute the active step;
- run `discard-step` to abandon the active step when no project changes would be orphaned;
- run read-only commands such as `status`, `check`, `check:deep`, `compare`, `details`, or `ls-steps:<n>`.

When discussion mode is active, `help` must explain that normal prompts remain discussion prompts and do not create steps. It must list:

- ask questions or request analysis without changing the main workspace;
- use `discuss:close` before starting executable work;
- use allowed read-only commands;
- state-changing or execution commands other than `strict:true`, `strict:false`, and `discuss:close` are blocked until discussion mode is closed.

## status

Format:

```text
status
```

Behavior:

- read-only;
- shows the current system state;
- does not modify files;
- does not run checks;
- does not create a step.

If an active step exists, show:

- Strict Mode;
- Discussion Mode;
- Step ID;
- Task;
- Decisions;
- Open Questions;
- Step Working Notes;
- relevant state warnings.

If no active step exists, show:

- Strict Mode;
- Discussion Mode;
- no active step;
- last completed step if known from history;
- recommended next step from `.codex/next-step.md`;
- relevant state warnings.

## compare

Formats:

```text
compare
compare:<branch-name>
```

If `<branch-name>` is omitted, the target branch is `main`.

`<branch-name>` must:

- not be empty;
- contain no whitespace;
- contain no shell metacharacters;
- resolve to a local branch or locally known remote-tracking branch.

Behavior:

- read-only;
- compares the current checked-out branch with the target branch;
- uses only local git state;
- does not fetch remote refs;
- does not modify files;
- does not run checks;
- does not create a step.

The comparison output must include:

- current branch;
- target branch;
- merge base, when available;
- commits only on the current branch;
- commits only on the target branch;
- changed files summary for the current branch relative to the target branch;
- MR risk assessment for merging the current branch into the target branch;
- relevant state warnings, including dirty working tree, detached HEAD, missing target branch, or missing merge base.

The MR risk assessment must include:

- main compatibility risks, especially backward compatibility risks;
- affected contracts, APIs, data formats, schemas, migrations, configuration, dependencies, security, privacy, performance, and user-facing behavior when relevant;
- test and verification gaps;
- likely merge or rollout risks;
- overall MR safety rating;
- recommended actions before merge.

The assessment must be based on the local branch comparison. If MR platform metadata is unavailable, Codex must state that only the local diff was reviewed.

If the target branch cannot be resolved, return an informational message and make no unsafe change.

## check

Formats:

```text
check
check:deep
```

Behavior shared by both formats:

- read-only;
- uses only local project files, local dependency files when inspected, and local git state;
- does not fetch remote refs;
- does not modify files;
- does not run project verification commands;
- does not create a step;
- does not require an active step;
- does not require the sync gate;
- does not require a clean working tree;
- does not require `resync`.

`check` is a current-diff risk review.

`check` must analyze only the current local changes relative to `HEAD`, including staged changes, unstaged changes, and untracked files when their contents are available.

`check` must not report unrelated pre-existing project problems as findings. A finding belongs in `check` only when it is introduced by, exposed by, or directly affected by the current diff. If Codex cannot determine whether a problem predates the diff, it must label that uncertainty instead of presenting the issue as a diff finding.

The `check` output must include:

- review scope and baseline commit;
- current branch;
- staged, unstaged, and untracked file summary;
- relevant state warnings such as dirty working tree, active step, detached HEAD, or missing `HEAD`;
- diff summary;
- backward compatibility risks;
- affected contracts, APIs, data formats, schemas, migrations, configuration, dependencies, security, privacy, performance, and user-facing behavior when relevant;
- likely bugs or behavioral regressions introduced by the diff;
- test and verification gaps for the diff;
- overall diff risk rating;
- recommended actions before committing or resyncing.

The `check` report must state that the assessment is limited to the current local diff and excludes unrelated baseline issues.

`check:deep` is a whole-project risk review.

`check:deep` must analyze the project as it currently exists in the working tree, including dirty local changes when present, and must clearly state whether the reviewed tree is clean or dirty.

The `check:deep` output must include:

- review scope and current git state;
- project-wide architecture, maintainability, and workflow risks;
- backward compatibility and migration risks;
- configuration, dependency, build, test, security, privacy, performance, and operational risks when relevant;
- `.codex` workflow consistency risks when the project uses this workflow;
- important missing tests or verification gaps;
- prioritized findings;
- overall project risk rating;
- recommendations.

`check:deep` may report baseline project problems even when they are unrelated to the current diff, but it must distinguish project-wide findings from issues introduced by dirty local changes when that distinction is visible.

## details

Format:

```text
details
```

Behavior:

- read-only;
- shows the latest full report from `.codex/last-report.md`;
- does not modify files.

If no reports are available, return:

```text
No reports available.
```

## details by id

Format:

```text
details:<id>
```

`<id>` must be a positive integer.

Examples:

```text
details:1
details:42
```

Behavior:

- read-only;
- shows `.codex/reports/<id>.md`;
- does not modify files.

If the report does not exist, return:

```text
No report found for step <id>.
```

## ls-steps

Format:

```text
ls-steps:<n>
```

`<n>` must be a positive integer.

Behavior:

- read-only;
- shows the last `n` completed steps from `.codex/history.md`;
- output order must be chronological, with the latest step last;
- each row must include step id and title.

Example output:

```text
38 | Fix anticipation timing
39 | Add command system
40 | Introduce resync
```

## resync

Format:

```text
resync
```

Behavior:

- reconciles Codex flow runtime state with the current project sync state;
- uses git as the base sync backend;
- does not apply project code changes;
- does not create commits;
- must not modify versioned project files or versioned `.codex` memory;
- may update only transient workflow runtime state such as `.codex/state.md`;
- does not continue active work automatically.

Codex must require `resync` when it detects:

- the git revision changed outside the Codex flow;
- the git branch changed unexpectedly;
- reset, rebase, checkout, pull, merge, or revert changed history unexpectedly;
- `.codex` memory does not match current flow state;
- reports/history/state are inconsistent.

`resync` must:

1. detect the current sync backend from `.codex/state.md` and the project environment;
2. verify that the base workflow can use git as its sync backend;
3. read the current git revision and compare it with the last known revision in `.codex/state.md`;
4. inspect working tree changes that could affect the active step;
5. inspect `.codex/history.md`;
6. inspect `.codex/reports/`;
7. inspect `.codex/current-step.md`;
8. determine whether the mismatch is an uninitialized baseline, external commit, rollback, branch switch, dirty project state, missing report, future report, or unknown flow state;
9. update transient Codex runtime state only when safe;
10. never delete reports automatically;
11. output a clear resync report.

`resync` must preserve the current `Strict Mode` value in `.codex/state.md`. If the field is missing, initialize it as `Strict Mode: true`.

`resync` may initialize or advance `Last Known Revision` and `Last Known Branch` only when the git working tree is clean, no active normal step is being overwritten, and history/report/current-step state is unambiguous. For `resync`, a clean git working tree means no staged changes, no unstaged tracked-file changes, and no untracked files that are not ignored by git. If versioned project files, versioned `.codex` memory, or untracked non-ignored files are dirty, `resync` must report the dirty paths and wait for the user to clean the tree or resolve the ambiguity.

External git commits must not be converted into normal Codex steps. They may be recorded in `.codex/state.md` and the resync report as external sync events if useful. `resync` must not append external sync events to `.codex/history.md`.

If rollback or rewritten history invalidates reports, Codex must explain affected memory as detached/outdated in the resync report rather than deleting or rewriting versioned memory automatically.

If an active step was based on an old git revision, Codex must suspend it or require user review.

## Removed Commands

The following commands do not exist:

```text
commit
commit "message"
apply-only
run-steps
run-steps:auto
abort-steps
```

Manual commits should be done directly with git by the user.
