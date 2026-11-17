'use strict';
// Bug Hunter: the enemy (FREE CHINESE LLM) "optimises" a function Claude wrote
// and slips one bug into it. You see the broken function and pick the line
// that fixes it. Only the question holds the bug: no file is ever changed.
//
// Functions come from Claude's recent changes in this project (code_units),
// then from any project, then from the demo project shipped with DiffDojo.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const lang = require('./lang');
const { analyze } = require('./lang/structure');
const { mutants } = require('./mutate');
const { lookAlikes, stripComment, equivalent, blankTemplates, firstDiff, labelled, KEYWORDS } = require('./gate');
const { shuffle, nowIso } = require('./util');

/**
 * Is the "bug" a real one? For a pure function DiffDojo can run, it runs the
 * original and the broken version on a few inputs; a change that never shows
 * (clamp's `x < lo` vs `x <= lo` both return lo) is no bug to hunt.
 */
function changesBehaviour(u, brokenCode) {
  // Only where it's quick (no compiler): a battle question must not take seconds.
  if (!['python', 'javascript', 'typescript'].includes(u.language)) return null;
  try {
    const structure = analyze(u.code, u.language);
    const fn = structure.functions[0];
    if (!fn) return null;
    return require('./generators/predict').mutantChangesBehaviour(fn, u.language, structure, u.code, brokenCode, { timeoutSec: 3 });
  } catch {
    return null;
  }
}

const ENEMY = 'FREE CHINESE LLM';
const MAX_LINES = 30;

/** Functions to break: Claude's recent code first. */
function sources(db, repoId) {
  const pick = (rows) => rows.filter((u) => u.code && u.code.split('\n').length >= 3 && u.code.split('\n').length <= MAX_LINES);
  const mine = repoId ? pick(db.all('SELECT * FROM code_units WHERE repo_id = ? ORDER BY id DESC LIMIT 40', repoId)) : [];
  if (mine.length) return mine;
  const any = pick(db.all('SELECT * FROM code_units ORDER BY id DESC LIMIT 40'));
  if (any.length) return any;
  return demoUnits();
}

/** The demo project's functions, so Bug Hunter works before Claude has written anything. */
function demoUnits() {
  const dir = path.join(__dirname, '..', 'demo', 'after');
  const out = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const l = lang.detect(f);
    if (!l) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = src.split('\n');
    for (const fn of analyze(src, l).functions) {
      out.push({ file: f, language: l, name: fn.name, start_line: fn.start, code: lines.slice(fn.start - 1, fn.end).join('\n') });
    }
  }
  return out.filter((u) => u.code.split('\n').length >= 3 && u.code.split('\n').length <= MAX_LINES);
}

/** Build one bug-fix question with four answers, or null when nothing can be broken fairly. */
function build(db, { repoId, rnd = Math.random } = {}) {
  for (const u of shuffle(sources(db, repoId), rnd)) {
    const lines = u.code.split('\n');
    const all = mutants(u.code, u.language, { categories: ['basic', 'concurrency', 'lifetime'], headerLines: 1 }).filter((m) => !m.removed && m.mutatedLine);
    for (const m of shuffle(all, rnd)) {
      const i = m.originalLine - 1;
      const original = stripComment(lines[i], u.language);
      const bug = stripComment(m.mutatedLine, u.language);
      if (!original.trim() || original === bug || equivalent(original, bug)) continue;
      const tmpl = blankTemplates(original);
      const inTemplate = (w) => {
        const d = firstDiff(original, w);
        return d >= 0 && tmpl[d] === ' ' && original[d] !== ' ';
      };
      const masked = lang.mask(u.code, u.language);
      const called = new Set(masked.match(/\b[A-Za-z_]\w*(?=\s*[(<])/g) || []);
      const names = [...new Set((masked.match(/\b[A-Za-z_]\w*\b/g) || []).filter((w) => !KEYWORDS.has(w) && !called.has(w)))];
      const others = all.filter((x) => x.originalLine === m.originalLine && x !== m).map((x) => stripComment(x.mutatedLine, u.language));
      // Wrong fixes: leaving the bug in, other broken versions of the line, look-alikes.
      const wrong = [bug, ...others, ...shuffle(lookAlikes(original, names), rnd)].filter((w) => w !== original && !equivalent(original, w) && !inTemplate(w));
      const l = labelled(original, wrong, rnd);
      if (!l || Object.keys(l.choices).length < 4) continue;
      const lineNo = (u.start_line || 1) + i;
      const shown = lines.map((t, k) => (k === i ? m.mutatedLine : t)).join('\n');
      if (changesBehaviour(u, shown) === false) continue; // the same results either way: not a bug
      const track = lang.trackFor(u.language) || null;
      const q = {
        family: 'code',
        type: 'bug_fix',
        format: 'choice',
        title: 'Bug Hunter',
        topic: `${track || 'general'}/bugfix`,
        track,
        difficulty: m.difficulty || 'medium',
        grading: 'verified',
        xp: m.difficulty === 'hard' ? 15 : 10,
        prompt: `${ENEMY} "optimised" Claude's \`${u.name}\` (${u.file}) and slipped a bug into line ${lineNo}. Which line fixes it?`,
        code: shown,
        code_lang: u.language,
        code_file: u.file,
        code_start: u.start_line || 1,
        code_end: (u.start_line || 1) + lines.length - 1,
        ...l,
        explanation: `Line ${lineNo} was changed from \`${original.trim()}\` to \`${bug.trim()}\`. ${m.explanation || ''}`.trim(),
        evidence: `mutation ${m.op} on ${u.file}:${lineNo}`,
        meta: { selectedBy: 'Bug Hunter', op: m.op, line: lineNo },
        source: `bughunt:${u.file}:${u.name}`,
      };
      const id = store.insertQuestion(db, { ...q, repo_id: repoId || null, batch: `${nowIso()}#bughunt`, status: 'battle' });
      return store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', id));
    }
  }
  return null;
}

module.exports = { build, sources, demoUnits, ENEMY };
