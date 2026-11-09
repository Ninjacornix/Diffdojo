'use strict';
// Language detection and comment/string masking.
// mask(src) returns a string of identical length and line structure in which
// comments and string-literal contents are replaced by spaces. Mutation
// operators and the structure analyzer run on the masked text so they never
// touch code inside comments or strings.

const path = require('path');

const EXT = {
  '.c': 'c', '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.ipp': 'cpp',
  '.py': 'python', '.pyi': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
  '.swift': 'swift', '.sql': 'sql', '.sh': 'shell',
};

function detect(file) {
  return EXT[path.extname(file).toLowerCase()] || null;
}

function family(lang) {
  if (lang === 'c' || lang === 'cpp') return 'c';
  if (lang === 'javascript' || lang === 'typescript') return 'js';
  if (lang === 'python') return 'py';
  if (['go', 'rust', 'java', 'kotlin', 'csharp', 'swift', 'php'].includes(lang)) return 'c';
  return null;
}

/** Track (belt track) for a language. */
function trackFor(lang) {
  if (lang === 'c' || lang === 'cpp') return 'cpp';
  if (lang === 'python') return 'python';
  if (lang === 'javascript' || lang === 'typescript') return 'javascript';
  return 'general';
}

function maskC(src, js) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (!js && c === 'R' && d === '"' && !/[\w]/.test(src[i - 1] || '')) {
      // C++ raw string R"delim( ... )delim"
      const open = src.indexOf('(', i + 2);
      const delim = open > 0 ? src.slice(i + 2, open) : '';
      const close = src.indexOf(')' + delim + '"', open);
      const j = close < 0 ? n : close + delim.length + 2;
      blank(i + 2, j - 1);
      i = j;
    } else if (c === '"' || c === "'" || (js && c === '`')) {
      if (!js && c === "'" && /[0-9a-fA-F]/.test(src[i - 1] || '') && /[0-9a-fA-F]/.test(d || '')) {
        i++; // C++14 digit separator 1'000'000
        continue;
      }
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function maskPy(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      const triple = src.substr(i, 3) === c.repeat(3);
      if (triple) {
        let j = src.indexOf(c.repeat(3), i + 3);
        j = j < 0 ? n : j;
        blank(i + 3, j);
        i = j + 3;
      } else {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') {
          if (src[j] === '\\') j++;
          j++;
        }
        blank(i + 1, Math.min(j, n));
        i = j + 1;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

function mask(src, lang) {
  const f = family(lang);
  if (f === 'py') return maskPy(src);
  if (f === 'js') return maskC(src, true);
  if (f === 'c') return maskC(src, false);
  return src;
}

module.exports = { detect, family, trackFor, mask, EXT };
