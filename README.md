# DiffDojo

Learn from the code Claude writes for you, while it's writing it.

<p align="center"><img src="docs/evil-claude-battle.svg" alt="DiffDojo Battle: fighting Evil Claude in the terminal by answering a question about the code Claude just wrote" width="677"></p>

When Claude Code is working on your project, you mostly sit and wait. DiffDojo uses that time. Every time Claude changes your code, it asks you a few short questions about that change: what a line does, why that data structure, what a function returns for some input. Answer them and you actually read the code instead of skimming past it. Skip them and nothing happens: they never hold Claude up (unless you pick the No Mercy fight, where that's the point).

It's a plugin for Claude Code. It isn't made by or affiliated with Anthropic.

## Install

You need [Node.js](https://nodejs.org) 22.18 or newer and git. Nothing else is required, and there's no `npm install` step. Python and a C++ compiler are optional; with them DiffDojo can run your Python and C++ functions to check "what does this return?" questions.

In Claude Code:

```
/plugin install diffdojo --marketplace Ninjacornix/Diffdojo
```

Say yes to adding the marketplace and pick a scope ("user" is what most people want). From a shell it's `claude plugin install diffdojo --marketplace Ninjacornix/Diffdojo`. In the desktop app, click the + next to the prompt box, then Plugins, add the marketplace `Ninjacornix/Diffdojo`, and add the plugin.

To update later: `/plugin`, or `claude plugin update diffdojo`. Restart Claude Code afterwards.

That's all. DiffDojo turns itself on in every project you open, with or without git. It leaves your home folder and drive roots alone, so open Claude Code in an actual project folder.

## What it looks like

By default the questions come as a fight. When you send Claude a prompt, a pane opens next to the chat with a little turn-based RPG battle, drawn in ASCII in your terminal's own colours (the picture at the top is a real frame). Pick an answer with up/down and Enter. Get it right and you hit the enemy; get it wrong and it hits you back. Your health bar is a token budget, and when you get hit you can watch tokens like `▁def`, `await` and `</s>` fall out of it. You get three lives per ladder.

The pane only takes your keyboard when your prompt is empty, never while you're typing. Esc takes you back to your prompt, and `/battle` brings the fight back.

If you'd rather not have a pane opening on every prompt, `/battle off` switches to a quieter mode where the current question sits in a small box above your prompt while Claude works:

```
╭──────────────────────────────────────────────────────────────────╮
│ DiffDojo · Design · Data structure · verified · 10 XP            │
│ `jobs` is declared in sched.py:8 in Claude's change. What is it? │
│ 1 a) dict                                                        │
│ 2 b) list used as a binary heap (heapq)                          │
│ 3 c) set                                                         │
│ 4 d) tuple                                                       │
│ Press 1-4 in the empty prompt · Skip  Snooze  Bad question  Hide │
╰──────────────────────────────────────────────────────────────────╯
```

Press 1 to 4 while your prompt is empty. For typed answers (a line number, an output), press ctrl+x tab to get into the answer box. `/dojo` opens a side pane with the whole question and its code. `/battle on` brings the fight back.

## Where the questions come from

**Claude writes some of them.** After each change, a small, cheap model (Claude Haiku by default) looks at the changed code in the background and writes a few multiple-choice questions about it. Something like "two jobs are added with the same time; which one does `due(5)` return first?" A second call answers each question without seeing the answer key, and a question is only kept if both agree. This uses your own Claude plan and never shows up in your conversation. More on what gets sent below.

**DiffDojo builds others itself**, from the code, with no model involved:

- "Claude used `std::lock_guard` here. What does it do?" for APIs it recognises in the change.
- "What does `clamp(5, 10, 0)` return?" DiffDojo runs the function to get the real answer.
- "What container is `pending_`, and what does it cost to pop from it?"
- In the plain quiz there's also spot-the-bug (one line of Claude's function quietly broken), write-a-test-that-catches-it, and "why did Claude do this?", checked against what Claude actually said in your session.

**And there are 270-odd hand-written questions** on C++, concurrency, Linux networking, Python, JavaScript/TypeScript and algorithms, picked by what you're working on. If you're writing epoll code, you'll get epoll questions.

## The battle menu

`/battle` opens a menu with a few screens:

- **Fight**: the ladders. Easy, Medium, Hard, Professional (its last boss is Evil Claude), and Endless, where the waves keep getting tougher.
- **Special fights**: Rush, Bug Hunter and No Mercy, all described below.
- **Prepare**: pick a topic, or type one ("Rust lifetimes"), and Claude writes a set of questions on it for your next fights. Without Claude, they come from the question packs.
- **Scores**: your XP, belt, streak and accuracy across all your projects, plus a line per project.
- **Achievements**: belts and trophies. Each trophy has its own little ASCII picture.
- **Settings**: which model writes your questions (Haiku, Sonnet or Opus), how much effort it puts in, and whether Claude writes questions at all. Bigger model or more effort means harder questions and more of your plan used.

### Rush

A race against THE CLOCK. You have 60 seconds to get as many questions right as you can. A right answer adds 2 seconds, a wrong one takes 5 away, so guessing doesn't pay. There's no result screen between questions, just the next one, and when time runs out you get your score and your best. The clock starts with the first question, not during the intro, and it's kept by DiffDojo itself, so an answer that arrives after time is up doesn't count. There are trophies for finishing your first Rush and for 10, 25 and 50 right in one run.

### Bug Hunter

The enemy here is FREE CHINESE LLM. It "optimises" one of the functions Claude wrote for you and slips a bug in. You get the broken function and pick the line that fixes it. The wrong choices often include leaving the line as it is. For Python and JavaScript, DiffDojo runs both versions first to make sure the bug really changes the result. The bug only exists inside the question; your files are never touched.

### No Mercy

This one is for when you really want to keep up with Claude. You fight SKYNET, and neither of you has a health bar. While the fight is on, SKYNET stops every edit Claude tries to make for your prompt and asks you about it first, in the battle pane. Usually that's "which line did Claude write here?" with the real line hidden among look-alikes, or "what does this API do?"

Answer right and the edit goes through. Answer wrong, or skip the question, and you lose on the spot: the edit is rejected and Claude stops, so you can go and look at what it was doing. If Claude finishes your prompt and you answered for every edit, SKYNET falls.

It only starts when you pick it (from Special fights, or with `/nomercy`), it shows you this warning first, and RUN or `/nomercy off` ends it. Edits to non-code files like Markdown or JSON go straight through. If DiffDojo itself fails to build a question, the edit goes through rather than blocking you.

## Try it without asking Claude for anything

```bash
diffdojo demo     # creates ~/diffdojo-demo with a fake Claude change, already turned into questions
cd ~/diffdojo-demo
diffdojo battle   # the battle, right in this terminal, no Claude Code needed
```

You can also open the demo folder in Claude Code and type `/battle` or `/dojo`.

## Belts, XP and trophies

Right answers give XP. Each topic (C++, Python, networking and so on) has its own belt, from white to black, and moving up takes a short belt exam. Higher belts unlock boss fights (find three hidden bugs in one file) and audit mode (is there even a bug?).

The best thing you can do is catch a real bug in Claude's code and prove it with a failing test (`/diffdojo:report-bug`). That gets you a trophy and a saved bug report.

`diffdojo badge` makes a small SVG badge for your GitHub profile. `diffdojo share` (or Share in the Scores screen) puts your score card in a gist on your own GitHub account using the [GitHub CLI](https://cli.github.com). Run `gh auth login` once first. It shows you exactly what will be published before it does anything. The gist is public (`--secret` makes it unlisted), and the card has numbers only, never code or project names. Sharing again updates the same gist, and `diffdojo share --remove` deletes it.

To keep things fair, each question pays XP once no matter how often it comes back, and practice (pack questions, battles, Bug Hunter, prepared topics) is capped at 300 XP a day. Questions about Claude's real changes aren't capped. Scores are still self-reported, since the data lives on your machine, and anyone who really wants to can edit it ([more on that](docs/REWARDS.md#what-this-cant-stop)).

## Privacy, and what leaves your machine

- Your progress, questions and answers are stored in `~/.diffdojo/`. Nothing is written into your project, not even its `.git` folder: the snapshots DiffDojo takes to see what Claude changed live in `~/.diffdojo/` too, and files over 5 MB are skipped.
- **Claude-written questions are on by default.** To write them, DiffDojo sends short excerpts of the changed code (about 160 lines at most) to Claude with `claude -p`, on your own plan, at most 30 times an hour. Files on the deny list (`.env`, keys, lockfiles, build output and so on) are never included, and any excerpt that looks like it contains a secret is dropped. These calls are handled like any other Claude Code request under your account's terms. If the code is confidential, turn them off:

  ```bash
  diffdojo config set model.enabled false            # this project
  diffdojo config set model.enabled false --global   # everywhere
  ```

  With that off, nothing leaves your machine and you get DiffDojo's own questions only.
- Your score leaves your machine only when you share it, as a public gist.
- To answer "what does this return?", DiffDojo runs functions from Claude's change. On Linux with bubblewrap installed, and on macOS, that happens in a sandbox with no network and no write access to your files. On Linux without bubblewrap only the network is blocked, and on Windows there's no sandbox at all, just a timeout and an environment with API keys and tokens stripped out. Every platform gets that stripped environment. If that worries you, `diffdojo config set snippetSandbox require --global` skips those questions wherever there's no sandbox. `diffdojo doctor` tells you which one you have.
- The only project command DiffDojo ever runs is the test command you give it (`/diffdojo:start npm test`), and only in a temporary copy of your project.
- The background work doesn't hold Claude up. No Mercy is the exception: there, holding up Claude's edits is the whole point. A No Mercy fight only applies to the Claude Code session and project you started it in, ends when you quit, and expires after 3 hours.
- The background `claude -p` calls run from an empty temp folder, so they don't load your project's CLAUDE.md or settings, and they aren't saved to `/resume`.
- `diffdojo export` gives you all your data as one file, and `diffdojo purge --yes` deletes it.

The details are in [Privacy & security](docs/PRIVACY_AND_SECURITY.md).

## Turning it off

- In one project: `/diffdojo:stop` (and `/diffdojo:start` to turn it back on).
- Everywhere, unless you opt in per project: `diffdojo config set autoEnable false --global`.
- Just the battle: `/battle off`.

## Commands

| Command | What it does |
|---|---|
| `/battle` | Open the battle and its menu (`/battle off`, `/battle menu`) |
| `/dojo` | Open the question pane next to the chat |
| `/nomercy` | Fight SKYNET for your next prompt (`/nomercy off` ends it) |
| `/diffdojo:start [test command]` | Turn DiffDojo on here, optionally with your test command |
| `/diffdojo:stop` | Turn it off here |
| `diffdojo quiz` | Answer your questions in a terminal (`--topic networking` to practise a topic) |
| `diffdojo battle` | The battle, in a terminal |
| `diffdojo stats` | Belts, XP, accuracy, streak, trophies and projects |
| `diffdojo review` | Retry the questions you got wrong |
| `diffdojo exam cpp` | Take your next belt exam in a topic |
| `diffdojo serve` | The quiz in your browser (local only) |
| `diffdojo badge` | Make a profile badge |
| `diffdojo share` | Share your score card as a gist (`--yes` to publish, `--remove` to delete) |
| `diffdojo doctor` | Check your setup |

In the terminal quiz, type your answer, or `s` to skip, `z` to snooze, `b` to flag a bad question and `q` to quit. `diffdojo help` lists everything else.

The `diffdojo` command is available inside Claude Code automatically. To use it in your own terminal, run `npm link` in a checkout of this repo, or call `node /path/to/Diffdojo/bin/diffdojo` directly.

## Working on DiffDojo

```bash
git clone https://github.com/Ninjacornix/Diffdojo.git
cd your-project
claude --plugin-dir /path/to/Diffdojo
```

The easiest way to help is with more questions. Packs are plain YAML files in [`packs/`](packs/), and you can keep private ones in `~/.diffdojo/packs/`.

```bash
npm test          # unit and end-to-end tests
npm run test:ui   # the in-app UI tests (needs the claude CLI)
npm run pack-ci   # check every question pack and run its code snippets
npm run lint      # syntax-check every source file
```

CI runs these on Linux, macOS and Windows with Node 22 and 24. The design docs explain how it all fits together: [product requirements](docs/PRODUCT_REQUIREMENTS.md), [architecture](docs/ARCHITECTURE.md), [questions and grading](docs/QUESTIONS_AND_GRADING.md), [rewards](docs/REWARDS.md), [privacy and security](docs/PRIVACY_AND_SECURITY.md) and the [roadmap](docs/ROADMAP.md).

## Status

Version 0.4. It's young, so expect rough edges. The [changelog](CHANGELOG.md) has what changed, and if something breaks, please [open an issue](https://github.com/Ninjacornix/Diffdojo/issues).

## License

[MIT](LICENSE).
