'use strict';
// No Mercy mode: before Claude's edit reaches the disk, the person answers one
// question about that exact change. Right: the edit goes through. Wrong (or
// dismissed): the edit is rejected and Claude's turn is stopped.
//
// The question is built from the *proposed* file (the edit applied in memory):
//   1. a technical question about something the change uses (packs/in-code),
//   2. else "which line completes Claude's change?": the changed code with one
//      line hidden, the real line among mutated look-alikes,
//   3. else a concept question on the file's language, so a gate is never free.
// Non-code files (Markdown, JSON, ...) pass without a question.

const fs = require('fs');
const path = require('path');
const lang = require('./lang');
const packs = require('./packs');
const store = require('./store');
const { mutants } = require('./mutate');
const { conceptQs } = require('./generators/concepts');
const { home, readJson, writeJson, shuffle, nowIso } = require('./util');

const KEYS = ['a', 'b', 'c', 'd'];
const MAX_EXCERPT = 14;
const LABEL_MAX = 90;

function gateFile() {
  return path.join(home(), 'gate.json');
}

/** The file as it will be once the tool call runs, or null when it can't be worked out. */
function proposed(input, root) {
  const tool = input.tool || input.tool_name;
  const fileArg = input.file_path || input.notebook_path || input.path;
  if (!fileArg || tool === 'NotebookEdit') return null;
  const abs = path.resolve(root || process.cwd(), fileArg);
  let before = '';
  try {
    before = fs.readFileSync(abs, 'utf8');
  } catch {
    /* a new file */
  }
  let after = before;
  if (tool === 'Write') after = String(input.content ?? '');
  else if (tool === 'Edit') after = applyEdit(before, input);
  else if (tool === 'MultiEdit') for (const e of input.edits || []) after = applyEdit(after, e);
  else return null;
  if (after == null) return null;
  const rel = root ? path.relative(root, abs).replace(/\\/g, '/') : path.basename(abs);
  return { file: rel.startsWith('..') ? path.basename(abs) : rel, abs, lang: lang.detect(abs), before, after };
}

function applyEdit(src, e) {
  if (src == null || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
  if (e.old_string === '') return src ? null : e.new_string;
  if (!src.includes(e.old_string)) return null; // the tool would refuse it anyway
  return e.replace_all ? src.split(e.old_string).join(e.new_string) : src.replace(e.old_string, () => e.new_string);
}

/** 1-based line numbers of `after` that the change touched (common prefix and suffix trimmed). */
function changedLines(before, after) {
  const a = before ? before.split('\n') : [];
  const b = after.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const out = [];
  for (let i = p; i < b.length - s; i++) if (b[i].trim()) out.push(i + 1);
  return out;
}

function excerpt(after, added) {
  const lines = after.split('\n');
  const from = Math.max(1, added[0] - 1);
  const to = Math.min(lines.length, Math.max(added[added.length - 1] + 1, from), from + MAX_EXCERPT - 1);
  return { from, to, lines: lines.slice(from - 1, to) };
}

const clip = (s) => {
  const t = s.trim();
  return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX - 1) + '…' : t;
};

/** Four (or three) distinct labels in random order, with the key of the right one. */
function labelled(right, wrong, rnd) {
  const seen = new Set([clip(right)]);
  const others = [];
  for (const w of wrong) {
    const l = clip(w);
    if (!seen.has(l)) {
      seen.add(l);
      others.push(w);
    }
  }
  if (others.length < 2) return null;
  const picked = shuffle([right, ...shuffle(others, rnd).slice(0, 3)], rnd);
  return { choices: Object.fromEntries(picked.map((t, i) => [KEYS[i], clip(t)])), answer: KEYS[picked.indexOf(right)] };
}

function conceptGate(p, added, rnd) {
  const [q] = conceptQs([{ file: p.file, lang: p.lang, src: p.after, added }], { max: 1, rnd });
  if (!q || !q.choices || Object.keys(q.choices).length < 3) return null;
  const right = q.choices[q.answer];
  const l = labelled(right, Object.entries(q.choices).filter(([k]) => k !== q.answer).map(([, v]) => v), rnd);
  if (!l) return null;
  return { ...q, ...l, format: 'choice', type: 'gate_concept', title: 'No Mercy' };
}

const KEYWORDS = new Set(('if else elif for while return def class import from as in is not and or None True False null true false ' +
  'undefined const let var function new this self await async yield break continue try except catch finally throw raise with lambda ' +
  'pass static public private protected void int auto bool char double float long unsigned struct std using namespace include template typename ' +
  'size_t string vector queue deque map set unordered_map unordered_set pair cout cin cerr endl main print len range str list dict console').split(' '));
const CMP = ['<=', '>=', '==', '!=', '<', '>'];
const ARITH = ['+', '-', '*', '/'];

