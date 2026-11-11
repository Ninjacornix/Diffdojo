'use strict';
// Technical questions about what Claude actually used. Pack questions that
// list `about` tokens (packs/in-code) are matched against the added lines of
// the change (comments and strings masked out), and asked about that line:
//   "Claude used `std::lock_guard` in src/net/retry_queue.cpp:18. What does std::lock_guard do?"

const packs = require('../packs');
const { mask, family } = require('../lang');
const { shuffle } = require('../util');

// Ask about where a thing is used, not the line that imports it.
const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|#\s*include\b|using\b|(const|let|var)\s+\w+\s*=\s*require\()/;

const LANG_OF = { c: 'cpp', cpp: 'cpp', python: 'python', javascript: 'javascript', typescript: 'javascript' };

function tokenRe(tok) {
  const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word-like edges only where the token itself starts/ends with a word character.
  const pre = /^[\w]/.test(tok) ? '(?<![\\w])' : '';
  const post = /[\w]$/.test(tok) ? '(?![\\w])' : '';
  return new RegExp(pre + esc + post);
}

let compiled = null;
function catalog() {
  if (!compiled) {
    compiled = packs
      .load()
      .questions.filter((q) => Array.isArray(q.about) && q.about.length && q.format === 'multiple_choice')
      .map((q) => ({ q, res: q.about.map((t) => ({ t, re: tokenRe(t) })) }));
  }
  return compiled;
}

/**
 * @param fileInfos [{file, lang, src, added:number[]}]
 * @returns question rows, at most `max`, one per pack question, varied tokens first
 */
function conceptQs(fileInfos, { max = 3, rnd = Math.random, exclude = new Set() } = {}) {
  const hits = [];
  const seen = new Set();
  for (const f of fileInfos) {
    const lang = LANG_OF[f.lang];
    if (!lang || !family(f.lang)) continue;
    const masked = mask(f.src, f.lang).split('\n');
    for (const ln of f.added) {
      const text = masked[ln - 1] || '';
      if (!text.trim() || IMPORT_LINE.test(text)) continue;
      for (const { q, res } of catalog()) {
        if (seen.has(q.id) || exclude.has(q.id)) continue;
        if (q.language && q.language !== lang) continue;
        const m = res.find((r) => r.re.test(text));
        if (!m) continue;
        seen.add(q.id);
        hits.push({ q, tok: m.t.replace(/[(<]$/, '').replace(/^\./, ''), file: f.file, line: ln, src: f.src });
      }
    }
  }
  return shuffle(hits, rnd)
    .slice(0, max)
    .map((h) => {
      const lines = h.src.split('\n');
      const from = Math.max(1, h.line - 2);
      const to = Math.min(lines.length, h.line + 2);
      return packs.toQuestion(h.q, {
        family: 'code',
        type: 'concept',
        title: 'Code concept',
        prompt: `Claude used \`${h.tok}\` in ${h.file}:${h.line}. ${h.q.question.trim()}`,
        code: lines.slice(from - 1, to).join('\n'),
        code_lang: h.q.language || null,
        code_file: h.file,
        code_start: from,
        code_end: to,
        meta: { pack: h.q.pack, about: h.tok, line: h.line, selectedBy: `\`${h.tok}\` in Claude's change`, references: h.q.references || [] },
      });
    });
}

module.exports = { conceptQs, tokenRe };
