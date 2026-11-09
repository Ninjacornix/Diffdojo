'use strict';
// `diffdojo badge`: an SVG + Markdown snippet with belts and trophies.
// Contains no code and no repo names; always marked "self-reported".

const fs = require('fs');
const path = require('path');
const rewards = require('./rewards');
const { TRACK_NAMES } = require('./topics');

const BELT_COLORS = {
  white: ['#f5f5f5', '#222'], yellow: ['#f7d417', '#222'], orange: ['#f28c18', '#222'], green: ['#2e9e44', '#fff'],
  blue: ['#2563eb', '#fff'], brown: ['#7a4a21', '#fff'], black: ['#111111', '#fff'],
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function summary(db) {
  const tracks = rewards.tracks(db)
    .map((t) => ({ track: t, name: TRACK_NAMES[t] || t, belt: rewards.beltOf(db, t) }))
    .filter((t) => t.belt !== 'white')
    .sort((a, b) => rewards.beltIndex(b.belt) - rewards.beltIndex(a.belt))
    .slice(0, 4);
  const bugs = db.get('SELECT COUNT(*) AS n FROM bug_reports WHERE confirmed = 1').n;
  const trophies = db.get('SELECT COUNT(*) AS n FROM trophies').n;
  return { tracks, bugs, trophies, overall: rewards.overallBelt(db) };
}

function text(s) {
  const parts = ['DiffDojo'];
  if (!s.tracks.length) parts.push(`${s.overall[0].toUpperCase()}${s.overall.slice(1)} belt`);
  for (const t of s.tracks) parts.push(`${t.belt[0].toUpperCase()}${t.belt.slice(1)} belt ${t.name}`);
  parts.push(`${s.bugs} bug${s.bugs === 1 ? '' : 's'} caught in AI-written code`);
  if (s.trophies) parts.push(`${s.trophies} troph${s.trophies === 1 ? 'y' : 'ies'}`);
  parts.push('self-reported');
  return parts.join(' · ');
}

function svg(s, style = 'flat') {
  const charW = 6.6;
  const segs = [{ label: 'DiffDojo', bg: '#3b3b3b', fg: '#fff' }];
  if (!s.tracks.length) {
    const [bg, fg] = BELT_COLORS[s.overall];
    segs.push({ label: `${s.overall} belt`, bg, fg });
  }
  for (const t of s.tracks) {
    const [bg, fg] = BELT_COLORS[t.belt];
    segs.push({ label: `${t.name}: ${t.belt}`, bg, fg });
  }
  segs.push({ label: `${s.bugs} bugs caught`, bg: '#8b1e3f', fg: '#fff' });
  if (s.trophies) segs.push({ label: `${s.trophies} trophies`, bg: '#a07c00', fg: '#fff' });
  segs.push({ label: 'self-reported', bg: '#666', fg: '#fff' });
  let x = 0;
  const parts = segs.map((sg) => {
    const w = Math.round(sg.label.length * charW + 14);
    const r = `<rect x="${x}" width="${w}" height="20" fill="${sg.bg}"/><text x="${x + w / 2}" y="14" fill="${sg.fg}" text-anchor="middle">${esc(sg.label)}</text>`;
    x += w;
    return r;
  });
  const radius = style === 'square' ? 0 : 3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="20" role="img" aria-label="${esc(text(s))}">
<title>${esc(text(s))}</title>
<clipPath id="r"><rect width="${x}" height="20" rx="${radius}" fill="#fff"/></clipPath>
<g clip-path="url(#r)" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
${parts.join('\n')}
</g>
</svg>
`;
}

function write(db, outDir, { style } = {}) {
  const s = summary(db);
  fs.mkdirSync(outDir, { recursive: true });
  const svgPath = path.join(outDir, 'diffdojo-badge.svg');
  fs.writeFileSync(svgPath, svg(s, style));
  const md = `![${text(s)}](diffdojo-badge.svg)`;
  fs.writeFileSync(path.join(outDir, 'diffdojo-badge.md'), md + '\n');
  return { svgPath, markdown: md, text: text(s) };
}

module.exports = { write, svg, text, summary };
