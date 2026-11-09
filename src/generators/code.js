'use strict';
// Family A: code challenges built from code Claude just changed.

const fs = require('fs');
const path = require('path');
const { mutants } = require('../mutate');
const { analyze } = require('../lang/structure');
const { syntaxOk, runTests } = require('../runner');
const { mutantChangesBehaviour } = require('./predict');
const { which, run, shuffle, pick } = require('../util');

const XP_BUG = { easy: 10, medium: 20, hard: 30 };
const DIFF_RANK = { easy: 0, medium: 1, hard: 2 };

function numbered(code, start = 1) {
  const lines = code.replace(/\n+$/, '').split('\n');
  const w = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(w)}| ${l}`).join('\n');
}

function replaceRange(src, start, end, code) {
  const lines = src.split('\n');
  return lines.slice(0, start - 1).concat(code.split('\n'), lines.slice(end)).join('\n');
}

/** Read the unit's current file and locate the function in it (it may have moved). */
function locate(root, unit) {
  let src;
  try {
    src = fs.readFileSync(path.join(root, unit.file), 'utf8');
  } catch {
    return null;
  }
  const lines = src.split('\n');
  const firstLine = unit.code.split('\n')[0];
  let start = unit.start_line;
  if (lines[start - 1] !== firstLine) {
    const idx = lines.indexOf(firstLine);
    if (idx < 0) return null;
    start = idx + 1;
  }
  const end = start + unit.code.split('\n').length - 1;
  if (lines.slice(start - 1, end).join('\n') !== unit.code) return null;
  return { src, start, end };
}

/**
 * A failing test suite tells us nothing about mutants (e.g. pytest exits 5 when
 * it collects no tests), so the suite must pass on the original code first.
 * Run once per batch and cached on the budget object.
 */
function testBaselineOk(ctx, budget) {
  if (budget.baseline === undefined) {
    if (budget.testRuns <= 0) return false;
    budget.testRuns--;
    const r = runTests(ctx.root, ctx.cfg.testCommand, {}, { timeoutSec: ctx.cfg.testTimeoutSec });
    budget.baseline = !!(r.ran && r.passed);
  }
  return budget.baseline;
}

/**
 * Check that a mutant really changes something.
 * Returns {keep: bool, how: 'inputs'|'tests'|'syntax'|'unverified', survived?: bool}
 */
function validateMutant(ctx, unit, m, budget) {
  const loc = ctx.root ? locate(ctx.root, unit) : null;
  const mutatedFile = loc ? replaceRange(loc.src, loc.start, loc.end, m.code) : null;
  if (mutatedFile && syntaxOk(mutatedFile, unit.language) === false) return { keep: false, how: 'syntax' };
  if (loc) {
    const structure = analyze(loc.src, unit.language);
    const fn = structure.functions.find((f) => f.start === loc.start && f.name === unit.name);
    if (fn) {
      const changed = mutantChangesBehaviour(fn, unit.language, structure, loc.src, m.code, { timeoutSec: ctx.cfg.snippetTimeoutSec });
      if (changed === false) return { keep: false, how: 'inputs' };
      if (changed === true) return { keep: true, how: 'inputs', mutatedFile };
    }
  }
  if (loc && ctx.cfg.testCommand && budget && budget.testRuns > 0 && Date.now() < budget.deadline && testBaselineOk(ctx, budget)) {
    budget.testRuns--;
    const r = runTests(ctx.root, ctx.cfg.testCommand, { [unit.file]: mutatedFile }, { timeoutSec: ctx.cfg.testTimeoutSec });
    if (r.ran) return { keep: true, how: r.passed ? 'unverified' : 'tests', survived: r.passed, mutatedFile };
  }
  return { keep: true, how: mutatedFile ? 'syntax' : 'unverified', mutatedFile };
}

function pickMutant(list, wantDifficulty, rnd) {
  if (!list.length) return null;
  let pool = list;
  if (wantDifficulty) {
    const exact = list.filter((m) => m.difficulty === wantDifficulty);
    const atLeast = list.filter((m) => DIFF_RANK[m.difficulty] >= DIFF_RANK[wantDifficulty]);
    pool = exact.length ? exact : atLeast.length ? atLeast : list;
  }
  return pick(pool, rnd);
}

function trackOfUnit(unit) {
  return JSON.parse(unit.tracks || '["general"]')[0];
}

/** Seeded bug hunt question from a code unit. */
function seededBug(ctx, unit, { categories = ['basic'], wantDifficulty, maxDifficulty, rnd = Math.random, budget } = {}) {
  const lines = unit.code.split('\n');
  if (lines.length < 3 || lines.length > ctx.cfg.maxExcerptLines) return null;
  let list = mutants(unit.code, unit.language, { categories, custom: categories.includes('custom') });
  if (maxDifficulty) list = list.filter((m) => DIFF_RANK[m.difficulty] <= DIFF_RANK[maxDifficulty]);
  for (let attempt = 0; attempt < 4 && list.length; attempt++) {
    const m = pickMutant(list, wantDifficulty, rnd);
    list = list.filter((x) => x !== m);
    const v = validateMutant(ctx, unit, m, budget);
    if (!v.keep) continue;
    const track = m.category === 'concurrency' ? 'concurrency' : trackOfUnit(unit);
    const ev = m.removed ? `- ${m.original.trim()}  (line removed)` : `- ${m.original.trim()}\n+ ${m.mutatedLine.trim()}`;
    return {
      family: 'code',
      type: 'seeded_bug',
      format: 'line',
      topic: `${trackOfUnit(unit)}/mutation/${m.op}`,
      track,
      difficulty: m.difficulty,
      grading: 'verified',
      xp: XP_BUG[m.difficulty],
      est_seconds: m.difficulty === 'hard' ? 180 : 90,
      title: `Code challenge · Seeded bug hunt`,
      prompt: `One line was changed in this copy of \`${unit.name}()\` from ${unit.file}:${unit.start_line}-${unit.end_line}. ` +
        `Which line? Enter its number (optionally followed by what goes wrong at runtime).`,
      code: m.code,
      code_lang: unit.language,
      code_file: unit.file,
      code_start: unit.start_line,
      code_end: unit.end_line,
      answer: { lines: m.acceptLines },
      explanation: m.explanation,
      evidence: `Seeded change (${m.op}):\n${ev}`,
      meta: { op: m.op, category: m.category, unitId: unit.id, validated: v.how, survivedTests: !!v.survived, removed: m.removed },
    };
  }
  return null;
}

