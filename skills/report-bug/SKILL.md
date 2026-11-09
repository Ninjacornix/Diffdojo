---
name: report-bug
description: Help the user prove a real bug in code Claude wrote with a failing test, and save a confirmed local bug report in DiffDojo. Use when the user runs /diffdojo:report-bug or says they found a bug in Claude's change and want to record it.
argument-hint: "<file[:lines]> <what is wrong>"
allowed-tools: Bash(node:*), Read, Glob, Grep, Write, Edit
---

The user believes code you (Claude) wrote has a real defect. Your job is to help them **prove it with a failing test**, not to fix it.

DiffDojo CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo"` (if `${CLAUDE_PLUGIN_ROOT}` was not substituted, use the path in `~/.diffdojo/plugin-root.txt`).

Steps:
1. From `$ARGUMENTS` and the conversation, identify the file, line range and the claimed misbehaviour. Ask if anything is unclear.
2. Get a test skeleton in the project's framework:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo" report-bug --scaffold --file <file> --function <name> --title "<short title>"
   ```
3. Write the test with the user: it must exercise the claimed bug and assert the **correct** behaviour, so it fails on the current code. Do not change the code under test. Put the test where the project keeps tests.
4. Make sure a test command is configured (`... config get testCommand`); if not, suggest one and pass it with `--cmd`.
5. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/diffdojo" report-bug --title "<short title>" --file <file> --lines <a-b> --test <test file>
   ```
   Add `--critique <question id>` if the bug came from a DiffDojo critique answer.
6. Report the result plainly:
   - **Confirmed** (test fails on the current code): give the report path. Next steps are the user's choice: fix it, ask you to fix it, or open an issue.
   - **Not confirmed** (test passes): say so. Either the test doesn't reach the bug or the code is correct. Don't fudge the test to make it fail.

Never send the report anywhere.
