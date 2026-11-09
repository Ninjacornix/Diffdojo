# Rewards

DiffDojo has no money, credits or tokens. That doesn't mean there's nothing to earn. The reward system is built on things a local tool can actually deliver: rank, unlocks, trophies and a badge you can show off.

## Design rules

1. **Only trustworthy answers count.** Full XP comes from code challenges graded by execution and from curated questionnaire packs reviewed by humans (see [QUESTIONS_AND_GRADING.md](QUESTIONS_AND_GRADING.md)). Model-generated questions give half XP and never count for belt exams. Model-graded "explain" answers give feedback, not XP.
2. **Rank needs skill, not grinding.** Belts require accuracy on harder questions, not just a pile of XP from easy ones.
3. **The biggest rewards go to the most useful act:** catching a real bug in code Claude wrote.
4. **Everything is local and self-reported.** Since nothing is uploaded, cheating only cheats yourself. Shared badges say "self-reported".

## Belts (rank)

Each language/topic track (for example *C++*, *Concurrency*, *Networking*, *Python*) has its own belt, plus an overall belt.

| Belt | Track XP | Belt exam |
|---|---|---|
| White | 0 | none |
| Yellow | 150 | 5 medium questions, at least 4 correct |
| Orange | 400 | 5 medium questions, at least 4 correct |
| Green | 900 | 6 hard questions, at least 5 correct |
| Blue | 1,800 | 6 hard questions, at least 5 correct, including 1 killing test |
| Brown | 3,500 | 8 hard questions, at least 7 correct, including 2 killing tests |
| Black | 6,000 | Boss fight (below) + at least 1 confirmed real bug in this track |

- Reaching the XP threshold unlocks the **belt exam**. The belt is awarded only when the exam is passed.
- Exams mix code challenges from your recent diffs, verified design questions (architecture, data structures) and curated pack questions for that track. All exam questions are execution-verified, read from parsed code or human-reviewed.
- At least half of each exam is code challenges, so a belt can't be earned from quizzes alone.
- A failed exam can be retaken after 24 hours, with new questions.
- Overall belt = the second-highest track belt, so it reflects breadth, not one specialty.

## XP

| Action | XP |
|---|---|
| Questionnaire, curated pack question, correct | 5 / 10 / 15 (easy / medium / hard) |
| Questionnaire, model-generated or project question, correct | half of the above |
| Design: architecture or data-structure question (verified from code), correct | 5 / 10 / 20 |
| Design: "why Claude did it", correct | 10 |
| Design: algorithm or complexity (model-checked), correct | 5 / 10 |
| Warning explanation, correct | 5 |
| Predict the output, correct | 10 / 20 (medium / hard) |
| Seeded bug hunt, correct | 10 / 20 / 30 (easy / medium / hard) |
| Write a killing test, accepted | 30 |
| Boss fight cleared | 100 |
| **Real bug in Claude's code, confirmed by a failing test** | **50 + trophy** |
| Daily streak bonus | +10% on that day's XP from day 3 of a streak, capped at +50% |

Wrong answers cost nothing. Skips cost nothing. Questions marked "bad" give nothing and are excluded from stats.

## Unlocks

Progress opens up harder and more interesting content:

| Unlocked at | What you get |
|---|---|
| Yellow | "Write a killing test" questions |
| Orange | Hard difficulty and multi-function mutants |
| Green | Concurrency and lifetime mutants (missing lock, use-after-move, dangling reference) |
| Blue | **Boss fights:** a whole changed file with 2–3 hidden mutations to find in one go |
| Brown | **Audit mode:** a full Claude diff where you have to decide whether a seeded bug exists at all (sometimes it doesn't) |
| Black | Custom mutation operators: write your own and add them to the dojo |

Cosmetic unlocks: CLI color themes and badge styles at each belt.

## Trophies (achievements)

Permanent, shown in `/diffdojo:stats` and on the badge. Examples:

- **First Catch** — first confirmed real bug in Claude's code.
- **Bug Hunter I / II / III** — 5 / 25 / 100 confirmed real bugs.
- **Mutant Slayer** — 25 accepted killing tests.
- **Clean Sweep** — clear a boss fight without a wrong guess.
- **Iron Streak** — 30-day streak.
- **Polyglot** — green belt in three tracks.
- **Architect** — 50 correct architecture questions.
- **Mind Reader** — 25 correct "why Claude did it" answers in a row without a miss.
- **Second Opinion** — a critique you wrote led to a confirmed bug report.
- **Scholar** — answer every question in one curated pack correctly at least once.
- **Pack Author** — get a question merged into a public pack.
- **Skeptic** — correctly answer "no bug here" five times in audit mode.

Real-bug trophies keep a link to the local bug report, so the trophy wall doubles as a record of what you actually caught.

## Session recap

When Claude finishes a turn and new questions are ready, `diffdojo quiz` shows a one-line header:

```
3 new questions from your last change · Green belt C++ (1,240 / 1,800) · streak 6 days
```

After answering, a short recap shows XP earned, belt progress and any trophy unlocked. Nothing is ever shown inside Claude's conversation.

## Shareable badge

`diffdojo badge` writes an SVG and a Markdown snippet you can put in your GitHub profile README or portfolio:

```
[DiffDojo · Black belt C++ · Brown belt Concurrency · 37 bugs caught in AI-written code · self-reported]
```

- Generated locally. You choose whether to commit it anywhere.
- Contains no code and no repo names unless you add them.
- Marked "self-reported", because there's no server to verify it.

## Stored data

Rewards live in the same local SQLite database: `xp_events`, `belts`, `exams`, `trophies`. `diffdojo purge` removes them with everything else.