/** "Write a killing test": user writes a test that passes on the original and fails on a hidden mutant. */
function killTest(ctx, unit, { categories = ['basic'], rnd = Math.random, budget } = {}) {
  if (!ctx.cfg.testCommand) return null;
  const loc = locate(ctx.root, unit);
  if (!loc) return null;
  let list = mutants(unit.code, unit.language, { categories }).filter((m) => !m.removed || m.op !== 'drop-lock');
  for (let attempt = 0; attempt < 6 && list.length; attempt++) {
    const m = pick(list, rnd);
    list = list.filter((x) => x !== m);
    // The suite must pass on the original, and the mutant must SURVIVE the existing
    // suite; otherwise there is nothing for the user's new test to catch.
    if (!budget || !testBaselineOk(ctx, budget) || budget.testRuns <= 0 || Date.now() > budget.deadline) return null;
    const mutatedFile = replaceRange(loc.src, loc.start, loc.end, m.code);
    if (syntaxOk(mutatedFile, unit.language) === false) continue;
    // Drop mutants that behave identically on sample inputs (equivalent mutants can't be killed).
    const st = analyze(loc.src, unit.language);
    const sfn = st.functions.find((f) => f.start === loc.start && f.name === unit.name);
    if (sfn && mutantChangesBehaviour(sfn, unit.language, st, loc.src, m.code, { timeoutSec: ctx.cfg.snippetTimeoutSec }) === false) continue;
    budget.testRuns--;
    const r = runTests(ctx.root, ctx.cfg.testCommand, { [unit.file]: mutatedFile }, { timeoutSec: ctx.cfg.testTimeoutSec });
    if (!r.ran || !r.passed) continue; // existing tests already kill it (or the run failed)
    const v = { how: 'survived' };
    const hint = {
      boundary: 'a comparison boundary', equality: 'an equality check', logic: 'a logical operator', 'py-logic': 'a logical operator',
      arith: 'an arithmetic operator', incdec: 'an increment', negation: 'a negation', 'py-not': 'a negation', 'bool-return': 'a returned boolean',
      'loop-start': 'a loop bound', 'py-range': 'a loop bound', 'swap-args': 'argument order', 'drop-jump': 'control flow', 'py-none': 'a None check',
      'py-slice': 'an index',
    }[m.op] || 'one line';
    return {
      family: 'code',
      type: 'kill_test',
      format: 'killtest',
      topic: `${trackOfUnit(unit)}/testing`,
      track: trackOfUnit(unit),
      difficulty: 'hard',
      grading: 'verified',
      xp: 30,
      est_seconds: 600,
      title: 'Code challenge · Write a killing test',
      prompt: `DiffDojo hid a mutant of \`${unit.name}()\` (${unit.file}:${loc.start}-${loc.end}) that changes ${hint}. ` +
        `Write a test in your project's test suite that passes on the current code and fails on the mutant, then enter the test file's path. ` +
        `It is graded by running \`${ctx.cfg.testCommand}\` against both versions in a temporary copy of the repo.`,
      code: unit.code,
      code_lang: unit.language,
      code_file: unit.file,
      code_start: loc.start,
      code_end: loc.end,
      answer: { file: unit.file, start: loc.start, end: loc.end, mutantCode: m.code },
      explanation: m.explanation,
      evidence: m.removed ? `- ${m.original.trim()}  (removed)` : `- ${m.original.trim()}\n+ ${m.mutatedLine.trim()}`,
      meta: { op: m.op, unitId: unit.id, validated: v.how },
    };
  }
  return null;
}

