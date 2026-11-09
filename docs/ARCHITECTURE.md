# Architecture and Claude Code Integration

## Overview

```text
Claude Code session
  |  async command hooks (SessionStart, PostToolUse on Edit|Write, Stop)
  v
Event recorder ----> ~/.diffdojo/<repo-id>/events.jsonl   (file paths + timestamps only)
  |
  |  on Stop (async, background)
  v
Collectors
  |-- Diff collector       git diff from the session's base snapshot, allow/deny globs
  |-- Structure analyzer   tree-sitter: functions, types, containers, call graph
  |-- Rationale extractor  Claude's stated reasons for this turn, from the local transcript
  |-- Topic detector       languages, APIs, includes, build files, pinned topics
  v
Question generator
  |-- A. code challenges   mutation library + static analysis       (offline)
  |-- B. questionnaire     curated YAML packs by topic              (offline)
  |-- C. design/reasoning  structural facts (offline); "why", algorithm,
  |                        complexity via the optional model path
  v
Validator  (compiles snippets, checks mutants, checks citations, blind model check)
  |
  v
SQLite store  ~/.diffdojo/diffdojo.db
  |
  v
Quiz UI:  `diffdojo quiz` CLI  (phase 1)  /  local web page on 127.0.0.1  (phase 2)
  |
  v
Grader  (run code, run tests, compare with known answers; model feedback for open questions)
  |
  v
Rewards engine  (XP, belts, exams, unlocks, trophies, badge)
```

There is no network service. The only outbound traffic is the optional model call, made with the user's own credentials.

## Plugin package

```text
diffdojo/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   └── hooks.json
├── skills/
│   ├── start/SKILL.md        # /diffdojo:start  enable for this repo
│   ├── stop/SKILL.md         # /diffdojo:stop   disable for this repo
│   ├── stats/SKILL.md        # /diffdojo:stats  show progress
│   └── report-bug/SKILL.md   # /diffdojo:report-bug  help write a failing test
├── packs/                    # curated questionnaire packs (YAML), one folder per topic
├── scripts/
│   ├── on-session-start.js
│   ├── on-edit.js
│   └── on-stop.js
├── src/                      # generator, validator, grader, store, CLI
├── bin/diffdojo               # quiz CLI entry point
└── README.md
```

Only `plugin.json` goes inside `.claude-plugin/`. Everything else is at the plugin root.

### plugin.json

```json
{
  "name": "diffdojo",
  "version": "0.1.0",
  "description": "Code challenges, concept quizzes and design questions about what Claude just wrote. Local only.",
  "license": "MIT"
}
```

The `name` field sets the skill namespace, so skills are invoked as `/diffdojo:start`, `/diffdojo:stats` and so on.

### hooks/hooks.json

```json
{
  "description": "DiffDojo session observers (non-blocking)",
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/on-session-start.js\"",
        "async": true, "timeout": 10 } ] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [ { "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/on-edit.js\"",
        "async": true, "timeout": 10 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.js\"",
        "async": true, "timeout": 300 } ] }
    ]
  }
}
```

Notes:
- `async: true` runs the hook in the background so Claude's turn doesn't wait. Async hook output is ignored, which suits DiffDojo: it never talks to Claude.
- Every script reads the hook's JSON input from stdin and **exits immediately with code 0** if the current repository hasn't been enabled.
- Scripts never exit with code 2, which is the code that blocks or feeds back to Claude.
- Hook configuration loads at session start, so changes need a new session.
- Verify the exact matcher tool names and the payload fields against the pinned Claude Code version (Roadmap phase 0).

## Components

### Event recorder (`on-edit.js`)
- Reads `tool_name`, the file path from `tool_input`, and `cwd`.
- Appends `{ts, path}` to `events.jsonl`. It does not store file contents or tool output.
- Ignores paths that match deny globs.

### Session snapshot (`on-session-start.js`)
- Records the current `HEAD` and a `git stash create` snapshot ID, if there are uncommitted changes, as the session's diff base.
- Non-git directories aren't supported in the MVP. The hook just exits.

### Diff collector (inside `on-stop.js`)
- Computes `git diff <base>` limited to the files in `events.jsonl` since the last Stop.
- Drops binary files, generated files, lockfiles and anything over the size cap (default 400 changed lines per question batch).

