'use strict';
// `diffdojo share`: put your score card in a GitHub Gist on your own account,
// through the GitHub CLI (`gh`) and its login, so DiffDojo never handles a
// token. Only numbers are sent: XP, belts, streak, accuracy, trophies and how
// many projects; never code, questions or project names (unless --projects).
// Sharing again updates the same gist; --remove deletes it.

const path = require('path');
const { home, readJson, writeJson, which, nowIso, run } = require('./util');
const stats = require('./stats');
const badge = require('./badge');

const FILES = { card: 'diffdojo-score.md', data: 'diffdojo-score.json', badge: 'diffdojo-badge.svg' };

function stateFile() {
  return path.join(home(), 'share.json');
}

/** Where the card was shared last, if anywhere: { id, url, at }. */
function status() {
  return readJson(stateFile(), null);
}

/** Exactly what would be published. */
function card(db, { projects = false } = {}) {
  const st = stats.compute(db, {});
  const all = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(correct), 0) AS ok FROM answers WHERE correct IS NOT NULL');
  const b = require('./battle').load();
  const data = {
    tool: 'DiffDojo',
    version: require('../package.json').version,
    updated: nowIso().slice(0, 10),
    selfReported: true,
    belt: st.overallBelt,
    xp: st.totalXp,
    streak: st.streak,
    answered: all.n,
    accuracy: all.n ? Math.round((100 * all.ok) / all.n) : null,
    tracks: st.tracks.filter((t) => t.xp > 0).map((t) => ({ name: t.name, belt: t.belt, xp: t.xp })),
    trophies: st.trophies.map((t) => require('./rewards').TROPHIES[t.id] || t.id),
    battleWins: b.wins || {},
    projects: projects
      ? st.projects.filter((p) => p.xp > 0).map((p) => ({ name: path.basename(p.path || ''), xp: p.xp, answered: p.answered }))
      : st.projects.filter((p) => p.answered > 0).length,
  };
  const s = badge.summary(db);
  return { data, badgeSvg: badge.svg(s), badgeText: badge.text(s) };
}

function markdown(c, badgeUrl) {
  const d = c.data;
  const lines = [
    '# DiffDojo score',
    '',
    badgeUrl ? `![${c.badgeText}](${badgeUrl})` : '',
    '',
    `**${d.xp.toLocaleString('en-US')} XP** · ${d.belt} belt · streak ${d.streak} day${d.streak === 1 ? '' : 's'} · ${d.answered} answer${d.answered === 1 ? '' : 's'}${d.accuracy === null ? '' : `, ${d.accuracy}% right`}`,
    '',
  ];
  if (d.tracks.length) lines.push('| Topic | Belt | XP |', '|---|---|---|', ...d.tracks.map((t) => `| ${t.name} | ${t.belt} | ${t.xp} |`), '');
  if (d.trophies.length) lines.push('**Trophies**', '', ...d.trophies.map((t) => `- ${t}`), '');
  const wins = Object.entries(d.battleWins).filter(([, n]) => n);
  if (wins.length) lines.push(`**Battles cleared:** ${wins.map(([m, n]) => `${m} x${n}`).join(', ')}`, '');
  if (Array.isArray(d.projects)) lines.push('**Projects**', '', ...d.projects.map((p) => `- ${p.name}: ${p.xp} XP, ${p.answered} answers`), '');
  else lines.push(`Across ${d.projects} project${d.projects === 1 ? '' : 's'}.`, '');
  lines.push(`_Self-reported by [DiffDojo](https://github.com/Ninjacornix/Diffdojo) ${d.version}, updated ${d.updated}._`, '');
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

/** The lines shown before publishing, so the person sees what leaves their machine. */
function preview(db, opts = {}) {
  const c = card(db, opts);
  return { text: markdown(c, null), data: c.data, shared: status() };
}

/** Run `gh` (a .cmd shim on some Windows installs), JSON on stdin. */
function gh(args, input) {
  const bin = which('gh');
  if (!bin) return { code: -1, stdout: '', stderr: 'gh not found' };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${bin}"`, ...args], { input, timeout: 60000 });
  }
  return run(bin, args, { input, timeout: 60000 });
}

const NO_GH = 'Sharing uses the GitHub CLI: install it from https://cli.github.com, run `gh auth login`, then share again.';

function parse(r) {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** Publish (or update) the gist. Returns { url, id, created } or { error }. */
function publish(db, { projects = false, secret = false } = {}) {
  if (!which('gh')) return { error: NO_GH };
  const c = card(db, { projects });
  const prev = status();
  const files = (badgeUrl) => ({
    [FILES.card]: { content: markdown(c, badgeUrl) },
    [FILES.data]: { content: JSON.stringify(c.data, null, 2) + '\n' },
    [FILES.badge]: { content: c.badgeSvg },
  });
  const rawBadge = (g) => `https://gist.githubusercontent.com/${g.owner && g.owner.login}/${g.id}/raw/${FILES.badge}`;
  let g = null;
  let created = false;
  if (prev && prev.id) {
    const r = gh(['api', '-X', 'PATCH', `gists/${prev.id}`, '--input', '-'], JSON.stringify({ files: files(prev.badgeUrl || null) }));
    g = r.code === 0 ? parse(r) : null;
    if (!g && !/404|Not Found/i.test(r.stderr + r.stdout)) return { error: ghError(r) };
  }
  if (!g) {
    const r = gh(['api', '-X', 'POST', 'gists', '--input', '-'], JSON.stringify({ description: 'My DiffDojo score (self-reported)', public: !secret, files: files(null) }));
    g = r.code === 0 ? parse(r) : null;
    if (!g || !g.id) return { error: ghError(r) };
    created = true;
    // Now the badge has a URL: point the card at it.
    const r2 = gh(['api', '-X', 'PATCH', `gists/${g.id}`, '--input', '-'], JSON.stringify({ files: { [FILES.card]: { content: markdown(c, rawBadge(g)) } } }));
    if (r2.code === 0) g = parse(r2) || g;
  }
  const state = { id: g.id, url: g.html_url, badgeUrl: rawBadge(g), at: nowIso(), public: g.public !== false };
  writeJson(stateFile(), state);
  return { ...state, created };
}

function ghError(r) {
  const msg = `${r.stderr || ''} ${r.stdout || ''}`.trim();
  if (/auth|login|401|credentials/i.test(msg)) return 'The GitHub CLI is not logged in: run `gh auth login`, then share again.';
  if (r.code === -1) return NO_GH;
  return `GitHub refused the gist: ${msg.slice(0, 200)}`;
}

/** Delete the shared gist. */
function remove() {
  const prev = status();
  if (!prev || !prev.id) return { removed: false, error: 'Nothing is shared.' };
  if (!which('gh')) return { removed: false, error: NO_GH };
  const r = gh(['api', '-X', 'DELETE', `gists/${prev.id}`]);
  if (r.code !== 0 && !/404|Not Found/i.test(r.stderr + r.stdout)) return { removed: false, error: ghError(r) };
  require('fs').rmSync(stateFile(), { force: true });
  return { removed: true, url: prev.url };
}

module.exports = { card, markdown, preview, publish, remove, status, FILES };