/** Boss fight: several changed functions of one file with 2-3 hidden mutations. */
function bossFight(ctx, units, { categories = ['basic', 'concurrency', 'lifetime'], rnd = Math.random } = {}) {
  const byFile = new Map();
  for (const u of units) {
    if (!byFile.has(u.file)) byFile.set(u.file, []);
    byFile.get(u.file).push(u);
  }
  const candidates = [...byFile.values()].filter((us) => us.reduce((n, u) => n + u.code.split('\n').length, 0) >= 12);
  if (!candidates.length) return null;
  const group = pick(candidates, rnd).sort((a, b) => a.start_line - b.start_line).slice(0, 6);
  // Build one listing: functions separated by a blank line, numbered sequentially.
  const blocks = [];
  let offset = 0;
  for (const u of group) {
    const n = u.code.split('\n').length;
    if (offset + n > 150) break;
    blocks.push({ u, offset });
    offset += n + 1;
  }
  const all = [];
  for (const b of blocks) {
    for (const m of mutants(b.u.code, b.u.language, { categories })) if (!m.removed) all.push({ m, b });
  }
  const chosen = [];
  for (const c of shuffle(all, rnd)) {
    const absLine = c.b.offset + c.m.line;
    if (chosen.some((x) => Math.abs(x.absLine - absLine) < 2)) continue;
    chosen.push({ ...c, absLine });
    if (chosen.length === 3) break;
  }
  if (chosen.length < 2) return null;
  const codes = blocks.map((b) => b.u.code.split('\n'));
  for (const c of chosen) codes[blocks.indexOf(c.b)][c.m.line - 1] = c.m.mutatedLine;
  const listing = codes.map((ls) => ls.join('\n')).join('\n\n');
  const u0 = group[0];
  return {
    family: 'code',
    type: 'boss',
    format: 'lines',
    topic: `${trackOfUnit(u0)}/boss`,
    track: trackOfUnit(u0),
    difficulty: 'hard',
    grading: 'verified',
    xp: 100,
    est_seconds: 900,
    title: 'Boss fight',
    prompt: `${chosen.length} lines were changed in these functions from ${u0.file}. Find all of them: enter the line numbers separated by commas. ` +
      `You may name at most one wrong line and still clear it; a perfect answer earns Clean Sweep.`,
    code: listing,
    code_lang: u0.language,
    code_file: u0.file,
    code_start: null,
    answer: { lines: chosen.map((c) => c.absLine).sort((a, b) => a - b), count: chosen.length },
    explanation: chosen.map((c) => `Line ${c.absLine}: ${c.m.explanation}`).join('\n'),
    evidence: chosen.map((c) => `line ${c.absLine}: - ${c.m.original.trim()}  + ${c.m.mutatedLine.trim()}`).join('\n'),
    meta: { units: group.map((u) => u.id) },
  };
}

