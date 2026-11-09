'use strict';
// A small YAML subset parser, enough for question packs:
// block mappings and sequences (incl. "- key: value" items), nested to any
// depth; plain, single- and double-quoted scalars; block scalars `|` and `>`
// with `-`/`+` chomping; flow sequences/maps of scalars ([a, b], {a: 1});
// comments; multiple documents separated by `---`. Anchors/tags unsupported.

class YamlError extends Error {
  constructor(msg, line) {
    super(`YAML line ${line}: ${msg}`);
    this.line = line;
  }
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function scalar(raw, line) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s[0] === '"') {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError('unterminated double-quoted string', line);
    return JSON.parse(s.replace(/\\'/g, "'"));
  }
  if (s[0] === "'") {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError('unterminated single-quoted string', line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s[0] === '[' || s[0] === '{') return flow(s, line);
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
  return s;
}

function splitFlow(inner, line) {
  const parts = [];
  let depth = 0;
  let q = null;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += inner[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (q || depth !== 0) throw new YamlError('unbalanced flow collection', line);
  if (cur.trim()) parts.push(cur);
  return parts;
}

function flow(s, line) {
  if (s[0] === '[') {
    if (!s.endsWith(']')) throw new YamlError('unterminated flow sequence', line);
    return splitFlow(s.slice(1, -1), line).map((p) => scalar(p, line));
  }
  if (!s.endsWith('}')) throw new YamlError('unterminated flow mapping', line);
  const out = {};
  for (const p of splitFlow(s.slice(1, -1), line)) {
    const idx = keyColon(p);
    if (idx < 0) throw new YamlError(`expected key: value in flow mapping, got "${p.trim()}"`, line);
    out[unquoteKey(p.slice(0, idx).trim())] = scalar(p.slice(idx + 1), line);
  }
  return out;
}

/** Index of the ':' separating key and value, or -1. */
function keyColon(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if ((c === '"' || c === "'") && i === s.search(/\S/)) {
      q = c;
      continue;
    }
    if (c === ':' && (i + 1 === s.length || s[i + 1] === ' ' || s[i + 1] === '\t')) return i;
    if (c === '[' || c === '{') return -1;
  }
  return -1;
}

function unquoteKey(k) {
  if ((k[0] === '"' && k.endsWith('"')) || (k[0] === "'" && k.endsWith("'"))) return k.slice(1, -1);
  return k;
}

function parseDocument(lines, startLineNo) {
  // lines: [{indent, text, no, raw}] excluding blank/comment-only lines are kept for block scalars
  let pos = 0;

  const peek = () => {
    while (pos < lines.length && lines[pos].blank) pos++;
    return lines[pos];
  };

  function blockScalar(header, parentIndent, lineNo) {
    const style = header[0];
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const explicit = /\d/.exec(header);
    const buf = [];
    let indent = null;
    while (pos < lines.length) {
      const l = lines[pos];
      // Inside a block scalar '#' is content, so blankness is judged on the raw line.
      if (l.raw.trim() === '') {
        buf.push('');
        pos++;
        continue;
      }
      const ind = l.raw.match(/^ */)[0].length;
      if (indent === null) indent = explicit ? parentIndent + +explicit[0] : ind;
      if (ind < indent || ind <= parentIndent) break;
      buf.push(l.raw.slice(indent));
      pos++;
    }
    if (indent === null && buf.length === 0) return '';
    // trailing blank lines
    let trail = 0;
    while (buf.length && buf[buf.length - 1] === '') {
      buf.pop();
      trail++;
    }
    let text;
    if (style === '|') text = buf.join('\n');
    else {
      // folded: join lines with spaces; blank lines become newlines; more-indented lines kept
      text = '';
      for (let i = 0; i < buf.length; i++) {
        const l = buf[i];
        if (l === '') text += '\n';
        else if (/^\s/.test(l)) text += (text && !text.endsWith('\n') ? '\n' : '') + l + '\n';
        else text += (text && !text.endsWith('\n') && !text.endsWith(' ') ? ' ' : '') + l;
      }
      text = text.replace(/\n$/, (m) => m);
    }
    if (chomp === 'strip') return text.replace(/\n+$/, '');
    if (chomp === 'keep') return text + '\n'.repeat(trail + 1);
    void lineNo;
    return text.replace(/\n*$/, '') + '\n';
  }

  function parseNode(indent) {
    const l = peek();
    if (!l || l.indent < indent) return null;
    if (/^-(\s|$)/.test(l.text)) return parseSeq(l.indent);
    return parseMap(l.indent);
  }

  function valueAfter(rest, ownIndent, lineNo) {
    const r = rest.trim();
    if (r === '') {
      const nxt = peek();
      if (nxt && (nxt.indent > ownIndent || (nxt.indent === ownIndent && /^-(\s|$)/.test(nxt.text)))) {
        return parseNode(nxt.indent);
      }
      return null;
    }
    if (/^[|>][-+0-9]*$/.test(r)) return blockScalar(r, ownIndent, lineNo);
    // plain multi-line scalars: continuation lines more indented
    let val = r;
    if (!/^["'[{]/.test(r)) {
      for (;;) {
        const nxt = peek();
        if (!nxt || nxt.indent <= ownIndent || keyColon(nxt.text) >= 0 || /^-(\s|$)/.test(nxt.text)) break;
        val += ' ' + nxt.text.trim();
        pos++;
      }
    }
    return scalar(val, lineNo);
  }

  function parseMap(indent) {
    const out = {};
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.no);
      if (/^-(\s|$)/.test(l.text)) break;
      const idx = keyColon(l.text);
      if (idx < 0) throw new YamlError(`expected "key: value", got "${l.text}"`, l.no);
      const key = unquoteKey(l.text.slice(0, idx).trim());
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, l.no);
      pos++;
      out[key] = valueAfter(l.text.slice(idx + 1), indent, l.no);
    }
    return out;
  }

  function parseSeq(indent) {
    const out = [];
    for (;;) {
      const l = peek();
      if (!l || l.indent !== indent || !/^-(\s|$)/.test(l.text)) {
        if (l && l.indent > indent) throw new YamlError('unexpected indentation in sequence', l.no);
        break;
      }
      const rest = l.text.replace(/^-\s?/, '');
      const restTrim = rest.trim();
      if (restTrim === '') {
        pos++;
        out.push(valueAfter('', indent, l.no));
        continue;
      }
      const itemIndent = indent + (l.text.length - rest.length);
      if (keyColon(rest) >= 0 && !/^["'[{]/.test(restTrim)) {
        // inline mapping start: rewrite current line as a mapping line at itemIndent
        lines[pos] = { ...l, indent: itemIndent, text: rest.trimStart() };
        out.push(parseMap(itemIndent));
      } else {
        pos++;
        if (/^[|>][-+0-9]*$/.test(restTrim)) out.push(blockScalar(restTrim, indent, l.no));
        else out.push(scalar(restTrim, l.no));
      }
    }
    return out;
  }

  const first = peek();
  if (!first) return null;
  let result;
  if (/^-(\s|$)/.test(first.text)) result = parseSeq(first.indent);
  else if (keyColon(first.text) >= 0) result = parseMap(first.indent);
  else {
    result = scalar(first.text, first.no);
    pos++;
  }
  const extra = peek();
  if (extra) throw new YamlError(`unexpected content "${extra.text}"`, extra.no);
  void startLineNo;
  return result;
}

function toLines(chunk, offset) {
  return chunk.map((raw, i) => {
    const noTab = raw.replace(/\r$/, '');
    if (/^\t/.test(noTab)) throw new YamlError('tabs are not allowed for indentation', offset + i + 1);
    const text = stripComment(noTab);
    const blank = text.trim() === '';
    return { raw: noTab, text: text.trim(), indent: noTab.match(/^ */)[0].length, no: offset + i + 1, blank };
  });
}

function parseAll(src) {
  const all = src.replace(/^﻿/, '').split('\n');
  const docs = [];
  let chunk = [];
  let offset = 0;
  all.forEach((line, i) => {
    if (/^---\s*$/.test(line)) {
      if (chunk.some((l) => stripComment(l).trim())) docs.push(parseDocument(toLines(chunk, offset), offset));
      chunk = [];
      offset = i + 1;
    } else if (/^\.\.\.\s*$/.test(line)) {
      /* document end marker */
    } else chunk.push(line);
  });
  if (chunk.some((l) => stripComment(l).trim())) docs.push(parseDocument(toLines(chunk, offset), offset));
  return docs;
}

function parse(src) {
  const docs = parseAll(src);
  return docs.length ? docs[0] : null;
}

module.exports = { parse, parseAll, YamlError };
