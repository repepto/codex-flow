# Context

This file stores important long-lived project knowledge that is expensive to recover.

It is not project documentation, not a general stack description, and not a chronological log.

Do not store obvious facts such as "project uses Git" or "project has package.json".

## Architecture Knowledge

Store important architecture knowledge here.

## Project Constraints

Store non-obvious constraints, compatibility rules, project-specific limitations, and important boundaries here.

## Important Decisions

Store durable decisions that should influence future work here.

## Known Pitfalls

Store traps, fragile areas, surprising behavior, and previously discovered failure modes here.

## Context Maintenance Rules

Before adding a new entry, Codex must check existing entries.

If new information refines, extends, replaces, corrects, or generalizes existing knowledge, update the existing entry instead of creating a duplicate.

If unsure whether to update or create, prefer updating an existing entry.

Use stable, descriptive headings.

Do not store chat transcripts.

If an entry grows too large, around 100 lines is a review trigger, not an automatic split rule.

When an entry reaches the review trigger:

1. remove duplication;
2. merge similar ideas;
3. rewrite more compactly;
4. remove obsolete details;
5. raise the abstraction level where possible.

Do not lose important information during compaction.

Split an entry only if it still contains multiple independent logical knowledge blocks after compaction.

Never split mechanically by size or line count.
