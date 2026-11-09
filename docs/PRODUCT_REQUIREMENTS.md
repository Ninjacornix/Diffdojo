# Product Requirements

## Problem

Coding agents produce large diffs quickly. Developers often wait while the agent works, then skim the result. Three things suffer: the quality of review, the developer's understanding of *why* the code is shaped the way it is, and their grasp of the underlying concepts.

## Thesis

**Claude codes; you review by solving questions about what it wrote.** The product rewards progress with rank, unlocks and trophies (see REWARDS.md), not money or credits. Those rewards must reflect real, verified skill, so they mean something.

## Users

- **Learner:** wants to get better at the project's language and domain (for example C++, networking, concurrency) using real code.
- **Reviewer:** wants a structured way to check agent output before accepting it.

The same feature set serves both. Difficulty adapts to the person.

## User stories

| ID | Story | Acceptance criterion |
|---|---|---|
| U1 | Starts on its own | Runs in every git repository once the plugin is enabled. `/diffdojo:stop` turns it off for one repository; `autoEnable false` restores per-repo opt-in. Progress is tracked across all projects. |
| U2 | Never slow Claude | All hooks are `async` and finish in well under a second. A DiffDojo crash never affects the Claude Code session. |
| U3 | Relevant questions | Every code and design question cites a file and line range from the current session's changes. Every questionnaire question shows which detected or pinned topic selected it. |
| U4 | Answer on my schedule | Questions queue up. They can be answered, skipped or snoozed at any time, including after the session ends. |
| U5 | Trustworthy grading | Each question shows how it is graded: *verified* (execution, parsed code, reviewed pack, or Claude's cited reasoning), *model-checked* (half XP, disputable) or *feedback only* (no XP). |
| U6 | Learn from mistakes | Wrong answers show an explanation with the evidence: compiler output, test result or the seeded change. |
| U7 | Catch real bugs | A suspected bug can be turned into a failing test. If the test fails on Claude's code, a local bug report is saved. |
| U7b | Concept quizzes | Questionnaire questions match topics detected in the current work, and can also be run standalone by topic. |
| U7c | Understand Claude's design | After a change, the user can be asked about its architecture, algorithms, data structures and Claude's reasons, each answer checked against the code or Claude's own stated reasoning. |
| U8 | Track progress | `/diffdojo:stats` shows belts, XP, accuracy by topic, streak, trophies and bugs found. |
| U8b | Feel rewarded | Verified answers earn XP. Belt exams, unlocks and trophies work as described in REWARDS.md. A session recap shows what was earned. |
| U8c | Show it off | `diffdojo badge` produces an SVG and Markdown snippet with belts and trophies, marked self-reported. |
| U9 | Control my data | All data is local. One command exports or deletes it. |
| U10 | Control cost | Model-based generation can be turned off, and has an hourly limit when on. |

## Question families

Full details and grading in [QUESTIONS_AND_GRADING.md](QUESTIONS_AND_GRADING.md).

**A. Code challenges** (from the current diff)
1. **Seeded bug hunt.** DiffDojo copies a function from the diff, introduces one known bug (off-by-one, swapped condition, missing lock, use-after-move), and asks where it is. The answer is known exactly.
2. **Predict the output.** A small snippet built from the diff, with a fixed input. Graded by actually compiling and running it.
3. **Write a test.** Write a test that passes on Claude's code and fails on a seeded mutant. Graded by running the test against both.
4. **Real bug report.** Not generated: the user flags something in Claude's diff and proves it with a failing test.

**B. Questionnaire** (concept quizzes on the topics you're working in)
5. Multiple choice, true/false, short answer and ordering questions from curated packs (for example epoll, C++ memory model, TCP), chosen by a topic detector that reads the diff and the project.

**C. Design and reasoning** (about Claude's changes)
6. **Architecture:** which modules changed, which component now owns a responsibility, what the new call path is.
7. **Why Claude did it:** the reason behind a change, checked against what Claude actually said in the session.
8. **Algorithms and data structures:** which one Claude used, its complexity, and why it fits or when an alternative would be better.
9. **Tradeoffs and critique:** do you agree with the choice, and what would you do differently? Model feedback only.

## UX requirements

- Primary UI: inside Claude Code — the current question in a band above the prompt while Claude works, a `/dojo` pane, a status-line count and a toast for new questions (never in Claude's conversation).
- Also: a CLI (`diffdojo quiz`) and a local web page on `127.0.0.1` (`diffdojo serve`).
- Each question shows family, topic, difficulty, estimated time, grading type and, where relevant, the code location.
- Quiet mode, a per-session question cap and snooze are available.
- Nothing is ever injected into Claude's conversation: the in-app UI draws in the interface only.

## Metrics (local, for the user and for the project's own evaluation)

- Questions generated, answered, skipped.
- Accuracy on verified questions by topic.
- Time to answer.
- Real bugs confirmed by failing tests.
- Generation failures and invalid questions reported by the user.

## Success criteria

- **S1:** The plugin runs through a full day of normal Claude Code use without slowing it down or erroring.
- **S2:** At least 80% of generated questions are judged relevant and correct by the user (tracked with a "bad question" button).
- **S3:** The author keeps using it for two weeks with no external incentive.
- **S4:** At least one real bug in agent-written code is caught and confirmed by a failing test.
