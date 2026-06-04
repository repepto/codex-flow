# Codex Flow

Npm CLI package for installing the Codex Flow starter pack into projects where Codex should work through explicit steps, keep local memory in `.codex/`, and avoid repeated approval prompts after the project is trusted.

## Package Usage

Requires Node.js 18 or newer.

Run directly with `npx`:

```bash
npx codex-flow init
npx codex-flow update
npx codex-flow doctor
```

Or install globally:

```bash
npm install -g codex-flow
codex-flow init
codex-flow update
codex-flow doctor
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
codex-flow update [--target <dir>] [--dry-run]
codex-flow doctor [--target <dir>]
```

- `init` requires a git repository. If the target is not in one, it asks whether to run `git init`; declining leaves the project unchanged and exits with status `1`.
- After git is available, `init` installs `AGENTS.md` and `.codex/core/`, creates missing bootstrap state/data files, and appends required `.gitignore` runtime entries.
- `update` replaces only `AGENTS.md` and package-owned `.codex/core/` files. It does not touch project-owned state/data files.
- `doctor` validates the installed workflow shape, required runtime ignores, supported overrides, core rule anchors, command-surface consistency, and `run-steps` examples.

## Validation Model

Codex Flow includes deterministic validation helpers in `lib/workflow.js`.

They cover:

- exact workflow command parsing;
- documented command-surface consistency between `.codex/core/commands.md` and `README.md`;
- removed-command detection for commands such as `commit`, `apply-only`, and `run-steps:auto`;
- `.codex/steps.md` executable-item grammar for `run-steps`;
- normal-step sync gate evaluation;
- `resync` clean-tree gate evaluation;
- `adopt-step` dirty-diff gate evaluation;
- uninitialized sync-baseline diagnostics that do not report revision or branch mismatches until the baseline exists.

`doctor` uses these helpers for package/install invariants. The automated test suite uses them with temporary downstream projects to exercise install, update, override, non-git, and sync-gate scenarios.

## Install In A Project

From the project root, run:

```bash
npx codex-flow init
```

If the project is not already in a git repository, `init` asks whether to create one with `git init`. If the answer is no, `init` exits with status `1` without installing files.

The CLI installs these workflow templates:

```text
AGENTS.md
.codex/core/
```

It also creates missing project-owned `.codex/` state/data files, without overwriting existing ones, and makes sure the project ignores runtime state:

```gitignore
.codex/state.md
.codex/checkpoints/
.codex/tmp/
```

Commit `AGENTS.md`, `.codex/core/`, the required `.gitignore` entries, and the generated versioned project-owned files before starting the flow.

Open the project with Codex and trust the project when prompted.

The generated project-owned files include:

```text
.codex/context.md
.codex/history.md
.codex/current-step.md
.codex/next-step.md
.codex/steps.md
.codex/last-report.md
.codex/reports/
.codex/state.md
```

Commit the generated versioned project-owned files before the first `resync`. `.codex/state.md` remains ignored runtime state.

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
adopt-step "title"
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
- If the git tree has staged, unstaged, or untracked non-ignored changes before a new step, Codex stops. Clean it manually, then run `resync`.
- To intentionally accept manual staged, unstaged, or untracked non-ignored changes as one completed flow step, run `adopt-step "title"` while no step or `run-steps` chain is active.
- `check` is a read-only review of the current local diff relative to `HEAD`; it can run on a dirty tree and excludes unrelated baseline issues.
- `check:deep` is a read-only whole-project review; it can run on a dirty tree and reports project-wide risks, problems, and recommendations.
- `resync` initializes or advances the sync baseline only when the git tree has no staged, unstaged, or untracked non-ignored changes and workflow state is unambiguous.
- Before the first successful `resync`, normal step and `adopt-step` gates report the uninitialized sync baseline directly. They do not also report revision or branch mismatch warnings for the placeholder `none` values.
- `.codex/state.md` is local runtime state and must not be committed.
- `strict:true` and `strict:false` may create `.codex/state.md`, but only with an uninitialized sync baseline.
- `.codex/current-step.md` is committed only when it is inactive.
- `run-steps` reads `.codex/steps.md`, runs the listed steps as one chain, and creates one final commit.
- `abort-steps` restores the checkpoint created before `run-steps`.
- Project overrides may extend rules, but cannot replace whole rule files or weaken mandatory safety rules.
- Codex refuses prompts that would damage workflow stability, explains why, and suggests a safer prompt when possible.

## Permissions

`.codex/core/config.toml` defines the starter-pack Codex defaults:

```toml
approval_policy = "never"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
```

The workflow reads this core config only after the project is trusted.

## Files Users Usually Touch

- `.codex/steps.md` - queued steps for `run-steps`.
- `.codex/context.md` - long-lived project knowledge, only when it is truly useful.
- `.codex/overrides/` - optional project-specific rule extensions.

Before `run-steps`, commit `.codex/steps.md` changes, run `resync`, then run `run-steps`. After `run-steps`, manually clear or replace `.codex/steps.md` before running another chain.