### Structure analyzer
- Parses changed files with tree-sitter (C, C++, Python, TypeScript grammars first).
- Extracts declared types of new or changed members, container types, function signatures, includes/imports and a call graph limited to the changed functions and their direct callers and callees.
- Produces facts used as verified answers for architecture and data-structure questions.

### Rationale extractor
- Reads the transcript file whose path the Stop hook receives (`transcript_path`), locally, and only for the turn that just ended.
- Pulls Claude's explanation text, plan or todo items and any commit messages Claude wrote, linked to the files they mention.
- Stores at most a few sentences per change, with a reference to the turn. The transcript itself is never copied or sent anywhere except, when the model path is on, the extracted sentences.
- The transcript format isn't a stable public API, so the parser is version-pinned and fails safe: if it can't parse, "why" questions are skipped.

### Topic detector
- Maps file types, APIs and includes in the diff (for example `epoll_wait`, `std::atomic`, `asyncio`), build files and user-pinned topics to pack topics.
- Keeps a per-repo topic profile that decays over time, so quizzes follow what you're currently working on.

### Questionnaire packs
- YAML files in `packs/<topic>/`, validated against a JSON schema at load time.
- Shipped with the plugin. Users can add local packs in `~/.diffdojo/packs/`.
- Pack CI (in the DiffDojo repo) runs schema checks, duplicate detection and compiles and runs any code snippets.

### Question generator
- **Template path (always available, free):**
  - Seeded mutations using a small mutation library for each supported language (C/C++, Python, TypeScript first): flip comparisons, off-by-one in loop bounds, remove a lock guard, swap arguments, drop an `await`, change `std::move` usage.
  - Static-analysis prompts from tools already in the project (compiler warnings, clang-tidy, eslint, ruff): "this line triggers warning X — why?"
  - Questionnaire questions picked from packs by detected topic and adaptive difficulty.
  - Structural design questions from the structure analyzer ("what container is `pending_`?", "order this call path").
- **Model path (optional, user-enabled):**
  - Calls `claude -p` (headless mode on the user's own plan) or a provider API with the user's own key.
  - The model writes question text and explanations, "why Claude did it" questions from extracted rationale, and algorithm and complexity questions.
  - **Answers to verified questions always come from execution, parsed code or reviewed packs, not from the model.**
  - Model-answered questions go through a blind check: a second call answers without seeing the key, and the question is kept only if both agree.
  - Recursion guard: the child process runs with `DIFFDOJO_CHILD=1`, and every hook script exits immediately when it sees that variable.
  - Limits: default of 6 model generations per hour, configurable or off.

### Validator
- Compiles and runs each "predict the output" snippet in a temporary directory before showing it. If it doesn't compile or run deterministically, it is dropped.
- Confirms each seeded mutant actually changes behavior, by running the project's tests or a generated input. Mutants that change nothing are dropped.
- Never runs snippets from the user's repo that need network access, credentials or project build steps beyond a configured test command.

### Grader
- **Seeded bug:** compares the user's line or region choice to the known mutation.
- **Predict output:** string compare with the recorded output, with whitespace normalized.
- **Write a test:** runs the user's test against the original code (must pass) and the mutant (must fail), using the project's configured test command.
- **Explain:** optional model feedback, labeled "feedback only", worth 0 XP.

### Store
SQLite at `~/.diffdojo/diffdojo.db`, outside the repository so it is never committed. Tables: `repos`, `sessions`, `questions`, `answers`, `bug_reports`, `settings`, plus reward tables `xp_events`, `belts`, `exams`, `trophies` (see REWARDS.md).

### Quiz UI
- **Phase 1:** `diffdojo quiz` CLI. Shows the question, code excerpt with line numbers and choices; accepts an answer, `s` (skip), `z` (snooze) or `b` (bad question).
- **Phase 2:** `diffdojo serve` starts a page on `127.0.0.1` with a random port and a one-time token in the URL.

## Stack

- Node.js 20+ for hooks, the CLI and the generator (one runtime, fast startup).
- `better-sqlite3` for storage.
- Language toolchains already on the user's machine (g++/clang++, python, node) for validation.
- No server, no accounts.

## Operational rules

- Hooks must start, append and exit in under ~100 ms on a normal laptop.
- Long work happens only in the async Stop hook, within its timeout. Unfinished work is resumed by the next Stop.
- A lock file prevents two generators from running for the same repo at once.
- Every failure is logged to `~/.diffdojo/logs/` and otherwise ignored.
