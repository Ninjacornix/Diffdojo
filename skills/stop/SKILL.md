---
name: stop
description: Turn DiffDojo off for the current git repository only (it stays on everywhere else). Use when the user runs /diffdojo:stop or asks to turn DiffDojo off here.
allowed-tools: Bash(node:*)
---

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo" disable
```
(If `${CLAUDE_PLUGIN_ROOT}` was not substituted, use the path in `~/.diffdojo/plugin-root.txt`.)

Then tell the user DiffDojo is off for this repository only, that their progress is kept, that `/diffdojo:start` turns it back on, and that `diffdojo config set autoEnable false --global` makes DiffDojo opt-in per repository everywhere.
