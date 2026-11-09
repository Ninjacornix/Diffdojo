'use strict';
// Settings: global defaults merged with ~/.diffdojo/config.json and per-repo
// overrides in ~/.diffdojo/<repo-id>/config.json. Plain JSON so hooks can
// read it without opening the database.

const path = require('path');
const { home, repoDir, readJson, writeJson } = require('./util');

const DEFAULT_DENY = [
  '.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'secrets/**', '**/secrets/**',
  '**/node_modules/**', '**/build/**', '**/dist/**', '**/out/**', '**/.git/**', '**/vendor/**',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock',
  'go.sum', 'composer.lock', 'Gemfile.lock', '*.min.js', '*.map', '*.lock',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.pdf', '*.zip', '*.gz', '*.tar', '*.exe',
  '*.dll', '*.so', '*.dylib', '*.a', '*.o', '*.obj', '*.class', '*.jar', '*.wasm', '*.bin',
];

const DEFAULTS = {
  // Global only: run in every git repository unless /diffdojo:stop was used there.
  // Set false to go back to per-repo opt-in with /diffdojo:start.
  autoEnable: true,
  // In-app battle mode: while Claude works, questions come as a turn-based fight. /battle off to use the plain question box.
  battle: true,
  // Name shown in battles; empty = git user name, else the system username.
  playerName: null,
  deny: DEFAULT_DENY,
  allow: [], // if non-empty, only these globs are considered
  maxChangedLines: 400, // per question batch
  maxExcerptLines: 60,
  questionsPerTurn: 6,
  sessionCap: 40, // max questions generated per Claude session
  quiet: false, // when true, hooks record but generate nothing until `diffdojo generate`
  mix: { code: 40, design: 30, questionnaire: 30 },
  families: ['code', 'design', 'questionnaire'],
  testCommand: null, // e.g. "pytest -q" or "npm test" — the only project command ever executed
  testTimeoutSec: 120,
  lintCommand: null, // optional; otherwise a few known linters are tried on changed files
  snippetTimeoutSec: 5,
  snoozeMinutes: 60,
  whyQuestions: true, // read Claude's stated reasoning from the local transcript
  pinnedTopics: [],
  model: {
    enabled: false,
    provider: 'claude-cli', // 'claude-cli' (claude -p) or 'api' (ANTHROPIC_API_KEY)
    model: 'claude-haiku-5-5',
    perHour: 6,
    showExcerpts: true,
  },
  theme: 'auto',
};

function deepMerge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b === undefined ? a : b;
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}

function globalFile() {
  return path.join(home(), 'config.json');
}

function repoFile(id) {
  return path.join(repoDir(id), 'config.json');
}

function load(id) {
  let cfg = deepMerge(DEFAULTS, readJson(globalFile(), {}));
  if (id) cfg = deepMerge(cfg, readJson(repoFile(id), {}));
  return cfg;
}

function setValue(key, value, id) {
  const file = id ? repoFile(id) : globalFile();
  const cur = readJson(file, {});
  const parts = key.split('.');
  let o = cur;
  for (const p of parts.slice(0, -1)) o = o[p] = typeof o[p] === 'object' && o[p] ? o[p] : {};
  o[parts[parts.length - 1]] = value;
  writeJson(file, cur);
  return cur;
}

function parseValue(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[[{]/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      /* fall through */
    }
  }
  return s;
}

module.exports = { DEFAULTS, DEFAULT_DENY, load, setValue, parseValue, globalFile, repoFile };
