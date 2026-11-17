# Changelog

## 0.2.0

### Fixed
- **Battle mode outside git repositories.** In a folder that wasn't a git repo, picking a mode sent you straight back to the menu, and sending a prompt didn't start a fight. Battles now work in any folder, using concept questions where there's no change to ask about.
- **The fight opens when you send a prompt.** The pane is opened before anything else in the prompt hook, so Claude Code treats it as a response to your prompt and shows it even in narrower terminals.
- A failed battle action now shows a message instead of quietly resetting the screen.
- When Claude edited several files at once, more than one background question job could start for the same edit window.

### Security
- Code from Claude's change (predict-the-output questions) now runs under bubblewrap on Linux (no network, read-only system, home folder hidden) and sandbox-exec on macOS (no network, no writes outside its temp folder), falling back to `unshare -rn` on Linux without bubblewrap.
- Such code always runs with a minimal environment: no API keys, tokens or cloud credentials.
- New `snippetSandbox` setting: `require` skips those questions on machines with no sandbox (Windows).
- `diffdojo doctor` reports which sandbox is in use.

### Added
- 19 new JavaScript/TypeScript questions (parseInt with map, BigInt, freeze, JSON round trips, AbortSignal, ESM, `satisfies`, `as const`, exhaustive `never` checks and more).
- CI on Linux, macOS and Windows (Node 22 and 24), plus the in-app UI tests.
- `npm run test:ui` for the in-app UI tests.

## 0.1.0

First release.
