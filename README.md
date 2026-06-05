# Codex Flow

npm CLI package for installing the Codex Flow starter pack into projects where Codex should work through explicit steps, keep local memory in `.codex/`, and avoid repeated approval prompts after the project is trusted.

## Package Usage

Requires Node.js 18 or newer.

Run directly with `npx`:

```bash
npx @repepto/codex-flow init
npx @repepto/codex-flow update --commit
npx @repepto/codex-flow doctor
```

Or install globally:

```bash
npm install -g @repepto/codex-flow
codex-flow init
codex-flow update --commit
codex-flow doctor
```

The package is published to GitHub Packages. Configure npm authentication before installing or publishing:

```bash
npm login --scope=@repepto --auth-type=legacy --registry=https://npm.pkg.github.com
```

Before the package is published, run the full local check:

```bash
npm run check
```

To target another project from a local checkout:

```bash
node /path/to/codex-flow/bin/codex-flow.js init --target /path/to/project
```

## CLI Reference

```bash
codex-flow init [--target <dir>] [--force] [--dry-run]
codex-flow update [--target <dir>] [--commit] [--dry-run]
codex-flow doctor [--target <dir>]
```

- `init` requires a git repository. If the target is not in one, it asks whether to run `git init`; declining leaves the project unchanged and exits with status `1`.
- After git is available, `init` installs `AGENTS.md` and `.codex/core/`, creates missing bootstrap state/data files plus `.codex/config.toml`, and appends required `.gitignore` runtime entries.
- `update` replaces only `AGENTS.md` and package-owned `.codex/core/` files, and creates `.codex/config.toml` if missing. It does not overwrite project-owned state/data files or an existing `.codex/config.toml`.
- `update` removes obsolete package-owned `.codex/core/` files from older starter-pack versions.
- `update --commit` requires a clean git working tree, runs update, validates the result with the same checks as `doctor`, stages only `AGENTS.md`, `.codex/core/`, and `.codex/config.toml`, and creates `chore: update codex flow` when update changes exist.
- `update --commit` cannot be combined with `--dry-run`.
- `doctor` validates the installed workflow shape, required runtime ignores, supported overrides, core rule anchors, and command-surface consistency.

## Validation Model

Codex Flow includes deterministic validation helpers in `lib/workflow.js`.

They cover:

- exact workflow command parsing;
- documented command-surface consistency between `.codex/core/commands.md` and `README.md`;
- removed-command detection for commands such as `commit`, `apply-only`, `run-steps`, and `run-steps:auto`;
- inline multi-step prompt grammar for `steps: task one /-/ task two`;
- normal-step sync gate evaluation;
- `resync` clean-tree gate evaluation;
- `adopt-step` dirty-diff gate evaluation;
- uninitialized sync-baseline diagnostics that do not report revision or branch mismatches until the baseline exists.

`doctor` uses these helpers for package/install invariants. The automated test suite uses them with temporary downstream projects to exercise install, update, update commit, override, non-git, and sync-gate scenarios.

## Install In A Project

From the project root, run:

```bash
npx @repepto/codex-flow init
```

If the project is not already in a git repository, `init` asks whether to create one with `git init`. If the answer is no, `init` exits with status `1` without installing files.

The CLI installs these workflow templates:

```text
AGENTS.md
.codex/core/
```

It also creates missing project-owned `.codex/` state/data files and project-scoped Codex runtime config, without overwriting existing ones, and makes sure the project ignores runtime state:

```gitignore
.codex/state.md
.codex/checkpoints/
.codex/tmp/
```

Commit `AGENTS.md`, `.codex/core/`, the required `.gitignore` entries, and the generated versioned project-owned files before starting the flow. Do not commit ignored runtime state such as `.codex/state.md`.

Open the project with Codex and trust the project when prompted.

The generated project-owned files include:

```text
.codex/config.toml
.codex/context.md
.codex/history.md
.codex/current-step.md
.codex/next-step.md
.codex/last-report.md
.codex/reports/
.codex/state.md
```

Commit the generated versioned project-owned files before the first `resync`. `.codex/config.toml` is versioned project runtime config; `.codex/state.md` remains ignored runtime state. `.codex/reports/` may be an empty local directory until the first completed step writes a report file.

After the working tree is clean, run:

```text
resync
```

After `resync`, normal work can start.

## Daily Workflow

