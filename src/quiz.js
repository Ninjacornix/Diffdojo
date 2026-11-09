'use strict';
// `diffdojo quiz`: the terminal UI. Shows one question at a time with family,
// topic, difficulty, estimated time, grading type and code location; accepts
// an answer, `s` (skip), `z` (snooze), `b` (bad question) or `q` (quit).

const readline = require('readline');
const queue = require('./queue');
const grader = require('./grader');
const stats = require('./stats');
const rewards = require('./rewards');
const config = require('./config');
const { numbered } = require('./generators/code');
const { TRACK_NAMES } = require('./topics');

const FAMILY = { code: 'Code challenge', design: 'Design', questionnaire: 'Questionnaire' };
const TYPE = {
  seeded_bug: 'Seeded bug hunt', predict: 'Predict the output', kill_test: 'Write a killing test', warning: 'Warning explanation',
  boss: 'Boss fight', audit: 'Audit', data_structure: 'Data structure', architecture: 'Architecture', why: 'Why Claude did it',
  why_fits: 'Why this choice fits', critique: 'Critique', algorithm: 'Algorithm used', complexity: 'Complexity', pack: 'Concept quiz',
};
const GRADING = {
  verified: 'verified', session: 'from session', model: 'model-checked · half XP · disputable (b)', feedback: 'feedback only · 0 XP',
};
const HINT = {
  choice: 'Enter a letter', multiple_choice: 'Enter a letter', multi: 'Enter all letters that apply, e.g. a,c', multiple_select: 'Enter all letters that apply, e.g. a,c',
  ordering: 'Enter the letters in order, e.g. c,a,b', true_false: 'true/false, then a one-line reason', short_answer: 'Type the answer',
  output: 'Type the exact output', predict_output: 'Type the exact output', line: 'Line number, then optionally what goes wrong',
  lines: 'Line numbers, comma-separated', audit: 'Line number, or "none"', killtest: 'Path to your test file (relative to the repo root)',
  text: 'Your answer (one line; saved as a note)',
};

function palette(color) {
  const w = (code) => (t) => (color ? `\x1b[${code}m${t}\x1b[0m` : String(t));
  return { bold: w(1), dim: w(2), red: w(31), green: w(32), yellow: w(33), blue: w(34), cyan: w(36), magenta: w(35) };
}

function relativeNumbering(q) {
  return ['line', 'lines', 'audit', 'output', 'predict_output', 'killtest'].includes(q.format) || !q.code_start || q.family === 'questionnaire';
}

function render(q, { color = false } = {}) {
  const c = palette(color);
  const out = [];
  const label = `[${FAMILY[q.family] || q.family} · ${TYPE[q.type] || q.type} · ${GRADING[q.grading] || q.grading}]`;
  out.push(c.bold(c.cyan(label)));
  const loc = q.code_file ? ` · ${q.code_file}${q.code_start ? `:${q.code_start}${q.code_end && q.code_end !== q.code_start ? '-' + q.code_end : ''}` : ''}` : '';
  const xp = q.xp ? ` · ${q.xp} XP` : '';
  out.push(c.dim(`${q.topic || 'general'} · ${q.difficulty} · ~${Math.max(1, Math.round((q.est_seconds || 60) / 60))} min${xp}${loc}`));
  if (q.meta && q.meta.selectedBy) out.push(c.dim(`selected by ${q.meta.selectedBy}`));
  if (q.exam_id) out.push(c.magenta('Belt exam question'));
  out.push('');
  out.push(q.prompt);
  if (q.code) {
    out.push('');
    const start = relativeNumbering(q) ? 1 : q.code_start;
    out.push(numbered(q.code, start).split('\n').map((l) => {
      const i = l.indexOf('|');
      return c.dim(l.slice(0, i + 1)) + l.slice(i + 1);
    }).join('\n'));
  }
  if (q.choices) {
    out.push('');
    for (const [k, v] of Object.entries(q.choices)) out.push(`  ${c.bold(k + ')')} ${v}`);
  }
  out.push('');
  out.push(c.dim(`${HINT[q.format] || 'Answer'} · s skip · z snooze · b bad question · q quit`));
  return out.join('\n');
}

