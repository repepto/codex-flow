# History

This file is Codex working memory for completed steps.

It is not a human-friendly changelog and not a full report archive.

Full reports live in `.codex/reports/<id>.md`.

Each completed Codex step must use this structure:

```md
## Step <id>

Title:
<short title used by ls-steps>

Sync:
<git commit hash/message, or deferred to run-steps finalization>

Summary:
<what the step achieved>

Important Knowledge:
<knowledge useful for future Codex sessions>

Report:
reports/<id>.md
```

External sync events discovered by `resync` are not completed Codex steps. They must not use `## Step <id>` entries and must not affect step id calculation.
