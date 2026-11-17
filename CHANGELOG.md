# Changelog

## 0.3.0

### Added
- **Bug Hunter**, a special fight against FREE CHINESE LLM: it slips a bug into a function Claude wrote and you pick the line that fixes it. Bugs come from Claude's recent code (or the demo project); Python/JS bugs are run first to make sure they change the result. Only the question has the bug. Trophy: *Firewall*. Also in `diffdojo battle`.
- **Prepare questions on a topic** (battle menu): pick a suggested topic or type your own; Claude writes questions on it in advance (checked blind like the rest), or the packs supply them. They come up in your next fights.
- **Scores** screen: one score across all your projects (XP, belt, streak, XP today, answers, accuracy) and a row per project with its XP, answers and accuracy (`diffdojo api scores`).
- **Share your score** as a GitHub Gist on your own account (`diffdojo share`, or Scores → Share my score): shows the exact card first, publishes through the GitHub CLI, numbers only (no code, questions or project names unless `--projects`), updates the same gist next time, `--remove` deletes it.
- **Achievements** screen: belt, XP, streak, belts per topic, and all trophies, earned or not.
- **Settings** screen: the model that writes your questions (Haiku 5.5 / Sonnet 5.5 / Opus 5.5), its effort (low / medium / high, passed as `--effort`), and whether Claude writes questions at all. New setting `model.effort` (default `low`).

### Changed
- **The battle menu is organised into screens**: Fight, Special fights, Prepare, Scores, Achievements, Settings, with a tab bar showing where you are and Back on each.

### Fixed
- **Starting a fight looked stuck**: after "... wants to fight!" the only control was a blinking marker that showed as an empty grey box. The fight now starts by itself once the enemy is in place (Enter skips the wait), and Continue is labelled.

## 0.2.3

### Fixed
- **No Mercy let a new file through without a question.** For a new file longer than about 14 lines (Claude's `bfs.cpp`), building the "which line did Claude write?" question crashed, and No Mercy waved the edit through. It now works on the whole file, and if one kind of question can't be built, SKYNET asks another kind instead of letting the edit pass.
- Fairer look-alike options: only code changes (never comments, which are left out of the options), template brackets are left alone (no `vector<=int>`), options that mean the same as Claude's line (`i != n` for `i < n`) are dropped, and only variables are swapped in (not types or function names).

### Changed
- **SKYNET asks in the battle pane**, not in the chat: the pane opens if it was closed, and you answer there. Claude Code's question dialog is only used when the pane can't be shown (or you close it mid-question). Several edits at once are asked one at a time. The "SKYNET wins" and "SKYNET falls" lines no longer go into the chat; the pane shows them.

## 0.2.2

### Changed
- **No Mercy is a fight against SKYNET**, not an on/off setting. Pick it in the battle menu (its warning comes first) or type `/nomercy`. Neither side has a health bar. SKYNET intercepts every edit Claude makes for your prompt and asks about it: one wrong (or skipped) answer and you lose, the edit is rejected and Claude stops. SKYNET falls when Claude finishes the prompt with every edit answered (trophy: *Judgment Averted*). RUN or `/nomercy off` ends the fight. The `noMercy` setting and `/nomercy on` are gone.
- `diffdojo battle` (the terminal game) starts at the menu when a No Mercy fight is on, since that fight happens in Claude Code.

## 0.2.1

### Added
- **No Mercy in the battle menu**: a last row in the menu opens SKYNET's screen.
- **RUN** in every fight (in Claude Code and `diffdojo battle`): ends the battle and goes back to the menu.
- **Health is a token budget**: the bars are TOKENS bars, damage is in tokens, and each hit spills token-like words (`▁def`, `await`, `##ing`, `</s>`...) out of the bar of whoever was hit.
- SKYNET has its own sprite on No Mercy's screen in the battle menu.

### Fixed
- Working-tree snapshots keep the index's timestamp, so a same-size edit made in the same second as the index is no longer missed (seen on macOS).
- The version is bumped so `/plugin update` picks up these changes.

## 0.2.0

### Added
- **Claude writes the questions.** After each change, a cheap model (`claude-haiku-5-5`) writes technical questions about that change in your project with `claude -p` on your own plan, in the background; a blind second call checks each one. They come first in the queue and in battles. On by default: `diffdojo config set model.enabled false` keeps a project fully local. The first session in Claude Code says this once.
- **No Mercy mode** (`/nomercy on`): before each of Claude's edits is applied, its boss SKYNET asks you a question about that exact change. Right: the edit goes through. Wrong or dismissed: the edit is rejected and Claude's turn is stopped.
- **Every project folder, git or not.** Folders without git are tracked through a private shadow repository in `~/.diffdojo/<id>/shadow.git`, so you get questions about Claude's changes there too, and nothing is written into the folder. Home folders, drive roots and folders with more than 20,000 files are skipped.
- 19 new JavaScript/TypeScript questions (parseInt with map, BigInt, freeze, JSON round trips, AbortSignal, ESM, `satisfies`, `as const`, exhaustive `never` checks and more).
- CI on Linux, macOS and Windows (Node 22 and 24), plus the in-app UI tests.
- `npm run test:ui` for the in-app UI tests.

### Fixed
- **Battle mode outside git repositories.** In a folder that wasn't a git repo, picking a mode sent you straight back to the menu, and sending a prompt didn't start a fight. Battles (and everything else) now work in any folder.
- **The fight opens when you send a prompt.** The pane is opened before anything else in the prompt hook, so Claude Code treats it as a response to your prompt and shows it even in narrower terminals.
- A failed battle action now shows a message instead of quietly resetting the screen.
- When Claude edited several files at once, more than one background question job could start for the same edit window.

### Changed
- The model path is now on by default, with Claude Haiku as the default model and a limit of 30 calls an hour (was off, 6 an hour).
- On Windows, the `claude` CLI is found and run correctly when it was installed by npm (a `.cmd` shim).

### Security
- Code from Claude's change (predict-the-output questions) now runs under bubblewrap on Linux (no network, read-only system, home folder hidden) and sandbox-exec on macOS (no network, no writes outside its temp folder), falling back to `unshare -rn` on Linux without bubblewrap.
- Such code always runs with a minimal environment: no API keys, tokens or cloud credentials.
- New `snippetSandbox` setting: `require` skips those questions on machines with no sandbox (Windows).
- `diffdojo doctor` reports which sandbox is in use.

## 0.1.0

First release.
