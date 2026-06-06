# Bootstrap

## Purpose

This file defines how an installed project creates its project-owned `.codex/` state/data files and project-scoped Codex runtime config on first startup.

The starter pack repository must ship core files only:

```text
AGENTS.md
.codex/core/
```

Project-owned state/data files and project-owned `.codex/config.toml` must not be shipped in the starter pack root `.codex/` directory.

## Bootstrap Rule

On startup in an installed downstream project, after reading `AGENTS.md` and `.codex/core/` rule/config files, Codex must ensure required project-owned state/data files and `.codex/config.toml` exist in the root `.codex/` directory next to `.codex/core/`.

Bootstrap is allowed to create missing project-owned state/data files, runtime config, and directories listed in this file. Bootstrap must not overwrite, truncate, reset, or reinterpret existing project-owned files.

Bootstrap is not a normal step, does not create an active step, does not apply project code changes, does not run checks, and does not create commits.

If bootstrap creates versioned project-owned files, Codex must report the created paths and wait for the user to review and commit them before normal steps can start. `resync` may initialize the sync baseline only after the git working tree is clean and unambiguous.

## Required Project-Owned Files

Create `.codex/context.md` if missing:

```md
# Context

## Architecture Knowledge

## Project Constraints

## Important Decisions

## Known Pitfalls
```

Create `.codex/config.toml` if missing:

```toml
# Project-local Codex defaults.
# Codex loads this file only after the project is trusted.

# Do not pause for approval prompts during normal project work.
approval_policy = "never"

# Keep filesystem access scoped to the project workspace by default.
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
# Allow package managers, test tools, and documentation fetches to use the network
# inside the workspace sandbox without asking for approval.
network_access = true
```

Create `.codex/history.md` if missing:

```md
# History

No completed steps.
```

Create `.codex/current-step.md` if missing:

```md
# Current Step

No active step.

Last completed step: none
```

Create `.codex/next-step.md` if missing:

```md
# Next Step

## Recommended Step

No recommendation yet.
```

Create `.codex/last-report.md` if missing:

```md
# Last Report

No reports available.
```

Create `.codex/reports/` if missing.

Bootstrap must not create `.codex/goal.md`. That file is created or replaced only by the `goal:<description>` workflow command when the project has a real long-term objective to record.

Create `.codex/state.md` if missing:

```md
# Codex State

Sync Backend: git
Last Known Revision: none
Last Known Branch: none
Last Sync Source: none
Strict Mode: true
Discussion Mode: none
```

Creating `.codex/state.md` during bootstrap does not initialize sync. The sync baseline remains uninitialized until a later successful `resync`.

## Files Not Created By Bootstrap

Bootstrap must not create completed step reports, tmp files, or project override files.

These paths are created only by their owning workflow actions or by the user:

```text
.codex/goal.md
.codex/reports/<numeric-id>.md
.codex/tmp/
.codex/overrides/
```
