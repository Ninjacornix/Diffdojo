'use strict';
// Progress and project metrics: rank, XP, accuracy by topic/family/type,
// streak, trophies, bugs, generation counts and the "bad question" rate (S2).

const rewards = require('./rewards');
const { TRACK_NAMES } = require('./topics');

function pct(n, d) {
  return d ? Math.round((100 * n) / d) : null;
}

function compute(db, { repoId } = {}) {
  const repoFilter = repoId ? 'AND (q.repo_id = ? OR q.repo_id IS NULL)' : '';
  const rp = repoId ? [repoId] : [];
  const tracks = rewards.tracks(db).map((t) => {
    const belt = rewards.beltOf(db, t);
    const next = rewards.nextBelt(belt);
    const xp = rewards.trackXp(db, t);
    return { track: t, name: TRACK_NAMES[t] || t, belt, xp, next, nextAt: next ? rewards.THRESHOLDS[next] : null, exam: rewards.examStatus(db, t) };
  }).sort((a, b) => rewards.beltIndex(b.belt) - rewards.beltIndex(a.belt) || b.xp - a.xp);

  // Latest answer per question, excluding bad/disputed and feedback-only questions.
  const counted = db.all(
    `SELECT q.family, q.type, q.topic, q.track, q.grading, a.correct, a.time_ms
     FROM answers a JOIN questions q ON q.id = a.question_id
     WHERE a.correct IS NOT NULL AND q.status NOT IN ('bad', 'disputed') ${repoFilter}`, ...rp,
  );
  const group = (key) => {
    const m = new Map();
    for (const r of counted) {
      const k = r[key] || 'other';
      const g = m.get(k) || { key: k, answered: 0, correct: 0 };
      g.answered++;
      g.correct += r.correct ? 1 : 0;
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, accuracy: pct(g.correct, g.answered) })).sort((a, b) => b.answered - a.answered);
  };
  const verified = counted.filter((r) => r.grading === 'verified' || r.grading === 'session');
  const times = counted.map((r) => r.time_ms).filter(Boolean).sort((a, b) => a - b);
  const q = (status) => db.get(`SELECT COUNT(*) AS n FROM questions q WHERE status = ? ${repoFilter}`, status, ...rp).n;
  const generated = db.get(`SELECT COUNT(*) AS n FROM questions q WHERE 1=1 ${repoFilter}`, ...rp).n;
  const bad = q('bad') + q('disputed');
  const answeredQ = q('answered');
  return {
    overallBelt: rewards.overallBelt(db),
    totalXp: rewards.totalXp(db),
    streak: rewards.streak(db),
    streakBonus: Math.round(100 * rewards.streakBonus(rewards.streak(db))),
    tracks,
    accuracy: { verified: pct(verified.filter((r) => r.correct).length, verified.length), answered: counted.length },
    byFamily: group('family'),
    byType: group('type'),
    byTopic: group('topic').slice(0, 15),
    counts: { generated, answered: answeredQ, queued: q('queued'), skipped: q('skipped'), snoozed: q('snoozed'), bad },
    badRate: pct(bad, answeredQ + bad),
    medianAnswerSec: times.length ? Math.round(times[Math.floor(times.length / 2)] / 1000) : null,
    bugs: db.all('SELECT id, title, file, report_path, track, created_at FROM bug_reports WHERE confirmed = 1 ORDER BY id DESC'),
    trophies: db.all('SELECT * FROM trophies ORDER BY awarded_at'),
    unlocks: tracks.map((t) => ({ track: t.track, features: rewards.UNLOCKS.filter((u) => rewards.beltIndex(t.belt) >= rewards.beltIndex(u[0])).map((u) => u[2]) })),
    xpToday: db.get("SELECT COALESCE(SUM(amount),0) AS n FROM xp_events WHERE day = ?", require('./util').dayKey()).n,
  };
}

const BELT_ANSI = { white: 97, yellow: 93, orange: 33, green: 92, blue: 94, brown: 31, black: 90 };

function format(s, { color = false } = {}) {
  const c = (code, t) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const belt = (b) => c(BELT_ANSI[b] || 0, `${b[0].toUpperCase()}${b.slice(1)} belt`);
  const lines = [];
  lines.push(c(1, 'DiffDojo') + ` · overall ${belt(s.overallBelt)} · ${s.totalXp.toLocaleString('en-US')} XP · streak ${s.streak} day${s.streak === 1 ? '' : 's'}${s.streakBonus ? ` (+${s.streakBonus}% XP)` : ''}`);
  lines.push('');
  if (!s.tracks.length) lines.push('No XP yet. Run `diffdojo quiz` in a second terminal while Claude works.');
  for (const t of s.tracks) {
    const prog = t.next ? `${t.xp.toLocaleString('en-US')} / ${t.nextAt.toLocaleString('en-US')} XP to ${t.next}` : `${t.xp.toLocaleString('en-US')} XP`;
    const exam = t.exam.ok ? c(92, ' · exam available: diffdojo exam ' + t.track) : '';
    lines.push(`  ${t.name.padEnd(30)} ${belt(t.belt).padEnd(color ? 22 : 13)} ${prog}${exam}`);
  }
  lines.push('');
  lines.push(`Accuracy on verified questions: ${s.accuracy.verified == null ? '—' : s.accuracy.verified + '%'} over ${s.accuracy.answered} answers` +
    (s.medianAnswerSec != null ? ` · median ${s.medianAnswerSec}s per answer` : ''));
  if (s.byFamily.length) lines.push('  by family: ' + s.byFamily.map((g) => `${g.key} ${g.accuracy}% (${g.answered})`).join(' · '));
  if (s.byTopic.length) {
    lines.push('  by topic:');
    for (const g of s.byTopic.slice(0, 8)) lines.push(`    ${g.key.padEnd(34)} ${String(g.accuracy).padStart(3)}%  (${g.correct}/${g.answered})`);
  }
  lines.push('');
  lines.push(`Questions: ${s.counts.generated} generated · ${s.counts.answered} answered · ${s.counts.queued} queued · ${s.counts.skipped} skipped · ${s.counts.bad} marked bad${s.badRate != null ? ` (${s.badRate}%)` : ''}`);
  lines.push(`Real bugs caught in Claude's code: ${s.bugs.length}`);
  for (const b of s.bugs.slice(0, 5)) lines.push(`  • ${b.title} (${b.file || '?'}) → ${b.report_path}`);
  if (s.trophies.length) {
    lines.push('');
    lines.push('Trophies:');
    for (const t of s.trophies) lines.push(`  🏆 ${t.name}${t.link ? ` → ${t.link}` : ''}`);
  }
  const unl = s.unlocks.filter((u) => u.features.length);
  if (unl.length) {
    lines.push('');
    lines.push('Unlocked:');
    for (const u of unl) lines.push(`  ${u.track}: ${u.features.join('; ')}`);
  }
  return lines.join('\n');
}

/** One-line header shown by `diffdojo quiz`. */
function header(db, { newCount = 0, repoId } = {}) {
  const s = compute(db, { repoId });
  const top = s.tracks[0];
  const parts = [];
  if (newCount) parts.push(`${newCount} new question${newCount === 1 ? '' : 's'} from your last change`);
  if (top) parts.push(`${top.belt[0].toUpperCase()}${top.belt.slice(1)} belt ${top.name} (${top.xp.toLocaleString('en-US')}${top.nextAt ? ' / ' + top.nextAt.toLocaleString('en-US') : ''})`);
  parts.push(`streak ${s.streak} day${s.streak === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

module.exports = { compute, format, header };
