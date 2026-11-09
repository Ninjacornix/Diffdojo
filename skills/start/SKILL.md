---
name: start
description: Turn DiffDojo (back) on for the current git repository and optionally set its test command. DiffDojo already runs in every repo by default; this undoes /diffdojo:stop. Use when the user runs /diffdojo:start or asks to turn DiffDojo on.
argument-hint: "[test command]"
allowed-tools: Bash(node:*), Read, Glob
---

DiffDojo runs in every git repository automatically once the plugin is enabled. This command turns it back on here if `/diffdojo:stop` turned it off, and records the snapshot it diffs against.

1. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo" enable
   ```
   If `$ARGUMENTS` is non-empty, it is the project's test command: add `--test-cmd "$ARGUMENTS"` to that command.
   If `${CLAUDE_PLUGIN_ROOT}` was not substituted, use the path stored in `~/.diffdojo/plugin-root.txt` instead.

2. If the output says no test command is configured, look at the project (package.json `scripts.test`, pytest config, CMake/ctest, Makefile `test` target) and **suggest** the one command that runs the test suite. Only set it if the user agrees:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo" config set testCommand "<command>"
   ```
   The test command is the only project command DiffDojo ever runs, always in a temporary copy of the repository. It unlocks "write a killing test" questions, test-validated mutants and real bug reports.

3. Tell the user, briefly:
   - DiffDojo is on here (and in every other repo unless they stop it there); everything stays on their machine.
   - Questions appear in a box above the prompt while you work: press 1-4 for multiple choice, ctrl+x tab to type an answer; `/dojo` opens the full pane.
   - The optional model path is off by default.

Do not start a quiz yourself and do not answer questions for the user.
