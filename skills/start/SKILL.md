---
name: start
description: Enable DiffDojo for the current git repository so it generates review questions about Claude's changes in the background. Use when the user runs /diffdojo:start or asks to turn DiffDojo on.
argument-hint: "[test command]"
allowed-tools: Bash(node:*), Read, Glob
---

Enable DiffDojo for this repository.

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
   - DiffDojo is now on for this repo only; everything stays on their machine.
   - Questions appear after each of your turns; answer them in a second terminal with `node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo" quiz` (or `diffdojo quiz` if it is on their PATH), or in the browser with `... serve`.
   - The optional model path is off by default.

Do not start a quiz yourself and do not answer questions for the user.
