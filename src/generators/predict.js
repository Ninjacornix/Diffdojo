'use strict';
// "Predict the output": find pure functions with simple typed parameters in
// the diff, build a tiny harness that calls them with fixed inputs, run it
// twice (must be deterministic), and record the output as the answer key.
// The same harness checks whether a mutant changes behaviour.

const { runDeterministic, runSnippet, normalizeOutput } = require('../runner');

const IMPURE = /\b(open|input|print|exec|eval|compile|__import__|globals|setattr|delattr|requests|urllib|socket|subprocess|os\.|sys\.|time\.|random|datetime|uuid|threading|asyncio|logging|pathlib|shutil|fetch|require|process\.|console\.|Date|Math\.random|setTimeout|setInterval|XMLHttpRequest|document|window|globalThis|std::cin|std::cout|printf|scanf|fopen|rand\(|srand|std::rand|time\(|getenv|system\(|std::thread|std::async|socket|recv|send|malloc|free|new\s|delete\s)\b/;

const PY_ALLOWED_IMPORTS = /^\s*(?:import\s+(?:math|itertools|functools|collections|heapq|bisect|re|string|operator|fractions|decimal|statistics|typing|dataclasses)\b|from\s+(?:math|itertools|functools|collections|heapq|bisect|re|string|operator|fractions|decimal|statistics|typing|__future__|dataclasses)\s+import\b)/;

const VALUES = {
  int: ['3', '5', '1', '7', '2', '10', '0', '-2'],
  float: ['0.5', '2.0', '3.25', '-1.5'],
  str: ['"abc"', '"hello"', '""', '"a,b,c"', '"racecar"', '"Mississippi"'],
  bool: ['True', 'False'],
  listint: ['[3, 1, 2]', '[5, 5, 1, 4]', '[]', '[1, 2, 3, 4, 5]', '[-1, 0, 7]', '[2]'],
  liststr: ['["b", "a", "c"]', '[]', '["x", "xy", "x"]'],
};

function pyType(t) {
  t = (t || '').replace(/\s/g, '');
  if (t === 'int') return 'int';
  if (t === 'float') return 'float';
  if (t === 'str') return 'str';
  if (t === 'bool') return 'bool';
  if (/^(list|List|Sequence|Iterable)\[int\]$/.test(t)) return 'listint';
  if (/^(list|List|Sequence|Iterable)\[str\]$/.test(t)) return 'liststr';
  return null;
}

function tsType(t) {
  t = (t || '').replace(/\s/g, '');
  if (t === 'number') return 'int';
  if (t === 'string') return 'str';
  if (t === 'boolean') return 'bool';
  if (t === 'number[]' || t === 'Array<number>' || t === 'readonlynumber[]') return 'listint';
  if (t === 'string[]' || t === 'Array<string>') return 'liststr';
  return null;
}

function cppType(t) {
  t = (t || '').replace(/\bconst\b|&/g, '').replace(/\s+/g, ' ').trim();
  if (/^(int|long|long long|short|unsigned|unsigned int|size_t|std::size_t|int64_t|int32_t|uint32_t|uint64_t|std::int64_t)$/.test(t)) return 'int';
  if (/^(double|float)$/.test(t)) return 'float';
  if (/^(bool)$/.test(t)) return 'bool';
  if (/^(std::)?string$/.test(t) || /^(std::)?string_view$/.test(t)) return 'str';
  if (/^(std::)?vector<\s*(int|long|long long|int64_t)\s*>$/.test(t)) return 'listint';
  if (/^(std::)?vector<\s*(std::)?string\s*>$/.test(t)) return 'liststr';
  return null;
}

function splitParams(params) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of params) {
    if ('<([{'.includes(c)) depth++;
    if ('>)]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function paramTypes(fn, lang) {
  const ps = splitParams(fn.params || '');
  const types = [];
  for (const p of ps) {
    if (lang === 'python') {
      if (p === 'self' || p === 'cls' || p.startsWith('*') || p === '/') return null;
      const m = /^(\w+)\s*:\s*([^=]+?)(?:\s*=.*)?$/.exec(p);
      if (!m) return null;
      const t = pyType(m[2]);
      if (!t) return null;
      types.push(t);
    } else if (lang === 'typescript') {
      const m = /^(\w+)\s*:\s*([^=]+?)(?:\s*=.*)?$/.exec(p);
      if (!m) return null;
      const t = tsType(m[2]);
      if (!t) return null;
      types.push(t);
    } else if (lang === 'cpp' || lang === 'c') {
      const m = /^(.*?)\s*\b(\w+)$/.exec(p.replace(/\s*=.*$/, ''));
      if (!m) return null;
      const t = cppType(m[1]);
      if (!t) return null;
      types.push(t);
    } else return null;
  }
  return types;
}

function literal(v, t, lang) {
  if (lang === 'python') return v;
  if (lang === 'typescript') return v.replace(/^True$/, 'true').replace(/^False$/, 'false');
  // C++
  if (t === 'bool') return v === 'True' ? 'true' : 'false';
  if (t === 'str') return `std::string(${v})`;
  if (t === 'listint' || t === 'liststr') return `{${v.slice(1, -1)}}`; // braced init-list adapts to the element type
  return v;
}

/** Deterministic set of argument tuples. */
function inputSets(types, lang, count = 6) {
  const sets = [];
  for (let k = 0; k < count; k++) {
    sets.push(types.map((t, i) => literal(VALUES[t][(k * 3 + i * 2) % VALUES[t].length], t, lang)));
  }
  return sets;
}

/** Collect the function plus same-file helpers it calls (transitively). */
function closure(fn, structure, lines) {
  const byName = new Map(structure.functions.filter((f) => !f.cls).map((f) => [f.name, f]));
  const seen = new Set([fn.name]);
  const order = [fn];
  for (let i = 0; i < order.length; i++) {
    for (const c of order[i].calls) {
      const f = byName.get(c);
      if (f && !seen.has(c)) {
        seen.add(c);
        order.push(f);
      }
    }
  }
  return order.reverse().map((f) => lines.slice(f.start - 1, f.end).join('\n'));
}

/**
 * Untyped JavaScript: guess parameter shapes from how the body uses them
 * (only for mutant-equivalence checks, never for answer keys).
 */
function guessTypes(fn, maskedBody) {
  const ps = splitParams(fn.params || '');
  const types = [];
  for (const p of ps) {
    if (!/^[A-Za-z_$][\w$]*$/.test(p)) return null;
    const esc = p.replace(/\$/g, '\\$');
    if (new RegExp(`\\b${esc}\\s*(\\.length|\\[|\\.(map|forEach|filter|reduce|some|every|slice|indexOf)\\b)|\\bof\\s+${esc}\\b`).test(maskedBody)) types.push('listint');
    else if (new RegExp(`\\b${esc}\\.(toLowerCase|toUpperCase|split|charAt|trim|startsWith|endsWith|padStart)\\b`).test(maskedBody)) types.push('str');
    else types.push('int');
  }
  return types;
}

function eligible(fn, lang, structure, lines, { guess = false } = {}) {
  if (fn.cls || fn.isAsync) return null;
  if (fn.end - fn.start > 40) return null;
  let types = paramTypes(fn, lang);
  if (!types && guess && (lang === 'typescript' || lang === 'javascript')) {
    types = guessTypes(fn, structure.masked.split('\n').slice(fn.start - 1, fn.end).join('\n'));
  }
  if (!types) return null;
  if (lang === 'cpp' || lang === 'c') {
    if (!fn.retType || /\bvoid\b|\*|auto/.test(fn.retType) || (!cppType(fn.retType) && !/^(std::)?(string|vector<.*>|pair<.*>)$/.test(fn.retType.replace(/const|&/g, '').trim()))) return null;
  }
  const bodies = closure(fn, structure, lines);
  const text = bodies.join('\n');
  const masked = structure.masked.split('\n').slice(fn.start - 1, fn.end).join('\n');
  if (IMPURE.test(masked)) return null;
  if (lang === 'python' && /\bglobal\b|\bnonlocal\b/.test(masked)) return null;
  // Calls must resolve to known pure things: same-file functions, builtins, methods.
  return { types, bodies, text };
}

function harness(fn, lang, info, args, structure, lines) {
  if (lang === 'python') {
    const imports = lines.filter((l) => PY_ALLOWED_IMPORTS.test(l)).join('\n');
    return `${imports}\n\n${info.bodies.join('\n\n')}\n\nprint(repr(${fn.name}(${args.join(', ')})))\n`;
  }
  if (lang === 'typescript') {
    const bodies = info.bodies.map((b) => b.replace(/^\s*export\s+(default\s+)?/, ''));
    return `${bodies.join('\n\n')}\n\nconsole.log(JSON.stringify(${fn.name}(${args.join(', ')})));\n`;
  }
  const includes = ['iostream', 'vector', 'string', 'algorithm', 'numeric', 'cmath', 'map', 'unordered_map', 'set', 'unordered_set', 'utility', 'sstream', 'cstdint', 'climits', 'functional', 'deque', 'queue', 'stack', 'string_view']
    .map((h) => `#include <${h}>`).join('\n');
  const using = /\bstd::/.test(info.text) ? '' : 'using namespace std;\n';
  const printer = `
template <class T> void dd_print(const T& v) { std::cout << std::boolalpha << v; }
inline void dd_print(const std::string& s) { std::cout << '"' << s << '"'; }
template <class T> void dd_print(const std::vector<T>& v) { std::cout << '['; for (size_t i = 0; i < v.size(); ++i) { if (i) std::cout << ", "; dd_print(v[i]); } std::cout << ']'; }
template <class A, class B> void dd_print(const std::pair<A, B>& p) { std::cout << '('; dd_print(p.first); std::cout << ", "; dd_print(p.second); std::cout << ')'; }
`;
  return `${includes}\n${using}${printer}\n${info.bodies.join('\n\n')}\n\nint main() { dd_print(${fn.name}(${args.join(', ')})); std::cout << std::endl; return 0; }\n`;
}

function langFor(lang) {
  return lang === 'typescript' || lang === 'javascript' ? 'typescript' : lang;
}

/**
 * Build a predict-the-output question for a function, or null.
 * Returns {code, call, output, difficulty}
 */
function buildPredict(fn, lang, structure, src, { timeoutSec = 5 } = {}) {
  const l = langFor(lang);
  if (lang === 'javascript') return null; // untyped JS: no safe inputs
  const lines = src.split('\n');
  const info = eligible(fn, l, structure, lines);
  if (!info) return null;
  const sets = inputSets(info.types, l, 6);
  // Prefer an input that exercises a non-trivial path: try several, keep first with non-empty output.
  let fallback = null;
  for (const args of sets.slice(0, 4)) {
    const code = harness(fn, l, info, args, structure, lines);
    const r = runDeterministic(code, l, { timeoutSec });
    if (!r.ok || !r.deterministic) continue;
    const out = normalizeOutput(r.stdout);
    if (!out || out.length > 200) continue;
    const trivial = /^(""|''|0|\[\]|None|null|undefined|false|False)$/.test(out);
    const q = {
      shown: info.bodies.join('\n\n'),
      call: `${fn.name}(${args.join(', ')})`,
      output: out,
      difficulty: fn.end - fn.start > 15 ? 'hard' : 'medium',
      lang: l,
    };
    if (!trivial) return q;
    fallback = fallback || q;
  }
  return fallback;
}

/**
 * Behavioural equivalence check for a mutant of a pure function: run original
 * and mutant on several inputs. Returns true (changes behaviour), false
 * (equivalent on all inputs) or null (couldn't check).
 */
function mutantChangesBehaviour(fn, lang, structure, src, mutatedFnCode, { timeoutSec = 5 } = {}) {
  const l = langFor(lang);
  const lines = src.split('\n');
  const info = eligible(fn, l, structure, lines, { guess: true });
  if (!info) return null;
  const origFn = lines.slice(fn.start - 1, fn.end).join('\n');
  const mutInfo = { ...info, bodies: info.bodies.map((b) => (b === origFn ? mutatedFnCode : b)) };
  let checked = 0;
  for (const args of inputSets(info.types, l, 6)) {
    const a = runSnippet(harness(fn, l, info, args, structure, lines), l, { timeoutSec });
    if (!a.ok) continue;
    const b = runSnippet(harness(fn, l, mutInfo, args, structure, lines), l, { timeoutSec });
    checked++;
    if (!b.ok || normalizeOutput(a.stdout) !== normalizeOutput(b.stdout)) return true;
  }
  return checked ? false : null;
}

module.exports = { buildPredict, mutantChangesBehaviour, paramTypes, splitParams };
