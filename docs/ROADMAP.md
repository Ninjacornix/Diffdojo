# Roadmap

All phases can be completed by one developer with no outside approval.

## Phase 0 — Confirm integration (about 2 days)

- [x] Pin a Claude Code version (2.1.319) and load an empty plugin with `claude --plugin-dir ./diffdojo`.
- [x] Log raw stdin for `SessionStart`, `PostToolUse` (Edit / Write / MultiEdit) and `Stop`. Confirm field names and the matcher tool names.
- [x] Confirm `async: true` hooks don't delay Claude's turn (time a session with and without the plugin).
- [x] Inspect the transcript file format at `transcript_path` and confirm Claude's per-turn explanation text can be extracted reliably.
- [x] Confirm `claude -p` works from inside a hook with the `DIFFDOJO_CHILD` guard and causes no recursion.
- [ ] Test on Linux and macOS. (Tested on Windows.)

**Exit:** hooks record edits for an enabled repo with no visible effect on Claude Code.

## Phase 1 — Offline MVP (about 2–3 weeks)

- [x] `/diffdojo:start`, `/diffdojo:stop`, `/diffdojo:stats` skills.
- [x] Event recorder, session snapshot, diff collector with deny globs and size cap.
- [x] Mutation library for C/C++ and Python (8–10 operators each).
- [x] Seeded bug hunt and warning-explanation questions from templates only.
- [x] Questionnaire: pack schema, topic detector, two starter packs (C++ core, Linux networking), pack CI.
- [x] Design questions, offline part: structure analyzer (dependency-free heuristic parser instead of tree-sitter); data-structure and architecture questions.
- [x] Validator that drops mutants that change nothing.
- [x] SQLite store, `diffdojo quiz` CLI, XP and stats.
- [x] Belts up to Orange with belt exams, streaks, session recap, first trophies.
- [x] `diffdojo export` and `diffdojo purge`.

**Exit:** a full day of real use produces relevant, correctly graded questions with zero network access.

## Phase 2 — Richer questions (about 2–3 weeks)

- [x] "Predict the output" questions with compile-and-run validation.
- [x] "Write a killing test" questions using the project's configured test command.
- [x] `/diffdojo:report-bug` with failing-test confirmation and local reports.
- [x] Optional model path (`claude -p` or API key) for question wording and explanations, with an hourly limit.
- [x] Rationale extractor (version-pinned transcript parser) and "why Claude did it" questions.
- [x] Algorithm and complexity questions with blind model check and dispute button.
- [x] Remaining starter packs (C++ concurrency, Python, data structures and algorithms) — plus JavaScript/TypeScript. Packs are below the 150-question target.
- [x] Adaptive difficulty per topic.
- [x] All belts, unlocks (boss fights, audit mode), full trophy set.
- [x] `diffdojo badge` SVG and Markdown generator.
- [x] Local web UI (`diffdojo serve`).

**Exit:** success criteria S1–S4 in the PRD are met.

## Phase 3 — Polish and release

- [x] TypeScript/JavaScript mutation operators.
- [x] Review mode (revisit missed questions).
- [ ] Docs, demo GIF, example repo.
- [ ] Publish on GitHub and a public plugin marketplace listing.
- [ ] Optional sandboxing improvements (container runner).

## Initial backlog

| Priority | Item | Done when |
|---|---|---|
| P0 | Hook scripts with early exit and opt-in check | Unit tests; measured overhead under 100 ms |
| P0 | Diff collector | Correct diff across commits and uncommitted changes; deny globs tested |
| P0 | C++ mutation operators | Each operator has fixtures and a behavior-change check |
| P0 | Quiz CLI | Answer, skip, snooze, bad-question flag all work |
| P0 | Pack schema + loader | Invalid packs rejected with clear errors; 100+ questions in first pack |
| P1 | Structure analyzer | Correct types and call edges on C++ and Python fixtures |
| P1 | SQLite store and stats | Stats match a hand-computed fixture |
| P1 | Predict-output validator | Non-deterministic snippets are rejected |
| P1 | Killing-test grader | Correctly classifies pass/fail on original and mutant |
| P2 | Rationale extractor | Parses pinned transcript version; fails safe on unknown formats |
| P2 | Model path | Off by default, rate-limited, schema-validated output |
| P2 | Web UI | Localhost only, token-protected |

## Not planned

- Rewards with monetary value, credits or tokens.
- Any upload, backend, accounts or shared leaderboards.
- Automatic sharing of bug reports.
