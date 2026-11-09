'use strict';
// Rationale extractor. Reads the local session transcript (JSONL) for the turn
// that just ended and pulls Claude's stated reasons: explanation text, todo
// items and commit messages. Only a few sentences are kept, never the
// transcript. The format is not a public API, so the parser checks the shape
// it knows (Claude Code 2.x: {type:"user"|"assistant", message:{content}})
// and returns [] on anything unexpected.

const fs = require('fs');
const path = require('path');
const { hasSecret } = require('./secrets');

const KNOWN_MAJOR = /^2\./; // Claude Code transcript versions this parser understands
const REASON = /\b(because|so that|so it|so the|in order to|to avoid|to prevent|to keep|to make sure|to ensure|since|otherwise|which (?:ensures|prevents|avoids|keeps|means)|this (?:ensures|prevents|avoids|keeps|means)|that way|instead of|rather than|the reason)\b/i;
const MAX_SENTENCES = 8;
const MAX_BYTES = 30 * 1024 * 1024;

function isPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return false;
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') return !/^<(?:command-|local-command|system-reminder)/.test(c.trim());
  if (Array.isArray(c)) return c.some((b) => b.type === 'text') && !c.some((b) => b.type === 'tool_result');
  return false;
}

function splitSentences(text) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*|__|^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ');
  return cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9`"(])/).map((s) => s.trim()).filter((s) => s.length >= 25 && s.length <= 400);
}

/**
 * Extract reasons for the last turn.
 * @param {string} transcriptPath
 * @param {{files?: string[], symbols?: string[], lastAssistantMessage?: string}} ctx
 * @returns {{turn:number, sentences:Array<{sentence, ref, files:string[]}>}} or null when unparseable
 */
function extract(transcriptPath, ctx = {}) {
  let entries = [];
  try {
    const st = fs.statSync(transcriptPath);
    let text;
    if (st.size > MAX_BYTES) {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(MAX_BYTES);
      fs.readSync(fd, buf, 0, MAX_BYTES, st.size - MAX_BYTES);
      fs.closeSync(fd);
      text = buf.toString('utf8');
      text = text.slice(text.indexOf('\n') + 1);
    } else text = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* partial line */
      }
    }
  } catch {
    if (ctx.lastAssistantMessage) entries = [];
    else return null;
  }

  const versions = entries.map((e) => e.version).filter(Boolean);
  if (versions.length && !versions.some((v) => KNOWN_MAJOR.test(v))) return null; // unknown format: fail safe

  let start = -1;
  let turn = 0;
  entries.forEach((e, i) => {
    if (isPrompt(e)) {
      start = i;
      turn++;
    }
  });
  const texts = [];
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'assistant' || e.isSidechain || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'text' && typeof b.text === 'string') texts.push({ text: b.text, ref: e.uuid || null, kind: 'message' });
      if (b.type === 'tool_use' && b.input) {
        if (/^TodoWrite$|^TaskCreate$|^TaskUpdate$/.test(b.name)) {
          const todos = b.input.todos || (b.input.subject ? [{ content: `${b.input.subject}. ${b.input.description || ''}` }] : []);
          for (const t of todos) if (t && t.content) texts.push({ text: String(t.content), ref: e.uuid || null, kind: 'todo' });
        }
        if (b.name === 'Bash' && typeof b.input.command === 'string') {
          const m = /git commit[^\n]*?-m\s+(?:"([^"]+)"|'([^']+)')/.exec(b.input.command) || /git commit[\s\S]*?<<'?EOF'?\n([\s\S]*?)\nEOF/.exec(b.input.command);
          if (m) texts.push({ text: m[1] || m[2], ref: e.uuid || null, kind: 'commit' });
        }
      }
    }
  }
  if (!texts.length && ctx.lastAssistantMessage) texts.push({ text: ctx.lastAssistantMessage, ref: 'last_assistant_message', kind: 'message' });

  const files = (ctx.files || []).map((f) => ({ f, base: path.basename(f), stem: path.basename(f).replace(/\.\w+$/, '') }));
  const symbols = (ctx.symbols || []).filter((s) => s && s.length > 2);
  const out = [];
  const seen = new Set();
  for (const t of texts) {
    for (const s of splitSentences(t.text)) {
      if (!REASON.test(s) || seen.has(s) || hasSecret(s)) continue;
      const mentioned = files.filter((x) => s.includes(x.base) || s.includes(x.f) || new RegExp(`\\b${x.stem}\\b`).test(s)).map((x) => x.f);
      const syms = symbols.filter((sym) => new RegExp(`\\b${sym.replace(/[^\w]/g, '\\$&')}\\b`).test(s));
      seen.add(s);
      out.push({ sentence: s, ref: t.ref, kind: t.kind, files: mentioned, symbols: syms, score: mentioned.length * 2 + syms.length + (t.kind === 'commit' ? 1 : 0) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return { turn, sentences: out.slice(0, MAX_SENTENCES) };
}

/**
 * Split a reason sentence into {action, reason} around the reason marker.
 * "I switched the socket to non-blocking mode so that one slow client can't stall the loop."
 *  -> action "switched the socket to non-blocking mode", reason "so that one slow client can't stall the loop"
 */
function splitReason(sentence) {
  const m = REASON.exec(sentence);
  if (!m) return null;
  let action = sentence.slice(0, m.index).trim().replace(/[,;:—-]+$/, '').trim();
  const reason = sentence.slice(m.index).trim().replace(/[.!]+$/, '');
  action = action.replace(/^(?:I(?:'ve| have)?|We(?:'ve| have)?|Now I|Then I|Here I)\s+/i, '').replace(/^(?:also|then|now)\s+/i, '');
  if (action.split(/\s+/).length < 3 || reason.split(/\s+/).length < 4) return null;
  return { action, reason };
}

module.exports = { extract, splitReason, splitSentences, REASON };
