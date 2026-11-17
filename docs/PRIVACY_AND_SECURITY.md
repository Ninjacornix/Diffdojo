# Privacy and Security

## Baseline

DiffDojo has no server and no telemetry. Two things can leave the machine, and both go to services the user already has an account with:

1. **Code excerpts, to Claude, by default.** To write questions about each change, DiffDojo sends short excerpts of the changed code to Claude with `claude -p` on the user's own plan (or with their API key). This is on by default and can be turned off per project or everywhere (`diffdojo config set model.enabled false [--global]`); see [Model path](#model-path-note).
2. **A score card, to GitHub, only when the user shares it.** `diffdojo share` publishes numbers (no code) as a gist on the user's own account; see Controls.

Answers, questions, stats and everything else stay in `~/.diffdojo/`.

## Data stored locally

| Data | Location | Contents |
|---|---|---|
| Edit events | `~/.diffdojo/<repo-id>/events.jsonl` | Timestamps and relative file paths only |
| Questions and answers | `~/.diffdojo/diffdojo.db` | Question text, code excerpt (max ~60 lines), user answers, grades |
| Extracted rationale | `~/.diffdojo/diffdojo.db` | A few sentences of Claude's stated reasoning per change, with a turn reference. Read from the local session transcript; the transcript itself isn't copied |
| Bug reports | `~/.diffdojo/<repo-id>/bugs/` | Diff excerpt, test code, test output |
| Snapshots | `~/.diffdojo/<repo-id>/objects/` (git repos) or `~/.diffdojo/<repo-id>/shadow.git` (folders without git) | Git objects for the working tree at each turn, so changes can be diffed. Files over 5 MB are left out |
| Logs | `~/.diffdojo/logs/` | Error messages and stack traces; these can include a few lines of `claude -p` or test output |

Nothing is written into the project, including its `.git` folder: snapshots of a git repository are written to DiffDojo's own object store, which reads the repository's objects but never adds to them. `<repo-id>` is a hash of the project's absolute path.

## Controls

- **Where it runs.** Once the plugin is enabled in Claude Code, DiffDojo runs in every project folder, git or not (`autoEnable`, on by default). A folder without git is tracked through a shadow repository in `~/.diffdojo/<id>/shadow.git`, so nothing is written into it; the home folder and drive roots are never tracked, and folders with more than 20,000 files are skipped. `/diffdojo:stop` turns it off for one folder, and hooks exit immediately there; `diffdojo config set autoEnable false --global` restores per-repo opt-in with `/diffdojo:start`.
- **Deny globs** (defaults): `.env*`, `*.pem`, `*.key`, `secrets/**`, `**/node_modules/**`, `**/build/**`, `**/dist/**`, lockfiles, binaries.
- **Secret scan** of every excerpt before it's stored or sent to a model: common key and token patterns. Any match drops the excerpt.
- **Transcript access is limited.** Only the Stop hook reads the transcript, only for enabled repos, only the turn that just ended, and only to extract Claude's explanation text. A setting turns "why" questions off entirely.
- **Model path on by default.** Claude writes technical questions about each change with `claude -p` on the user's own plan, using a cheap model (`claude-haiku-5-5`), from at most ~160 lines of changed code per batch that passed the deny globs and the secret scan. The first session in Claude Code says so once, with the command to turn it off (`diffdojo config set model.enabled false`, per project or `--global`). At most 30 calls an hour (`model.perHour`).
- **Sharing is opt-in and numbers only.** `diffdojo share` (or Scores → Share) shows the card, then publishes it as a **public** gist on the user's own GitHub account (`--secret` for an unlisted one) through the GitHub CLI, so DiffDojo never handles a GitHub token. It contains XP, belts, streak, accuracy, trophy names, battles cleared and a project count, never code, questions or paths. `--projects` adds project folder names. `--remove` deletes it.
- **The background `claude -p` call is isolated.** It runs from an empty temp folder (so the project's CLAUDE.md and project settings aren't loaded), with no tools, no MCP servers, no slash commands, user settings only, and it isn't saved as a resumable session.
- `diffdojo export` writes all data for a repo to a single JSON file. `diffdojo purge [--repo]` deletes it.

## Model path note

If the model path uses `claude -p`, the excerpts sent are handled like any other Claude Code request under the user's account settings, including that account's model-training preference. The docs and first-run prompt must say this plainly. Users with confidential code should turn the model path off (`diffdojo config set model.enabled false`) or use an account or API key whose terms they've checked.

## Execution safety

Validation runs code, so:
- Snippets and mutants run in a temporary directory, never in the working tree. The test command runs in a temporary copy of the project; dependency folders (`node_modules`, virtualenvs, `vendor`) are linked into the copy so tests can run, build output folders are not.
- Only the user-configured test command is executed against the project. DiffDojo never invents build or shell commands.
- Code taken from Claude's change (predict-the-output questions) runs in the strongest sandbox the machine has, always with a timeout (default 5 s) and a minimal environment with no API keys, tokens or cloud credentials:

  | Platform | Sandbox | What it blocks |
  |---|---|---|
  | Linux with bubblewrap (`bwrap`) | `bwrap` | network; writes anywhere but the snippet's temp folder; the home folder is hidden, unless the runtime itself lives there (nvm, pyenv), in which case it stays readable but still not writable |
  | Linux without bubblewrap | `unshare -rn` | network only: the code can still write wherever the user can |
  | macOS | `sandbox-exec` | network; writes outside the snippet's temp folder |
  | Windows | none | only the timeout and the minimal environment apply |

  `diffdojo doctor` shows which one is in use. Set `diffdojo config set snippetSandbox require --global` to skip those questions on a machine with no sandbox instead of running the code unsandboxed.
- Repository text is treated as data. Instructions in comments or files are never followed by the generator. Model prompts wrap code in clear delimiters and ask only for questions in a fixed JSON schema, which is then validated.

## Threats

| Threat | Mitigation |
|---|---|
| Secrets copied into the database | Deny globs, secret scan, excerpt size cap |
| Prompt injection via repo content | Fixed output schema, schema validation, no tool access for the generator |
| Malicious code executed during validation | Temp dir, timeouts, minimal environment, OS sandbox where available (`snippetSandbox: require` to insist on one), only user-configured test command |
| Slowing or breaking Claude Code | Async hooks, early exit, never exit code 2, errors swallowed and logged |
| Hook recursion from `claude -p` | `DIFFDOJO_CHILD=1` guard in every hook |
| Malicious plugin update | No npm dependencies, readable source, updates only through the user's `/plugin update` |
| A No Mercy fight blocking edits later or elsewhere | The fight belongs to the Claude Code session and project that started it, ends when the session ends, and expires after 3 hours |

## Workplace use

A plugin running locally doesn't change who owns the code. Users on employer repos should follow their employer's rules about third-party tools, especially before enabling the model path.