1. Send a normal task prompt. Codex creates an active step.
2. Discuss, inspect, and refine the step as needed.
3. Optionally record decisions:

```text
record:<id> "description"
```

4. Run:

```text
apply
```

`apply` performs the work, runs checks, writes reports/history, updates `.codex/current-step.md`, and creates a git commit.

For multiple tasks that should run as one ordered chain, send one single-line prompt:

```text
steps: first task /-/ second task /-/ third task
```

## Commands

```text
help
status
discuss
discuss:close
record:<id> "description"
forget:<id>
forget
apply
adopt-step "title"
details
details:<id>
ls-steps:<n>
compare
compare:<branch-name>
check
check:deep
abort-steps
resync
strict:true
strict:false
```

Commands must match exactly. Extra text means it is treated as a normal prompt, not a command.

Use `help` at any point for state-aware guidance. It is read-only and explains what actions are currently available, what actions are blocked, and what the next required step is when the flow is uninitialized, dirty, in discussion mode, inside an active step, or inside a step chain.

## Important Behavior

- During a normal active step, before `apply`, Codex must not edit project files. It may only maintain `.codex/current-step.md`; standalone runtime commands such as `resync`, `strict:true`, and `strict:false` may update workflow state as defined by the rule files.
- `help` is a read-only state-aware guide. It can run before `resync`, on a dirty tree, during discussion mode, inside an active step, and during an active or paused step chain.
- After a normal prompt creates an active step, Codex reports the step id, changed workflow state, confirms project files were not modified, and lists expected project-file scope when it can infer one. It must not use a generic "waiting for apply" message.
- Use `discuss` to enter consultation mode before choosing a step. While discussion mode is active, normal prompts do not create steps, edit the main workspace, or create commits. Codex may run diagnostics and may perform mutating experiments only in a disposable scratch workspace such as a temp copy, temporary git worktree, or ignored `.codex/tmp/discuss-*` path. Close it with `discuss:close` before starting executable work.
- If the git tree has staged, unstaged, or untracked non-ignored changes before a new step, Codex stops. Clean it manually, then run `resync`.
- To intentionally accept manual staged, unstaged, or untracked non-ignored changes as one completed flow step, run `adopt-step "title"` while no step or step chain is active.
- `check` is a read-only review of the current local diff relative to `HEAD`; it can run on a dirty tree and excludes unrelated baseline issues.
- `check:deep` is a read-only whole-project review; it can run on a dirty tree and reports project-wide risks, problems, and recommendations.
- `resync` initializes or advances the sync baseline only when the git tree has no staged, unstaged, or untracked non-ignored changes and workflow state is unambiguous.
- Before the first successful `resync`, normal step and `adopt-step` gates report the uninitialized sync baseline directly. They do not also report revision or branch mismatch warnings for the placeholder `none` values.
- `.codex/state.md` is local runtime state and must not be committed.
- `strict:true` and `strict:false` may create `.codex/state.md`, but only with an uninitialized sync baseline.
- `.codex/current-step.md` is committed only when it is inactive.
- `steps: task one /-/ task two` starts an inline step chain and creates one final commit after all chain steps pass.
- `abort-steps` restores the checkpoint created before an inline step chain.
- Project overrides may extend rules, but cannot replace whole rule files or weaken mandatory safety rules.
- Codex refuses prompts that would damage workflow stability, explains why, and suggests a safer prompt when possible.

## Permissions

`.codex/core/config.toml` defines the starter-pack defaults that bootstrap copies into project-owned `.codex/config.toml` when that file is missing:

```toml
approval_policy = "never"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
```

Codex loads the project-owned `.codex/config.toml` only after the project is trusted.

## Files Users Usually Touch

- `.codex/context.md` - long-lived project knowledge, only when it is truly useful.
- `.codex/overrides/` - optional project-specific rule extensions.

`.codex/core/` is the upgradeable workflow system. Root `.codex` state/data files are project memory maintained by Codex.

## Upgrade Safety

`AGENTS.md` and `.codex/core/` can be replaced from a newer starter pack version.

From the project root, run:

```bash
npx @repepto/codex-flow update --commit
```

`update --commit` is the normal upgrade path when the working tree is clean. It runs the workflow validation before committing and only stages `AGENTS.md`, `.codex/core/`, and a missing `.codex/config.toml` if the project did not have one yet.

To review the upgrade manually instead, run:

```bash
npx @repepto/codex-flow update
npx @repepto/codex-flow doctor
git diff -- AGENTS.md .codex/core .codex/config.toml
git add AGENTS.md .codex/core .codex/config.toml
git commit -m "chore: update codex flow"
```

Do not replace project-owned state/data files or an existing project `.codex/config.toml` during an upgrade:

```text
.codex/context.md
.codex/config.toml
.codex/history.md
.codex/current-step.md
.codex/next-step.md
.codex/state.md
.codex/last-report.md
.codex/reports/*
.codex/checkpoints/
.codex/tmp/
```

Those files contain project memory, reports, checkpoints, or runtime state.

## Package Maintenance

Run local checks before publishing:

```bash
npm run check
```

`npm run check` runs the automated test suite, package-source `doctor`, and package dry-run.

Individual checks are also available:

```bash
npm test
npm run doctor
npm run pack:dry-run
```

The test suite covers:

- exact command parsing and invalid-command rejection;
- README/core command-list consistency;
- inline multi-step prompt grammar;
- non-git `init` cancellation;
- downstream `init` plus `doctor`;
- installed-project README handling;
- downstream `update` preserving project-owned state;
- downstream `update --commit` validation, clean-tree gate, no-op handling, and commit creation;
- invalid override rejection;
- sync-gate behavior for `resync`, normal steps, discussion mode, and `adopt-step`.

Publish when the package metadata, version, and license are ready:

```bash
npm login --scope=@repepto --auth-type=legacy --registry=https://npm.pkg.github.com
npm publish
```

## Examples

Commands in `bash` blocks run in a terminal. Text blocks are Codex chat input after the project is opened; some are exact workflow commands and some are normal task prompts.

### Example 1: Install From Zero

Run this from the project root:

```bash
npx @repepto/codex-flow init
npx @repepto/codex-flow doctor
git status --short
git add AGENTS.md .gitignore .codex/core .codex/config.toml .codex/context.md .codex/history.md .codex/current-step.md .codex/next-step.md .codex/last-report.md
git commit -m "chore: install codex flow"
```

- `npx @repepto/codex-flow init` first verifies that the project is inside a git repository. If it is not, it asks whether to create one with `git init`; answering no exits with status `1` and does not change the project.
- After git is available, `npx @repepto/codex-flow init` installs `AGENTS.md`, `.codex/core/`, `.codex/config.toml`, bootstrap state/data files, and required runtime `.gitignore` entries.
- `npx @repepto/codex-flow doctor` verifies the installed workflow files and required ignores before Codex starts using them.
- `git status --short` shows what was created. `.codex/state.md` should not appear because it is ignored runtime state.
- `git add ...` stages only versioned workflow files, project runtime config, and project-owned memory files. It intentionally excludes `.codex/state.md`, `.codex/checkpoints/`, and `.codex/tmp/`.
- `git commit ...` records the installed workflow in project history.

Then open the project with Codex and run:

```text
resync
status
```

- `resync` initializes Codex Flow's git baseline after the install commit is clean and unambiguous.
- `status` confirms Strict Mode, active-step state, last completed step, and next recommendation.

### Example 2: Diagnose A Workflow Install

Run this when the workflow looks suspicious, an override was added, `.gitignore` changed, or an upgrade was applied:

```bash
npx @repepto/codex-flow doctor
```

- `doctor` is read-only. It does not create steps, run project checks, edit files, or create commits.
- It verifies required files, core rule anchors, command-surface consistency, required runtime ignores, and supported overrides.
- If it reports a missing `.gitignore` entry, restore the required runtime ignores before continuing:

```gitignore
.codex/state.md
.codex/checkpoints/
.codex/tmp/
```

### Example 3: Resync After A Manual Git Commit

Use this when a human made a normal git commit outside Codex Flow and the working tree is clean:

```bash
git status --short
```

Then in Codex chat:

```text
resync
status
```

- `git status --short` should be empty before `resync`; dirty project files make the sync state ambiguous.
- `resync` updates transient runtime sync state so Codex Flow knows the current branch and commit.
- `status` checks that no active step is stale and that the flow is ready for normal work.

`resync` does not convert external commits into completed Codex steps and does not append them to `.codex/history.md`.

### Example 4: Discuss Before Choosing A Step

Use discussion mode when you want advice or exploration without creating an active step:

```text
discuss
```

Then ask normal questions:

```text
Which compact mode implementation would be safest for this project?
```

When you are ready to work through the normal step flow:

```text
discuss:close
```

- `discuss` updates ignored runtime state only; it does not create a step, edit the main workspace, run executable workflow commands, or create commits.
- Normal discussion prompts may run useful diagnostics, tests, local inspection, or network lookups. Mutating experiments must happen in a disposable scratch workspace such as a temp copy, temporary git worktree, or ignored `.codex/tmp/discuss-*` path.
- While discussion mode is active, read-only commands such as `help`, `status`, `check`, `check:deep`, `compare`, `details`, and `ls-steps:<n>` may still run.
- State-changing or execution commands such as `apply` and `adopt-step` require `discuss:close` first. Inline `steps: ... /-/ ...` prompts also remain discussion prompts until discussion mode is closed.

### Example 5: Complete A Normal Codex Step

Start with a normal task prompt in Codex chat:

```text
Add a settings toggle for compact mode.
```

Optionally record a decision before implementation:

```text
record:compact-mode-storage "Store the compact mode preference in localStorage."
```

Then execute the step:

```text
apply
```

- The normal prompt creates an active step when the sync gate passes.
- The step-start response reports `.codex/current-step.md` as the only changed file before `apply`, confirms project files are unchanged, and names expected project-file scope when inferable.
- `record:<id> "decision"` stores a step decision in `.codex/current-step.md`; it does not edit project code.
- `apply` performs the work, runs required checks, writes reports/history, updates `.codex/current-step.md`, creates one git commit, and updates runtime sync state.

After success:

```text
details
```

- `details` shows the latest full report copied to `.codex/last-report.md`.

### Example 6: Review A Dirty Diff Without Adopting It

Use this when files are already changed and you want a read-only risk review:

```text
check
```

- `check` is a Codex Flow command, not the npm CLI command.
- It reviews the current local diff relative to `HEAD`, including staged changes, unstaged tracked changes, and untracked files when readable.
- It does not run project verification commands, write reports, update history, or create commits.

For a whole-project review instead of current-diff review:

```text
check:deep
```

### Example 7: Adopt Manual File Changes As A Completed Step

Use this when the user manually edited files and wants those changes recorded as a real Codex Flow step.

First inspect the diff:

```text
check
```

Then adopt it:

```text
adopt-step "Update compact mode manually"
```

- `check` helps review the manual dirty diff before adopting it.
- `adopt-step "title"` requires no active step, no active step chain, an initialized sync baseline, and a current branch/revision that still matches `.codex/state.md`.
- It runs the Stability Safety Gate and required project checks.
- On success, it writes a completed report, updates history and next-step recommendation, creates one git commit, and updates `.codex/state.md` with `Last Sync Source: adopt-step:<step-id>`.
- On check failure, it leaves the manual diff as-is and does not create completed-step metadata or a git commit.

### Example 8: Run An Inline Step Chain

Use a single-line `steps:` prompt when you want multiple tasks executed in order as one chain:

```text
steps: Add compact mode setting and persist it /-/ Cover compact mode persistence with tests
```

- The prompt must start with exact lowercase `steps: `.
- Tasks are separated by the exact delimiter ` /-/ `.
- At least two non-empty tasks are required.
- Codex creates a checkpoint, executes tasks in order, defers intermediate commits, and creates one final git commit for the whole chain.
- If a chain step fails checks, the chain pauses inside that active step. Continue fixing it, then run `apply`.
- `abort-steps` cancels the active chain and restores the pre-chain checkpoint.

### Example 9: Upgrade Codex Flow In A Project

Run this from the installed project root:

```bash
npx @repepto/codex-flow update --commit
```

Then in Codex chat:

```text
resync
```

- `update` replaces package-owned workflow files: `AGENTS.md` and `.codex/core/*`.
- It removes obsolete package-owned core files from older starter-pack versions.
- It may create a missing `.codex/config.toml`, but it does not overwrite an existing project config or touch `.codex/context.md`, `.codex/history.md`, `.codex/current-step.md`, `.codex/state.md`, reports, checkpoints, or tmp files.
- `update --commit` requires a clean git working tree, checks the upgraded install before committing, and creates `chore: update codex flow` only when update changes exist.
- `resync` makes Codex Flow aware of the upgrade commit after the working tree is clean.