function renderResult(q, r, { color = false } = {}) {
  const c = palette(color);
  const out = [];
  if (r.correct === true) out.push(c.green(c.bold('✓ Correct')) + (r.xp ? c.green(`  +${r.xp} XP`) : ''));
  else if (r.correct === false) out.push(c.red(c.bold('✗ Not quite')));
  else out.push(c.blue('Saved.'));
  if (r.detail) out.push(r.detail);
  if (q.format === 'lines' && r.correct !== null) out.push(c.dim(`wrong guesses: ${r.wrong || 0}`));
  if (r.correct !== true || q.grading !== 'feedback') {
    if (q.choices && q.answer != null && r.correct === false) {
      const ans = Array.isArray(q.answer) ? q.answer.join(', ') : q.answer;
      out.push(`Answer: ${c.bold(ans)}`);
    } else if (r.correct === false && q.answer) {
      if (q.answer.lines) out.push(`Answer: line${q.answer.lines.length === 1 ? '' : 's'} ${q.answer.lines.length ? q.answer.lines.join(', ') : 'none (no bug seeded)'}`);
      else if (q.answer.output !== undefined) out.push(`Answer: ${c.bold(q.answer.output)}`);
      else if (q.answer.value !== undefined) out.push(`Answer: ${c.bold(q.answer.value)}`);
      else if (typeof q.answer === 'boolean') out.push(`Answer: ${c.bold(String(q.answer))}`);
    }
  }
  if (q.explanation) out.push(c.yellow(q.explanation));
  if (q.evidence && r.correct !== null) out.push(c.dim(`Evidence: ${q.evidence}`));
  if (r.feedback) out.push(c.blue(`Feedback (no XP): ${r.feedback}`));
  for (const t of r.trophies || []) out.push(c.magenta(`🏆 Trophy unlocked: ${t.name}`));
  if (r.examResult && r.examResult.finished_at) {
    out.push(r.examResult.passed
      ? c.green(c.bold(`🥋 Exam passed (${r.examResult.score}/${r.examResult.total}): ${r.examResult.target_belt} belt in ${TRACK_NAMES[r.examResult.track] || r.examResult.track}!`))
      : c.red(`Exam failed (${r.examResult.score}/${r.examResult.total}). Retake in ${rewards.RETAKE_HOURS} h with new questions.`));
  }
  return out.join('\n');
}

function lineReader(input = process.stdin) {
  const rl = readline.createInterface({ input, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt) {
      process.stdout.write(prompt);
      const r = await it.next();
      return r.done ? null : r.value;
    },
    close: () => rl.close(),
  };
}

/**
 * Run the interactive loop.
 * opts: {db, repoId, root, color, family, topic, review, examId, ids, once, count}
 */
