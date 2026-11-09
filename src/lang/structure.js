'use strict';
// Lightweight structure analyzer for C/C++, Python and JavaScript/TypeScript.
// Extracts functions (with line ranges and calls), classes, container-typed
// members/variables and imports. It works on comment/string-masked text with
// brace matching (C-like) or indentation (Python). The facts it produces are
// read straight from the code and are used as verified answers.

const { mask, family } = require('./index');

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'alignof', 'decltype', 'typeof', 'new', 'delete',
  'throw', 'else', 'do', 'try', 'case', 'default', 'static_assert', 'defined', 'function', 'await', 'yield',
  'elif', 'with', 'assert', 'lambda', 'not', 'and', 'or', 'in', 'is', 'print', 'super', 'import', 'from', 'class',
  'struct', 'union', 'enum', 'namespace', 'template', 'typename', 'operator', 'const', 'let', 'var', 'async', 'void',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast', 'noexcept', 'requires', 'constexpr', 'using',
  'foreach', 'synchronized', 'instanceof', 'export',
]);

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, idx) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function matchBrace(m, open) {
  let depth = 0;
  for (let i = open; i < m.length; i++) {
    if (m[i] === '{') depth++;
    else if (m[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return m.length - 1;
}

/** Find the function name/params in a C-like header ending right before '{'. */
function parseHeader(header, fam) {
  const h = header.replace(/\s+/g, ' ').trim();
  if (!h) return null;
  // class / struct
  const cm = /(?:^|\s)(class|struct|interface)\s+([A-Za-z_]\w*)[^()]*$/.exec(h);
  if (cm && !/=>/.test(h)) return { kind: 'class', name: cm[2] };
  if (fam === 'js') {
    const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s+)?(?:function\s*\*?\s*)?\(([^()]*)\)\s*(?::[^=]+)?(?:=>)?\s*$/.exec(h);
    if (arrow) return { kind: 'function', name: arrow[1], params: arrow[3], isAsync: !!arrow[2] };
    const arrow1 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*$/.exec(h);
    if (arrow1) return { kind: 'function', name: arrow1[1], params: arrow1[3], isAsync: !!arrow1[2] };
    const prop = /([A-Za-z_$][\w$]*)\s*:\s*(async\s+)?(?:function\s*)?\(([^()]*)\)\s*(?:=>)?\s*$/.exec(h);
    if (prop && !KEYWORDS.has(prop[1])) return { kind: 'function', name: prop[1], params: prop[3], isAsync: !!prop[2] };
  }
  // Find top-level paren groups.
  let depth = 0;
  let start = -1;
  const groups = [];
  for (let i = 0; i < h.length; i++) {
    if (h[i] === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (h[i] === ')') {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) groups.push([start, i]);
    }
  }
  if (depth !== 0 || !groups.length) return null;
  for (const [a, b] of groups) {
    const before = h.slice(0, a).trimEnd();
    const nm = /([A-Za-z_~$][\w$]*(?:::~?[A-Za-z_]\w*)*(?:::operator\W+)?)\s*(?:<[^<>]*>)?$/.exec(before);
    if (!nm) continue;
    const full = nm[1];
    const name = full.split('::').pop();
    if (KEYWORDS.has(name) || KEYWORDS.has(full)) return null;
    const after = h.slice(b + 1);
    const okSuffix = /^\s*(?:(?:const|noexcept(?:\([^)]*\))?|override|final|mutable|volatile|&&|&|throws\s+[\w.,\s]+)\s*)*(?:->\s*[^{]+|:\s*[^{]*)?$/;
    if (!okSuffix.test(after)) continue;
    // Calls like `foo(x) ` followed by `{` are not declarations unless there is a return type or it's JS/class method
    const prefix = before.slice(0, before.length - nm[0].length).trim();
    if (fam === 'c' && !prefix && !full.includes('::')) {
      // e.g. "main(...)" K&R style is rare; macro invocations like FOO(x) { are more common.
      if (!/^[a-z_]/.test(name)) continue;
    }
    if (fam === 'c' && /[=,(]$/.test(prefix)) continue; // initialiser or argument, not a declaration
    if (fam === 'js' && /(?:^|[^\w$])(?:new|return|=|,|\()\s*$/.test(prefix)) continue;
    return {
      kind: 'function',
      name,
      qualified: full,
      params: h.slice(a + 1, b),
      isAsync: /\basync\b/.test(prefix),
      retType: fam === 'c' ? prefix.replace(/\b(static|inline|virtual|explicit|constexpr|extern|friend)\b/g, '').trim() : null,
    };
  }
  return null;
}

function callsIn(masked) {
  const out = new Set();
  const re = /(?:\.|->|::)?([A-Za-z_$][\w$]*)\s*(?:<[^<>;(){}]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    if (!KEYWORDS.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

function analyzeC(src, lang) {
  const fam = family(lang);
  const m = mask(src, lang);
  const starts = lineStarts(src);
  const lines = src.split('\n');
  const functions = [];
  const classes = [];
  const scan = (from, to, owner) => {
    let i = from;
    let segStart = from;
    while (i < to) {
      const ch = m[i];
      if (ch === ';' || ch === '}') {
        segStart = i + 1;
        i++;
        continue;
      }
      if (ch === '{') {
        const end = matchBrace(m, i);
        const header = m.slice(segStart, i);
        const info = parseHeader(header.replace(/^[\s\S]*\n\s*#.*$/m, (s) => s), fam);
        const hdrOffset = segStart + header.search(/\S|$/);
        if (info && info.kind === 'class') {
          const cls = { name: info.name, start: lineOf(starts, hdrOffset), end: lineOf(starts, end) };
          classes.push(cls);
          scan(i + 1, end, info.name);
        } else if (info && info.kind === 'function') {
          const startLine = lineOf(starts, hdrOffset);
          const endLine = lineOf(starts, end);
          const body = m.slice(i + 1, end);
          const qual = info.qualified || info.name;
          functions.push({
            name: info.name,
            qualified: owner && !qual.includes('::') ? `${owner}${fam === 'js' ? '.' : '::'}${info.name}` : qual,
            cls: owner || (qual.includes('::') ? qual.split('::').slice(-2, -1)[0] : null),
            start: startLine,
            end: endLine,
            bodyStart: lineOf(starts, i),
            params: (info.params || '').trim(),
            retType: info.retType || null,
            isAsync: !!info.isAsync,
            calls: callsIn(body).filter((c) => c !== info.name || /\b(return|=)\b/.test(body)),
          });
          if (fam === 'js') scan(i + 1, end, owner); // nested named functions
        } else {
          // namespace, extern "C", control blocks at top level, etc.
          if (/\bnamespace\b|extern\s*$/.test(header) || fam === 'js') scan(i + 1, end, owner);
        }
        i = end + 1;
        segStart = i;
        continue;
      }
      // Preprocessor lines end a header segment.
      if (ch === '\n' && m[i + 1] !== undefined) {
        const nextLine = m.slice(i + 1, m.indexOf('\n', i + 1) < 0 ? m.length : m.indexOf('\n', i + 1));
        if (/^\s*#/.test(nextLine)) segStart = i + 1 + nextLine.length;
      }
      i++;
    }
  };
  scan(0, m.length, null);

  const imports = [];
  const members = [];
  const mlines = m.split('\n');
  mlines.forEach((ml, idx) => {
    const raw = lines[idx];
    let mm;
    if (fam === 'c') {
      if ((mm = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(raw))) imports.push({ name: mm[1], line: idx + 1 });
    } else if (fam === 'js') {
      if ((mm = /^\s*import\b[^'"]*['"]([^'"]+)['"]/.exec(raw))) imports.push({ name: mm[1], line: idx + 1 });
      const rq = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((mm = rq.exec(raw))) imports.push({ name: mm[1], line: idx + 1 });
    }
    for (const d of declsInLine(ml, fam)) members.push({ ...d, line: idx + 1 });
  });
  for (const mem of members) {
    const f = functions.find((fn) => mem.line > fn.bodyStart - 1 && mem.line <= fn.end);
    const c = classes.find((cl) => mem.line > cl.start && mem.line < cl.end);
    mem.owner = f ? f.qualified : c ? c.name : null;
    mem.scope = f ? 'local' : c ? 'member' : 'global';
  }
  return { language: lang, functions, classes, imports, members, masked: m };
}

const CPP_CONTAINERS = [
  'vector', 'map', 'unordered_map', 'set', 'unordered_set', 'multimap', 'multiset', 'unordered_multimap',
  'deque', 'list', 'forward_list', 'priority_queue', 'queue', 'stack', 'array', 'bitset', 'span', 'string',
  'string_view', 'shared_ptr', 'unique_ptr', 'weak_ptr', 'atomic', 'mutex', 'shared_mutex', 'optional', 'variant',
  'tuple', 'pair', 'function', 'condition_variable', 'thread', 'flat_map', 'flat_set',
];

function readTemplate(s, i) {
  // s[i] === '<'; return index after matching '>'
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '<') d++;
    else if (s[k] === '>') {
      d--;
      if (d === 0) return k + 1;
    } else if (s[k] === ';' || s[k] === '{' || s[k] === '}') return -1;
  }
  return -1;
}

function declsInLine(ml, fam) {
  const out = [];
  if (fam === 'c') {
    const re = new RegExp(`\\b(?:std::)?(${CPP_CONTAINERS.join('|')})\\s*<`, 'g');
    let mm;
    while ((mm = re.exec(ml))) {
      const lt = mm.index + mm[0].length - 1;
      const end = readTemplate(ml, lt);
      if (end < 0) continue;
      const rest = ml.slice(end);
      const nm = /^\s*[*&]*\s*([A-Za-z_]\w*)\s*(?:[;={(,)\[]|$)/.exec(rest);
      if (!nm) continue;
      const before = ml.slice(0, mm.index);
      if (/(<|::|\w)\s*$/.test(before) && !/\b(const|static|mutable|inline|volatile|thread_local)\s*$/.test(before) && !/^\s*$/.test(before) && !/[(,]\s*$/.test(before)) continue;
      out.push({ name: nm[1], type: ml.slice(mm.index, end).replace(/\s+/g, ' ').trim(), container: mm[1] });
      re.lastIndex = end;
    }
    const plain = /^\s*(?:(?:static|mutable|inline|thread_local)\s+)*(std::(?:mutex|shared_mutex|recursive_mutex|timed_mutex|condition_variable|condition_variable_any|string|thread|jthread|atomic_flag|once_flag))\s+([A-Za-z_]\w*)\s*[;{=]/.exec(ml);
    if (plain) out.push({ name: plain[2], type: plain[1], container: plain[1].replace('std::', '') });
  } else if (fam === 'js') {
    let mm;
    const newRe = /(?:(?:this\.|const\s+|let\s+|var\s+|readonly\s+|private\s+|public\s+|protected\s+|static\s+)+)?([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+?))?\s*=\s*new\s+(Map|Set|WeakMap|WeakSet|Array|Int32Array|Float64Array|Uint8Array|ArrayBuffer|Promise)\b/g;
    while ((mm = newRe.exec(ml))) out.push({ name: mm[1], type: (mm[2] && mm[2].trim()) || mm[3], container: mm[3] });
    const lit = /(?:this\.|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+?))?\s*=\s*(\[\]|\{\})\s*[;,]?\s*$/.exec(ml);
    if (lit) out.push({ name: lit[1], type: (lit[2] && lit[2].trim()) || (lit[3] === '[]' ? 'Array' : 'Object'), container: lit[3] === '[]' ? 'Array' : 'Object' });
    const ann = /^\s*(?:(?:private|public|protected|readonly|static)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*((?:Map|Set|Array|Record|ReadonlyArray|WeakMap)\s*<[^;=]+>|[\w$]+\[\])\s*[;=]/.exec(ml);
    if (ann && !out.some((o) => o.name === ann[1])) out.push({ name: ann[1], type: ann[2].trim(), container: ann[2].split('<')[0].replace('[]', 'Array').trim() });
  }
  return out;
}

function analyzePython(src) {
  const m = mask(src, 'python');
  const lines = src.split('\n');
  const mlines = m.split('\n');
  const indentOf = (s) => s.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
  const blockEnd = (i, ind) => {
    let end = i;
    for (let k = i + 1; k < mlines.length; k++) {
      if (!mlines[k].trim()) continue;
      if (indentOf(mlines[k]) <= ind) break;
      end = k;
    }
    return end;
  };
  const functions = [];
  const classes = [];
  const imports = [];
  const members = [];
  for (let i = 0; i < mlines.length; i++) {
    const ml = mlines[i];
    let mm;
    if ((mm = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(ml))) {
      classes.push({ name: mm[2], start: i + 1, end: blockEnd(i, indentOf(ml)) + 1, indent: indentOf(ml) });
    }
    if ((mm = /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(ml))) {
      // header may span lines until '):' or ') -> X:'
      let hdr = ml;
      let k = i;
      while (!/\)\s*(->[^:]*)?:\s*$/.test(hdr) && k < mlines.length - 1 && k - i < 20) hdr += ' ' + mlines[++k].trim();
      const ind = indentOf(ml);
      const end = blockEnd(k, ind);
      const params = (/\(([\s\S]*)\)\s*(?:->[^:]*)?:\s*$/.exec(hdr) || [])[1] || '';
      const ret = (/\)\s*->\s*([^:]+):\s*$/.exec(hdr) || [])[1] || null;
      const owner = classes.filter((c) => i + 1 > c.start && i + 1 <= c.end && c.indent < ind).pop();
      const body = mlines.slice(k + 1, end + 1).join('\n');
      functions.push({
        name: mm[3],
        qualified: owner ? `${owner.name}.${mm[3]}` : mm[3],
        cls: owner ? owner.name : null,
        start: i + 1,
        end: end + 1,
        bodyStart: k + 2,
        params: params.trim(),
        retType: ret && ret.trim(),
        isAsync: !!mm[2],
        calls: callsIn(body),
      });
    }
    if ((mm = /^\s*import\s+([\w.]+)/.exec(lines[i]))) imports.push({ name: mm[1], line: i + 1 });
    if ((mm = /^\s*from\s+([\w.]+)\s+import\s+(.+)/.exec(lines[i]))) imports.push({ name: mm[1], line: i + 1, names: mm[2] });
    for (const d of pyDecls(ml)) members.push({ ...d, line: i + 1 });
  }
  // heapq-managed lists
  const heapRe = /heapq\.heap(?:push|pop|ify|pushpop|replace)\(\s*(self\.)?([A-Za-z_]\w*)/g;
  let hm;
  const heapNames = new Set();
  while ((hm = heapRe.exec(m))) heapNames.add(hm[2]);
  const bareHeap = /\bheap(?:push|pop|ify)\(\s*(self\.)?([A-Za-z_]\w*)/g;
  while ((hm = bareHeap.exec(m))) heapNames.add(hm[2]);
  for (const mem of members) {
    if (heapNames.has(mem.name) && mem.container === 'list') {
      mem.container = 'heap';
      mem.type = 'list used as a binary heap (heapq)';
    }
    const f = functions.filter((fn) => mem.line >= fn.bodyStart && mem.line <= fn.end).pop();
    const c = classes.filter((cl) => mem.line > cl.start && mem.line <= cl.end).pop();
    mem.owner = mem.self && c ? c.name : f ? f.qualified : c ? c.name : null;
    mem.scope = mem.self ? 'member' : f ? 'local' : c ? 'member' : 'global';
  }
  return { language: 'python', functions, classes, imports, members, masked: m };
}

const PY_CTORS = {
  'dict(': 'dict', 'list(': 'list', 'set(': 'set', 'frozenset(': 'frozenset', 'tuple(': 'tuple',
  'deque(': 'collections.deque', 'collections.deque(': 'collections.deque',
  'defaultdict(': 'collections.defaultdict', 'collections.defaultdict(': 'collections.defaultdict',
  'OrderedDict(': 'collections.OrderedDict', 'collections.OrderedDict(': 'collections.OrderedDict',
  'Counter(': 'collections.Counter', 'collections.Counter(': 'collections.Counter',
  'queue.Queue(': 'queue.Queue', 'Queue(': 'queue.Queue', 'queue.PriorityQueue(': 'queue.PriorityQueue',
  'PriorityQueue(': 'queue.PriorityQueue', 'asyncio.Queue(': 'asyncio.Queue', 'threading.Lock(': 'threading.Lock',
  'threading.RLock(': 'threading.RLock', 'Lock(': 'threading.Lock', 'asyncio.Lock(': 'asyncio.Lock',
  'bytearray(': 'bytearray', 'array.array(': 'array.array', 'SortedList(': 'sortedcontainers.SortedList',
};

function pyDecls(ml) {
  const out = [];
  const mm = /^\s*(self\.)?([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(.+?)\s*$/.exec(ml);
  if (!mm || /^\s*(if|elif|while|for|return|with|assert)\b/.test(ml)) return out;
  const rhs = mm[4];
  let container = null;
  if (/^\{\s*\}$/.test(rhs) || /^\{.*:.*\}$/.test(rhs)) container = 'dict';
  else if (/^\[\s*\]$/.test(rhs) || /^\[[^\]]*\]$/.test(rhs) && !/\bfor\b/.test(rhs)) container = 'list';
  else if (/^\[.*\bfor\b.*\]$/.test(rhs)) container = 'list';
  else if (/^\{[^:]*\bfor\b.*\}$/.test(rhs)) container = 'set';
  else {
    for (const [k, v] of Object.entries(PY_CTORS)) {
      if (rhs.startsWith(k)) {
        container = v;
        break;
      }
    }
  }
  if (!container && mm[3] && /^(dict|list|set|deque|Dict|List|Set|Deque|DefaultDict|OrderedDict|Counter|tuple|Tuple)\b/.test(mm[3])) {
    container = mm[3].split('[')[0].toLowerCase();
    if (container === 'deque') container = 'collections.deque';
    if (container === 'defaultdict') container = 'collections.defaultdict';
  }
  if (!container) return out;
  let type = container;
  if (container === 'collections.defaultdict') {
    const f = /defaultdict\(\s*([\w.]+)/.exec(rhs);
    if (f) type = `collections.defaultdict(${f[1]})`;
  }
  if (mm[3]) type = `${type} (annotated ${mm[3].trim()})`;
  out.push({ name: mm[2], type, container, self: !!mm[1] });
  return out;
}

function analyze(src, lang) {
  const fam = family(lang);
  if (fam === 'py') return analyzePython(src);
  if (fam === 'c' || fam === 'js') return analyzeC(src, lang);
  return { language: lang, functions: [], classes: [], imports: [], members: [], masked: src };
}

/** Functions overlapping any of the given (1-based) changed lines. */
function changedFunctions(structure, changedLines) {
  const set = new Set(changedLines);
  return structure.functions.filter((f) => {
    for (let l = f.start; l <= f.end; l++) if (set.has(l)) return true;
    return false;
  });
}

module.exports = { analyze, changedFunctions, callsIn, parseHeader, KEYWORDS };
