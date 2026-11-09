---
name: stats
description: Show the user's DiffDojo progress — belts, XP, accuracy by topic, streak, trophies and real bugs caught. Use when the user runs /diffdojo:stats or asks about their DiffDojo progress.
allowed-tools: Bash(node:*)
---

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo" stats --no-color
```
(If `${CLAUDE_PLUGIN_ROOT}` was not substituted, use the path in `~/.diffdojo/plugin-root.txt`.)

Show the output to the user as-is, in a code block. If a belt exam is available, mention `diffdojo exam <track>`. Do not add commentary on their performance beyond one short line.