/** Audit mode: a Claude change that may or may not contain a seeded bug. */
function audit(ctx, unit, { categories = ['basic', 'concurrency', 'lifetime'], rnd = Math.random } = {}) {
  const clean = rnd() < 0.4;
  const base = {
    family: 'code', type: 'audit', format: 'audit', topic: `${trackOfUnit(unit)}/audit`, track: trackOfUnit(unit),
    difficulty: 'hard', grading: 'verified', xp: 20, est_seconds: 240, title: 'Audit mode',
    prompt: `Audit \`${unit.name}()\` from ${unit.file}:${unit.start_line}-${unit.end_line}. DiffDojo may have seeded one bug, or none. ` +
      'Enter the line number of the seeded bug, or "none" if this is exactly what Claude wrote.',
    code_lang: unit.language, code_file: unit.file, code_start: unit.start_line, code_end: unit.end_line,
    meta: { unitId: unit.id },
  };
  if (!clean) {
    const m = pick(mutants(unit.code, unit.language, { categories }).filter((x) => !x.removed), rnd);
    if (m) {
      return { ...base, code: m.code, answer: { lines: [m.line] }, explanation: m.explanation, evidence: `- ${m.original.trim()}\n+ ${m.mutatedLine.trim()}` };
    }
  }
  return { ...base, code: unit.code, answer: { lines: [] }, explanation: 'No bug was seeded: this is the code exactly as Claude wrote it.', evidence: 'unchanged' };
}

// ---- warning explanation

const WARNING_POOL = {
  cpp: [
    'unused variable', 'comparison of integer expressions of different signedness', 'control reaches end of non-void function',
    'unused parameter', 'suggest parentheses around assignment used as truth value', 'variable is used uninitialized',
    'implicit conversion loses integer precision', 'enumeration value not handled in switch', 'statement has no effect',
    'reference to local variable returned', 'moving a temporary object prevents copy elision', 'this statement may fall through',
  ],
  python: [
    'imported but unused', 'local variable is assigned to but never used', 'undefined name', 'redefinition of unused name',
    'f-string is missing placeholders', 'do not use bare except', 'comparison to None should be "is None"',
    'mutable default argument', 'ambiguous variable name', 'loop control variable not used within loop body',
  ],
  javascript: [
    'is assigned a value but never used', 'is defined but never used', 'Unexpected console statement', 'Expected === and instead saw ==',
    'Unreachable code', 'Unexpected constant condition', 'Promise returned is not awaited', 'Missing return type on function',
  ],
};

function parseDiagnostics(text) {
  const out = [];
  const re = /^(.*?):(\d+):(?:(\d+):)?\s*(warning|error|note)?:?\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m[4] === 'note') continue;
    out.push({ file: m[1].trim(), line: +m[2], message: m[5].trim() });
  }
  return out;
}