/** Look-alikes of one line: other comparison or arithmetic operators, swapped names, numbers off by one. */
/** A line without its trailing comment (as the language sees it: not inside a string). */
function stripComment(line, language) {
  const masked = lang.mask(line, language);
  for (let i = 0; i < line.length; i++) {
    if (masked[i] === ' ' && (line.startsWith('//', i) || line.startsWith('#', i)) && line.slice(0, i).trim()) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

/** Blank out template/generic arguments (`vector<vector<int>>`, `Map<string, number>`) so their brackets aren't read as comparisons. */
function blankTemplates(code) {
  let prev
  do {
    prev = code
    code = code.replace(/(\w)<([\w:*&, ]*)>/g, (m, c) => c + ' '.repeat(m.length - 1))
  } while (code !== prev)
  return code
}

/** Where `a` and `b` first differ, or -1. */
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i
  return -1
}

function lookAlikes(line, names) {
  const out = new Set();
  const code = blankTemplates(line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => ' '.repeat(m.length))); // ignore strings and template brackets
  const cmp = /<=|>=|==|!=|(?<![<>=!-])<(?![<=])|(?<![<>=-])>(?![>=])/.exec(code);
  if (cmp) for (const op of CMP) if (op !== cmp[0]) out.add(line.slice(0, cmp.index) + op + line.slice(cmp.index + cmp[0].length));
  const ar = /(?<=\w\s?)[+\-*/](?=\s?\w)/.exec(code);
  if (ar) for (const op of ARITH) if (op !== ar[0]) out.add(line.slice(0, ar.index) + op + line.slice(ar.index + 1));
  const num = /\b\d+\b/.exec(code);
  if (num) for (const d of [-1, 1]) {
    const v = Number(num[0]) + d;
    if (v >= 0) out.add(line.slice(0, num.index) + v + line.slice(num.index + num[0].length));
  }
  const re = /\b[A-Za-z_]\w*\b/g;
  let m;
  while ((m = re.exec(code))) {
    if (KEYWORDS.has(m[0]) || code[m.index - 1] === '.') continue;
    for (const n of names) if (n !== m[0]) out.add(line.slice(0, m.index) + n + line.slice(m.index + m[0].length));
  }
  out.delete(line);
  return [...out];
}

/**
 * A look-alike that means the same as Claude's line would make the question
 * unfair: `i < n` and `i != n` in a counting loop, or `a == b` and `b == a`.
 */
function equivalent(original, other) {
  const flat = (t) => t.replace(/\s+/g, '')
  if (flat(original) === flat(other)) return true
  for (const [x, y] of [['<', '!='], ['>', '!=']]) {
    if (other.replace(y, x) === original || original.replace(y, x) === other) return true
  }
  const eq = /(\w+)\s*(==|!=)\s*(\w+)/
  const a = original.match(eq)
  const b = other.match(eq)
  return !!a && !!b && a[2] === b[2] && a[1] === b[3] && a[3] === b[1] && original.replace(eq, '') === other.replace(eq, '')
}

function lineGate(p, added, rnd) {
  // Work on the whole new file, then show a window around the hidden line:
  // a new file can be long, and any of its lines may be the one asked about.
  const lines = p.after.split('\n');
  const all = mutants(p.after, p.lang, { categories: ['basic', 'concurrency', 'lifetime'], headerLines: 0 });
  const touched = new Set(added.filter((n) => n >= 1 && n <= lines.length));
  const byLine = new Map();
  for (const n of touched) byLine.set(n, []);
  for (const m of all) if (!m.removed && byLine.has(m.originalLine)) byLine.get(m.originalLine).push(m);
  // Any changed line, at random; ones with real mutants first (those make the best distractors).
  const candidates = shuffle([...byLine.entries()], rnd)
    .filter(([n]) => {
      const t = (lines[n - 1] || '').trim();
      return t.length > 3 && !/^(\}|\{|else:?|\)|\]|;|pass|break|continue)$/.test(t) && !/^\s*(#|\/\/|import\b|from\b|#include|using\b)/.test(t);
    })
    .sort((x, y) => Number(y[1].length > 0) - Number(x[1].length > 0));
  for (const [n, ms] of candidates) {
    // The options are code only: a trailing comment would be the same in all of them.
    const original = stripComment(lines[n - 1], p.lang);
    const from = Math.max(1, n - 5);
    const to = Math.min(lines.length, n + 5);
    const window = lines.slice(from - 1, to);
    const masked = lang.mask(window.join('\n'), p.lang);
    // Swap in only variables: not keywords or types, and not names used as functions or templates.
    const called = new Set((masked.match(/\b[A-Za-z_]\w*(?=\s*[(<])/g) || []));
    const names = [...new Set((masked.match(/\b[A-Za-z_]\w*\b/g) || []).filter((w) => !KEYWORDS.has(w) && !called.has(w)))];
    // Drop look-alikes that only change a template's brackets (vector<=int> is no real alternative).
    const tmpl = blankTemplates(original)
    const inTemplate = (w) => {
      const i = firstDiff(original, w)
      return i >= 0 && tmpl[i] === ' ' && original[i] !== ' '
    }
    const wrong = [...ms.map((m) => stripComment(m.mutatedLine, p.lang)), ...shuffle(lookAlikes(original, names), rnd)].filter((w) => !equivalent(original, w) && !inTemplate(w));
    const l = labelled(original, wrong, rnd);
    if (!l) continue;
    const indent = original.match(/^\s*/)[0];
    const shown = window.map((t, i) => (from + i === n ? `${indent}???` : t)).join('\n');
    return {
      family: 'code',
      type: 'gate_line',
      format: 'choice',
      title: 'No Mercy',
      topic: `${lang.trackFor(p.lang) || p.lang}/gate`,
      track: lang.trackFor(p.lang) || null,
      difficulty: 'medium',
      grading: 'verified',
      xp: 10,
      prompt: `Claude wants to change ${p.file}. One line of the new code is hidden (???, line ${n}). Which line did Claude write there?`,
      code: shown,
      code_lang: p.lang,
      code_file: p.file,
      code_start: from,
      code_end: to,
      ...l,
      explanation: `Claude's line ${n} is: ${original.trim()}`,
      meta: { selectedBy: 'No Mercy', line: n },
    };
  }
  return null;
}

