# Questions and Grading

DiffDojo asks three families of questions:

- **A. Code challenges:** built from the code Claude just changed (seeded bugs, predict the output, write a test).
- **B. Questionnaire:** concept quizzes on the topics you're working in (multiple choice, true/false, short answer). For example, edge-triggered epoll, C++ move semantics, TCP, memory ordering, SQL isolation levels.
- **C. Design and reasoning:** questions about Claude's changes: architecture, why Claude made them, which algorithms and data structures it used, and why.

All three earn XP and count toward belts.

## Principle

Full XP only comes from answers that are **known to be correct before you answer**: because the answer was produced by running code, read directly from the code's structure, or reviewed by a human (curated packs). Questions whose answer depends on a model's judgment are allowed, but they earn less and can't decide a belt.

## A. Code challenges

| Type | Built from | Ground truth | XP |
|---|---|---|---|
| Seeded bug hunt | A function from the diff with one injected mutation | The known mutation | 10 / 20 / 30 by difficulty |
| Predict the output | A small runnable snippet derived from the diff | Recorded output from actually running it | 10 / 20 |
| Write a killing test | A function from the diff plus a hidden mutant | Test passes on original and fails on mutant | 30 |
| Warning explanation | A compiler or linter warning in the diff | The tool's own diagnostic | 5 |
| Explain a decision | Any part of the diff | None (model feedback only) | 0 |
| Real bug report | User-flagged code in Claude's diff | A failing test the user writes | 50 |

### Example: seeded bug hunt (C++)

Original from Claude's diff:
```cpp
while (true) {
    ssize_t n = recv(fd, buf, sizeof buf, 0);
    if (n > 0) { consume(buf, n); continue; }
    if (n == 0) { close_conn(fd); break; }
    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
    handle_error(fd); break;
}
```
DiffDojo removes the `continue` (the socket is no longer drained under edge-triggered epoll) and asks: *"One line was changed in this copy of `on_readable()`. Which line, and what goes wrong at runtime?"* The line choice is graded automatically. The "what goes wrong" text gets model feedback only.

## B. Questionnaire

### Formats
- Multiple choice (single or multiple correct answers)
- True / false with a required one-line reason (reason gets feedback only)
- Short exact answer (a number, a keyword, a complexity like `O(n log n)`)
- Ordering (put these steps of the TCP handshake in order)

### How topics are chosen
A **topic detector** maps what you're working on to question topics, using only local signals:
- Languages and file types in the session's changed files.
- APIs and includes in the diff (`epoll_wait`, `std::atomic`, `asyncio`, `pthread_mutex_lock`, `SELECT ... FOR UPDATE`).
- The project's build files and dependencies (CMakeLists, package.json, requirements.txt).
- Topics the user pins manually with `/diffdojo:topics` (for example, "always include C++ and networking").

So when Claude is writing async socket code, the questionnaire leans toward epoll, non-blocking I/O and TCP. Questionnaire mode also works with no Claude session at all: `diffdojo quiz --topic cpp-concurrency`.

### Where questions come from

| Source | How it's checked | XP | Counts for belt exams |
|---|---|---|---|
| **Curated packs** (shipped and community packs) | Human-reviewed in pull requests; snippet-based questions are compiled and run in the packs' CI | Full (5 / 10 / 15 by difficulty) | Yes |
| **Project questions** from the model path, about your codebase ("Which module owns connection retries?") | Answer must be backed by a cited file and line; validator checks that the citation exists and contains the cited symbol | Half | No |
| **Model-generated concept questions** (optional) | Generated, then answered blind by a separate model call; kept only if both agree; "dispute" button removes it | Half | No |

### Packs
Packs are plain YAML files in `packs/<topic>/`, open source and versioned with the plugin. Example:

```yaml
id: net-epoll-007
topic: networking/epoll
difficulty: medium
format: multiple_choice
question: >
  With edge-triggered epoll, why can a connection stall if the
  socket isn't fully drained after a readiness event?
choices:
  a: The kernel closes the TCP connection automatically
  b: No new readiness event may arrive for data that is already buffered
  c: The socket switches back to blocking mode
  d: TCP retransmissions are disabled
answer: b
explanation: >
  Edge-triggered mode reports transitions, not state. If unread data
  remains, no new edge occurs until more data arrives, so the reader
  can wait forever. Read until EAGAIN.
references:
  - man 7 epoll
```

Starter packs for the MVP: C++ core, C++ concurrency, Linux networking, Python, data structures and algorithms. Target: about 150 questions each.

Pack CI checks: schema validation, one unambiguous correct answer, no duplicate questions, and compiling and running any code snippet so "what does this print" answers are machine-verified.

## C. Design and reasoning

These questions are about *understanding* Claude's change, not hunting bugs in it. They're generated after each Claude turn from three local sources:

