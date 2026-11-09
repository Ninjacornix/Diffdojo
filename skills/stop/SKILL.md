---
name: stop
description: Disable DiffDojo for the current git repository. Use when the user runs /diffdojo:stop or asks to turn DiffDojo off here.
allowed-tools: Bash(node:*)
---

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo" disable
```
(If `${CLAUDE_PLUGIN_ROOT}` was not substituted, use the path in `~/.diffdojo/plugin-root.txt`.)

Then tell the user DiffDojo is off for this repository, that their progress is kept, and that `diffdojo purge --repo --yes` deletes this repo's data if they want.
