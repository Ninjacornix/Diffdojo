# Privacy and Security

## Baseline

**DiffDojo never uploads code, answers or stats.** It has no server and no telemetry. The only optional network traffic is the question-generation model call, which uses the user's own Claude plan or API key and is subject to that provider's normal terms.

## Data stored locally

| Data | Location | Contents |
|---|---|---|
| Edit events | `~/.diffdojo/<repo-id>/events.jsonl` | Timestamps and relative file paths only |
| Questions and answers | `~/.diffdojo/diffdojo.db` | Question text, code excerpt (max ~60 lines), user answers, grades |
| Extracted rationale | `~/.diffdojo/diffdojo.db` | A few sentences of Claude's stated reasoning per change, with a turn reference. Read from the local session transcript; the transcript itself isn't copied |
| Bug reports | `~/.diffdojo/<repo-id>/bugs/` | Diff excerpt, test code, test output |
| Logs | `~/.diffdojo/logs/` | Errors, no code |

Nothing is written into the repository. `<repo-id>` is a hash of the repo's absolute path.

## Controls

- **Per-repo opt-in.** Hooks exit immediately for repos that haven't been enabled.
- **Deny globs** (defaults): `.env*`, `*.pem`, `*.key`, `secrets/**`, `**/node_modules/**`, `**/build/**`, `**/dist/**`, lockfiles, binaries.
- **Secret scan** of every excerpt before it's stored or sent to a model: common key and token patterns. Any match drops the excerpt.
- **Transcript access is limited.** Only the Stop hook reads the transcript, only for enabled repos, only the turn that just ended, and only to extract Claude's explanation text. A setting turns "why" questions off entirely.
- **Model path off by default.** When enabled, the UI shows exactly which excerpt is sent.
- `diffdojo export` writes all data for a repo to a single JSON file. `diffdojo purge [--repo]` deletes it.

## Model path note

If the model path uses `claude -p`, the excerpts sent are handled like any other Claude Code request under the user's account settings, including that account's model-training preference. The docs and first-run prompt must say this plainly. Users with confidential code should keep the model path off or use an account or API key whose terms they've checked.

## Execution safety

Validation runs code, so:
- Snippets and mutants run in a temporary directory, never in the working tree.
- Only the user-configured test command is executed against the project. DiffDojo never invents build or shell commands.
- Snippet execution has a timeout (default 5 s) and, where available, runs with no network (for example `unshare -n` on Linux or a container).
- Repository text is treated as data. Instructions in comments or files are never followed by the generator. Model prompts wrap code in clear delimiters and ask only for questions in a fixed JSON schema, which is then validated.

## Threats

| Threat | Mitigation |
|---|---|
| Secrets copied into the database | Deny globs, secret scan, excerpt size cap |
| Prompt injection via repo content | Fixed output schema, schema validation, no tool access for the generator |
| Malicious code executed during validation | Temp dir, timeouts, no network where possible, only user-configured test command |
| Slowing or breaking Claude Code | Async hooks, early exit, never exit code 2, errors swallowed and logged |
| Hook recursion from `claude -p` | `DIFFDOJO_CHILD=1` guard in every hook |
| Malicious plugin update | Pinned dependencies, tagged signed releases, readable source |

## Workplace use

A plugin running locally doesn't change who owns the code. Users on employer repos should follow their employer's rules about third-party tools, especially before enabling the model path.
