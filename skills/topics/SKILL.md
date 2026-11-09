---
name: topics
description: Show or pin DiffDojo questionnaire topics (e.g. always include C++ concurrency and networking). Use when the user runs /diffdojo:topics or wants to change which concept-quiz topics DiffDojo asks about.
argument-hint: "[pin|unpin <topic>]"
allowed-tools: Bash(node:*)
---

DiffDojo CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo"` (if `${CLAUDE_PLUGIN_ROOT}` was not substituted, use the path in `~/.diffdojo/plugin-root.txt`).

- No arguments: run `... topics list` and show the detected topics and the available quiz topics.
- `pin <topic>` / `unpin <topic>`: run `... topics pin <topic>` (or `unpin`) with the user's topic, e.g. `cpp/concurrency`, `networking`, `python`, `dsa`. Then show the updated list.

Mention that `diffdojo quiz --topic <topic>` runs a standalone quiz on any topic, no Claude session needed.