async function run(opts) {
  const { db, repoId, root } = opts;
  const c = palette(opts.color);
  const io = opts.io || lineReader();
  const cfg = config.load(repoId);
  const startXp = rewards.totalXp(db);
  const trophiesBefore = new Set(db.all('SELECT id FROM trophies').map((r) => r.id));
  const seen = [];
  let answered = 0;
  const reviewList = opts.ids ? opts.ids.slice() : null;

  const newCount = (() => {
    const last = db.get("SELECT batch FROM questions WHERE status = 'queued' AND repo_id = ? ORDER BY batch DESC LIMIT 1", repoId || '');
    return last ? db.get("SELECT COUNT(*) AS n FROM questions WHERE status = 'queued' AND batch = ?", last.batch).n : 0;
  })();
  console.log(c.bold(stats.header(db, { newCount })));
  console.log('');

  for (;;) {
    if (opts.count && answered >= opts.count) break;
    let q;
    if (reviewList) {
      const id = reviewList.shift();
      q = id ? queue.get(db, id) : null;
    } else q = queue.next(db, { repoId, family: opts.family, topic: opts.topic, examId: opts.examId, exclude: seen });
    if (!q) {
      if (!answered) {
        console.log(opts.examId ? 'No exam questions left.' : opts.review ? 'Nothing to review: no missed questions.' :
          'No questions queued yet. They appear after Claude finishes a turn in an enabled repo (/diffdojo:start).\n' +
          'Meanwhile: diffdojo quiz --topic cpp/core   (or networking, python, dsa, javascript, cpp/concurrency)');
      }
      break;
    }
    seen.push(q.id);
    console.log(render(q, { color: opts.color }));
    const t0 = Date.now();
    const raw = await io.ask(c.bold('> '));
    if (raw === null) break;
    const a = raw.trim();
    if (a === 'q' || a === 'quit') break;
    if (a === 's') {
      if (q.exam_id) {
        await grader.answer(db, q, '', { mode: 'exam', root: rootFor(db, q, root), cfg: config.load(q.repo_id) });
        console.log(c.dim('Skipped (counts as wrong in an exam).\n'));
      } else {
        grader.skip(db, q);
        console.log(c.dim('Skipped.\n'));
      }
      continue;
    }
    if (a === 'z') {
      grader.snooze(db, q, cfg.snoozeMinutes);
      console.log(c.dim(`Snoozed for ${cfg.snoozeMinutes} min.\n`));
      continue;
    }
    if (a === 'b' || a.startsWith('b ')) {
      grader.bad(db, q, a.slice(2).trim());
      console.log(c.dim(q.grading === 'model' ? 'Disputed: removed.\n' : 'Marked as a bad question: excluded from stats. Thanks, this tunes the generator.\n'));
      continue;
    }
    if (!a && q.format !== 'text') {
      console.log(c.dim('(empty answer — try again, or s to skip)'));
      seen.pop();
      if (reviewList) reviewList.unshift(q.id);
      continue;
    }
    if (q.format === 'killtest') console.log(c.dim('Running your test against the original and the mutant…'));
    const mode = q.exam_id ? 'exam' : opts.review ? 'review' : q.type === 'boss' ? 'boss' : q.type === 'audit' ? 'audit' : 'normal';
    const r = await grader.answer(db, q, a, { mode, root: rootFor(db, q, root), cfg: config.load(q.repo_id || repoId), timeMs: Date.now() - t0 });
    answered++;
    console.log(renderResult(q, r, { color: opts.color }));
    console.log('');
    if (opts.once) break;
  }
  io.close();

  // Recap
  const earned = rewards.totalXp(db) - startXp;
  const newTrophies = db.all('SELECT * FROM trophies').filter((t) => !trophiesBefore.has(t.id));
  if (answered) {
    const s = stats.compute(db, {});
    const top = s.tracks[0];
    console.log(c.bold('Recap: ') + `${answered} answered · +${earned} XP` +
      (top ? ` · ${top.belt} belt ${top.name}${top.next ? ` (${top.xp}/${top.nextAt} to ${top.next})` : ''}` : '') +
      (newTrophies.length ? ` · trophies: ${newTrophies.map((t) => t.name.split(' — ')[0]).join(', ')}` : ''));
    for (const t of s.tracks) if (t.exam.ok && !t.exam.inProgress) console.log(c.green(`Belt exam unlocked: diffdojo exam ${t.track}  (${t.next} belt)`));
  }
  return { answered, earned };
}

function rootFor(db, q, fallback) {
  return (q.repo_id && queue.repoPath(db, q.repo_id)) || fallback;
}

module.exports = { run, render, renderResult, HINT, TYPE, FAMILY, GRADING, relativeNumbering };