`.codex/core/` is the upgradeable workflow system. Root `.codex` state/data files are project memory maintained by Codex.

## Upgrade Safety

`AGENTS.md` and `.codex/core/` can be replaced from a newer starter pack version.

From the project root, run:

```bash
npx codex-flow update
```

Do not replace project-owned state/data files during an upgrade:

```text
.codex/context.md
.codex/history.md
.codex/current-step.md
.codex/next-step.md
.codex/state.md
.codex/steps.md
.codex/last-report.md
.codex/reports/*
.codex/checkpoints/
.codex/tmp/
```

Those files contain project memory, queues, reports, checkpoints, or runtime state.

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
- `run-steps` queue grammar;
- non-git `init` cancellation;
- downstream `init` plus `doctor`;
- downstream `update` preserving project-owned state;
- invalid override rejection;
- sync-gate behavior for `resync`, normal steps, and `adopt-step`.

Publish when the package metadata, version, and license are ready:

```bash
npm publish
```

## Examples

Commands in `bash` blocks run in a terminal. Commands in `text` blocks are exact Codex Flow commands sent in a Codex chat after the project is opened.

### Example 1: Install From Zero

Run this from the project root:

```bash
npx codex-flow init
npx codex-flow doctor
git status --short
git add AGENTS.md .gitignore .codex/core .codex/context.md .codex/history.md .codex/current-step.md .codex/next-step.md .codex/steps.md .codex/last-report.md
git commit -m "chore: install codex flow"
```

- `npx codex-flow init` first verifies that the project is inside a git repository. If it is not, it asks whether to create one with `git init`; answering no exits with status `1` and does not change the project.
- After git is available, `npx codex-flow init` installs `AGENTS.md`, `.codex/core/`, bootstrap state/data files, and required runtime `.gitignore` entries.
- `npx codex-flow doctor` verifies the installed workflow files and required ignores before Codex starts using them.
- `git status --short` shows what was created. `.codex/state.md` should not appear because it is ignored runtime state.
- `git add ...` stages only versioned workflow files and project-owned memory files. It intentionally excludes `.codex/state.md`, `.codex/checkpoints/`, and `.codex/tmp/`.
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
npx codex-flow doctor
```

- `doctor` is read-only. It does not create steps, run project checks, edit files, or create commits.
- It verifies required files, core rule anchors, command-surface consistency, `run-steps` examples, required runtime ignores, and supported overrides.
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

### Example 4: Complete A Normal Codex Step

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
- `record:<id> "decision"` stores a step decision in `.codex/current-step.md`; it does not edit project code.
- `apply` performs the work, runs required checks, writes reports/history, updates `.codex/current-step.md`, creates one git commit, and updates runtime sync state.

After success:

```text
details
```

- `details` shows the latest full report copied to `.codex/last-report.md`.

### Example 5: Review A Dirty Diff Without Adopting It

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

### Example 6: Adopt Manual File Changes As A Completed Step

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
- `adopt-step "title"` requires no active step, no active `run-steps` chain, an initialized sync baseline, and a current branch/revision that still matches `.codex/state.md`.
- It runs the Stability Safety Gate and required project checks.
- On success, it writes a completed report, updates history and next-step recommendation, creates one git commit, and updates `.codex/state.md` with `Last Sync Source: adopt-step:<step-id>`.
- On check failure, it leaves the manual diff as-is and does not create completed-step metadata or a git commit.

### Example 7: Run A Queued Step Chain

Edit `.codex/steps.md` with executable items:

```md
## Add compact mode setting

Task:
Add the compact mode setting and persist it.

---

## Add compact mode tests

Task:
Cover compact mode persistence with tests.
```

Commit the queue update manually, then resync:

```bash
git add .codex/steps.md
git commit -m "chore: queue codex flow steps"
```

In Codex chat:

```text
resync
run-steps
```

- Committing `.codex/steps.md` first keeps the tree clean before `run-steps`.
- `resync` reconciles Codex Flow with the queue commit.
- `run-steps` reads `.codex/steps.md`, executes items in order, creates checkpoints, defers intermediate commits, and creates one final git commit for the whole chain.
- `run-steps` does not clear `.codex/steps.md`; after the chain succeeds, manually clear or replace the queue before running another chain.

### Example 8: Upgrade Codex Flow In A Project

Run this from the installed project root:

```bash
npx codex-flow update
npx codex-flow doctor
git diff -- AGENTS.md .codex/core
git add AGENTS.md .codex/core
git commit -m "chore: update codex flow"
```

Then in Codex chat:

```text
resync
```

- `update` replaces only package-owned workflow files: `AGENTS.md` and `.codex/core/*`.
- It does not touch `.codex/context.md`, `.codex/history.md`, `.codex/current-step.md`, `.codex/state.md`, `.codex/steps.md`, reports, checkpoints, or tmp files.
- `doctor` checks the upgraded install before it is committed.
- `resync` makes Codex Flow aware of the upgrade commit after the working tree is clean.