function packGate(p, rnd) {
  const track = lang.trackFor(p.lang);
  let pool = packs.load().questions.filter((q) => q.format === 'multiple_choice' && Object.keys(q.choices).length >= 4);
  const mine = pool.filter((q) => q.track === track);
  if (mine.length) pool = mine;
  if (!pool.length) return null;
  const pq = shuffle(pool, rnd)[0];
  const q = packs.toQuestion(pq, { meta: { pack: pq.pack, selectedBy: 'No Mercy' } });
  const l = labelled(q.choices[q.answer], Object.entries(q.choices).filter(([k]) => k !== q.answer).map(([, v]) => v), rnd);
  if (!l) return null;
  return { ...q, ...l, format: 'choice', type: 'gate_pack', title: 'No Mercy', prompt: `Before Claude writes ${p.file}: ${q.prompt}` };
}

/**
 * Build the gate for a tool call. Returns {skip} or {id, prompt, code, options}
 * (no answer key: that stays in the database and gate.json).
 */
function create(db, input, { root, repoId, rnd = Math.random } = {}) {
  const p = proposed(input, root);
  if (!p) return { skip: 'not a file edit DiffDojo can read' };
  if (!p.lang || !lang.family(p.lang)) return { skip: `no question for ${p.file} (not code)` };
  const added = changedLines(p.before, p.after);
  if (!added.length) return { skip: 'the edit adds no code' };
  // Each kind of question in turn; one that fails to build falls through to the next,
  // so SKYNET always asks something rather than waving the edit through.
  let q = null;
  for (const make of [() => conceptGate(p, added, rnd), () => lineGate(p, added, rnd), () => packGate(p, rnd)]) {
    try {
      q = make();
    } catch (e) {
      require('./util').log('gate', e);
      q = null;
    }
    if (q) break;
  }
  if (!q) return { skip: 'no question could be built' };
  const id = store.insertQuestion(db, { ...q, repo_id: repoId || null, batch: `${nowIso()}#gate`, status: 'gate' });
  const options = KEYS.filter((k) => q.choices[k]).map((k) => q.choices[k]);
  writeJson(gateFile(), { id, file: p.file, at: nowIso() });
  return { id, file: p.file, prompt: q.prompt, code: q.code || null, options };
}

/** Grade a gate answer: the option label chosen, or a typed letter. */
async function answer(db, id, response, { cfg, root } = {}) {
  const q = store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', Number(id)));
  if (!q || q.status !== 'gate') return { error: 'no such gate' };
  const r = String(response ?? '').trim();
  let key = Object.keys(q.choices).find((k) => q.choices[k] === r);
  if (!key && /^[a-d]\)?$/i.test(r)) key = r[0].toLowerCase();
  const graded = await require('./grader').answer(db, q, key || r, { mode: 'gate', cfg, root });
  const g = readJson(gateFile(), null);
  if (g && g.id === q.id) fs.rmSync(gateFile(), { force: true });
  return { correct: graded.correct === true, xp: graded.xp || 0, answerText: q.choices[q.answer], explanation: q.explanation || null, trophies: graded.trophies || [], difficulty: q.difficulty, file: q.code_file || null };
}

module.exports = { create, answer, proposed, changedLines, lookAlikes, stripComment, equivalent, blankTemplates, firstDiff, labelled, KEYWORDS };
