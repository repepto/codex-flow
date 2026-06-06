# Overrides

## Purpose

Project-specific behavior may override or extend base rule/config files.

Overrides may live in:

```text
.codex/overrides/
```

The directory is optional. If it does not exist, Codex must continue with the base rule/config files.

An empty `.codex/overrides/` directory is valid but not required.

## Supported Files

Only these base rule/config files support overrides by default:

```text
commands.md
commit-rules.md
after-step.md
step-report-rules.md
```

`commit-rules.md` defines base git sync behavior and required git commit creation; the filename is kept for compatibility with the base workflow files. Overrides may extend commit behavior only when they preserve the required git backend, required commit creation, no-empty-completion stop behavior, and required versioned metadata commit scope.

Overrides are invalid for state/data files such as:

```text
context.md
goal.md
history.md
current-step.md
next-step.md
state.md
last-report.md
reports/*
```

If `.codex/overrides/` contains an override for a state/data file, Codex must treat that override as invalid, stop, explain the issue, and require manual correction before continuing.

If `.codex/overrides/` contains a file that does not correspond to a supported base rule/config file, Codex must treat that override as invalid, stop, explain the issue, and require manual correction before continuing.

## Merge Behavior

If `.codex/overrides/<file>.md` exists, Codex must apply it together with `.codex/core/<file>.md`.

If no override file exists for a base rule/config file, Codex must use the base file as-is.

Overrides are additive by default:

- apply the base file first;
- apply the override second;
- project-specific additions in the override extend the base rules.

Full-file replacement is not supported. If an override contains `#replace`, Codex must treat the override as invalid, stop, explain the issue, and require manual correction before continuing.

If an override conflicts with a base rule, the override may win only when it explicitly names the base file and section or rule it is overriding.

If a conflict is ambiguous, Codex must stop and require manual resolution instead of guessing.

## Mandatory System Actions

Overrides must not disable or weaken mandatory system actions that preserve consistency.

Mandatory system actions include:

- exact command matching;
- stability safety gate;
- sync gate checks;
- required git sync backend;
- uninitialized sync baseline handling;
- `adopt-step` sync, safety, verification, metadata, and commit requirements;
- `resync` requirements;
- clean-tree requirement before `resync` initializes or advances the sync baseline;
- pre-existing-change stop behavior;
- `Strict Mode` defaulting and preservation in `.codex/state.md`;
- `Discussion Mode` defaulting, preservation, read-only behavior, and step/execution blocking in `.codex/state.md`;
- exactly one git commit for each completed normal step;
- versioned completed-step metadata inclusion in required commit scope;
- no-empty-completion stop behavior after excluding transient runtime state;
- after-step integrity checks;
- pre-finalization recovery snapshots and required commit failure recovery;
- completed report/history/current-step finalization;
- transient runtime state exclusions;
- destructive git restrictions;
- mandatory wait-state reporting.

In particular, `.codex/overrides/after-step.md` must not disable mandatory after-step system actions.
