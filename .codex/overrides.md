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

Overrides are allowed for rule/config files such as:

```text
commands.md
commit-rules.md
after-step.md
step-report-rules.md
```

`commit-rules.md` defines base git sync behavior and optional git commit creation; the filename is kept for compatibility with the base workflow files.

Overrides are not intended for state/data files such as:

```text
context.md
history.md
current-step.md
next-step.md
state.md
steps.md
last-report.md
reports/*
```

## Merge Behavior

If `.codex/overrides/<file>.md` exists, Codex must apply it together with `.codex/<file>.md`.

If no override file exists for a base rule/config file, Codex must use the base file as-is.

If the first non-empty line of the override file is:

```text
#replace
```

then the override replaces the base file.

If `#replace` is absent:

- apply the base file first;
- apply the override second;
- if rules conflict, the override wins.

## Mandatory System Actions

Overrides must not disable mandatory system actions that preserve consistency.

In particular, `.codex/overrides/after-step.md` must not disable mandatory after-step system actions.