1. **The diff and the codebase structure**, parsed with tree-sitter (functions, types, includes/imports, call sites, containers used).
2. **Claude's own stated reasoning** for that turn, read locally from the session transcript (the hook input gives its path): Claude's explanation messages, its plan or todo list, and commit messages it wrote.
3. **Your project's existing architecture**: directory layout, module boundaries, build targets.

### Question types

| Type | Example | Ground truth | XP | Belt exam |
|---|---|---|---|---|
| Architecture: what changed | "Which module now owns reconnect logic?" / "Order the new call path from `accept()` to `on_message()`." | Code structure (tree-sitter call graph, file ownership) | 10 / 20 | Yes |
| Data structure used | "What container does Claude use for the pending-request table?" | Read from the declared type in the code | 5 / 10 | Yes |
| Algorithm used | "Which algorithm does `schedule_retries()` implement?" (exponential backoff with jitter / fixed interval / token bucket / ...) | Model label, confirmed by a blind second call | Half (5 / 10) | No |
| Complexity | "What's the time complexity of the new `lookup()` per call?" | Model answer + blind check; for simple cases, an empirical scaling run | Half (5 / 10) | No |
| Why Claude did it | "Why did Claude switch the socket to non-blocking mode?" (multiple choice) | **Claude's stated reason in the transcript.** The correct option paraphrases it and cites the message. If Claude didn't state a reason, the question isn't generated. | 10 | No |
| Why this choice fits | "Why is `unordered_map` a reasonable choice here, and when would `std::map` be better?" | None: model feedback | 0 | No |
| Critique | "Do you agree with Claude's design? What would you change?" | None: model feedback; your answer is saved as a note | 0 | No |

### Notes on grading
- **Structural facts are verified.** "What container is used" or "what calls what" is read from the parsed code, so it's as trustworthy as a compiler check and gets full XP.
- **"Why" questions test whether you understood Claude's reasoning, not whether Claude was right.** The answer key is what Claude said, cited by message, so it's checkable. A separate "Do you agree?" follow-up gives room to disagree.
- **Algorithm and complexity labels need a model**, so they're half XP, have a dispute button, and stay out of belt exams. Disputed questions are removed.
- **Open "why it fits" and critique answers get feedback only.** Good critiques can be turned into a real bug report or a suggestion you paste back to Claude yourself.

### Example
After Claude adds a retry queue:
```
[Design · Data structure · verified]
pending_ is declared in src/net/retry_queue.hpp:41. What is it?
 a) std::vector<Request> sorted by deadline
 b) std::priority_queue<Request, std::vector<Request>, ByDeadline>
 c) std::map<Deadline, Request>
 d) std::deque<Request>

[Design · Why Claude did it · from session]
Why did Claude add jitter to the retry delay?
 a) To keep retry order deterministic for tests
 b) To stop many clients retrying at the same moment after an outage   <- Claude, turn 4
 c) Because the OS timer needs a minimum resolution
 d) To reduce memory use of the queue
```

### Requirements
- Family C's structural questions work offline. "Why", algorithm and complexity questions need the model path.
- Only the extracted rationale (a few sentences) is stored, never the whole transcript.

## Difficulty

- **Code challenges:** easy = single-line mutation in short straight-line code; medium = inside a loop, branch or error path; hard = concurrency, lifetimes, resource handling or input-dependent bugs.
- **Questionnaire:** set per question in the pack and adjusted from real answer statistics over time.

Difficulty adapts per topic: two correct answers in a row raise it, two wrong answers lower it.

## Mixing the families

- After each Claude turn, the queue starts with **design and reasoning** and **code challenges** about that change, because those double as review.
- When there's no new diff, or you've answered everything, it fills with **questionnaire** questions on the detected topics.
- Default mix is about 40% code challenges / 30% design and reasoning / 30% questionnaire. Configurable, including single-family modes.

## Real bug reports

1. The user runs `/diffdojo:report-bug` and points at code Claude wrote.
2. DiffDojo helps scaffold a test in the project's test framework.
3. DiffDojo runs it. If the test **fails** on the current code, the report is confirmed and saved to `~/.diffdojo/<repo-id>/bugs/<date>-<slug>.md` with the diff excerpt, test and output.
4. What happens next is up to the user: fix it, ask Claude to fix it, or open an issue. DiffDojo never sends anything anywhere.

## XP, rank and stats

- XP, belts, unlocks and trophies are described in [REWARDS.md](REWARDS.md).
- Stats: accuracy per topic, family and question type, current streak (days with at least one counted answer), bugs confirmed.
- Skipping costs nothing. Questions marked "bad" are excluded from accuracy and used to fix packs or tune the generator.

## Keeping it honest

- Explanations are shown only after answering.
- A pack question isn't repeated until you've seen the rest of its topic, except in review mode, which repeats missed questions for reduced XP.
- If a generated question can't be validated, it's discarded rather than shown with a guessed answer.