function lintFile(ctx, file, lang) {
  const abs = path.join(ctx.root, file);
  if (ctx.cfg.lintCommand) {
    const r = require('../util').runShell(`${ctx.cfg.lintCommand} "${file}"`, { cwd: ctx.root, timeout: 60000 });
    return { tool: ctx.cfg.lintCommand.split(/\s+/)[0], diags: parseDiagnostics(r.stdout + '\n' + r.stderr) };
  }
  if (lang === 'cpp' || lang === 'c') {
    const cc = lang === 'c' ? which('gcc') || which('clang') : which('g++') || which('clang++');
    if (!cc) return null;
    const env = { PATH: path.dirname(cc) + path.delimiter + process.env.PATH };
    const r = run(cc, ['-fsyntax-only', '-Wall', '-Wextra', `-I${path.dirname(abs)}`, `-I${ctx.root}`, `-I${path.join(ctx.root, 'include')}`, `-I${path.join(ctx.root, 'src')}`, ...(lang === 'cpp' ? ['-std=c++20'] : []), abs], { cwd: ctx.root, timeout: 60000, env });
    return { tool: path.basename(cc).replace(/\.exe$/i, ''), diags: parseDiagnostics(r.stderr).filter((d) => /warning/i.test(r.stderr)) };
  }
  if (lang === 'python' && which('ruff')) {
    const r = run('ruff', ['check', '--output-format', 'concise', '--no-cache', file], { cwd: ctx.root, timeout: 60000 });
    return { tool: 'ruff', diags: parseDiagnostics(r.stdout) };
  }
  return null;
}

/** Warning-explanation questions for changed lines of a file. */
function warnings(ctx, file, lang, changedLines, src, { rnd = Math.random, max = 1 } = {}) {
  const res = lintFile(ctx, file, lang);
  if (!res) return [];
  const changed = new Set(changedLines);
  const norm = (f) => path.resolve(ctx.root, f).toLowerCase();
  const target = norm(file);
  const diags = res.diags.filter((d) => norm(d.file) === target && changed.has(d.line) && !/error/i.test(d.message.slice(0, 6)));
  const out = [];
  const lines = src.split('\n');
  const poolKey = lang === 'c' ? 'cpp' : lang === 'typescript' ? 'javascript' : lang;
  for (const d of shuffle(diags, rnd).slice(0, max)) {
    const msg = d.message.replace(/\s*\[-W[\w-]+(=\w+)?\]$/, '').replace(/^warning:\s*/i, '');
    const short = msg.replace(/[‘’'"`][^‘’'"`]*[‘’'"`]/g, '').replace(/\s+/g, ' ').trim();
    const distract = shuffle((WARNING_POOL[poolKey] || []).filter((w) => !short.toLowerCase().includes(w.toLowerCase()) && !w.toLowerCase().includes(short.toLowerCase().slice(0, 20))), rnd).slice(0, 3);
    if (distract.length < 3) continue;
    const keys = ['a', 'b', 'c', 'd'];
    const opts = shuffle([msg, ...distract], rnd);
    const choices = Object.fromEntries(opts.map((o, i) => [keys[i], o]));
    const from = Math.max(1, d.line - 4);
    const to = Math.min(lines.length, d.line + 4);
    out.push({
      family: 'code',
      type: 'warning',
      format: 'choice',
      topic: `${poolKey}/warnings`,
      track: require('../lang').trackFor(lang),
      difficulty: 'easy',
      grading: 'verified',
      xp: 5,
      est_seconds: 45,
      title: 'Code challenge · Warning explanation',
      prompt: `${res.tool} reports a diagnostic on line ${d.line} of ${file} (in Claude's change). Which one?`,
      code: lines.slice(from - 1, to).join('\n'),
      code_lang: lang,
      code_file: file,
      code_start: from,
      code_end: to,
      choices,
      answer: keys[opts.indexOf(msg)],
      explanation: `${res.tool} says: ${d.message}`,
      evidence: `${file}:${d.line}: ${d.message}`,
      meta: { tool: res.tool },
    });
  }
  return out;
}

module.exports = { seededBug, killTest, bossFight, audit, warnings, numbered, locate, replaceRange, validateMutant, parseDiagnostics, XP_BUG };
