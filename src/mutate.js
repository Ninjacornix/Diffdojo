'use strict';
// Mutation library. Each operator inspects comment/string-masked lines and
// proposes single-line mutations. Categories gate unlocks:
//   basic       — always available
//   concurrency — Green belt (missing lock, relaxed ordering, dropped await)
//   lifetime    — Green belt (copy instead of reference, dropped std::move)
// Custom operators (Black belt) are loaded from ~/.diffdojo/operators/*.json.

const fs = require('fs');
const path = require('path');
const { mask, family } = require('./lang');
const { home, readJson } = require('./util');

const SYMMETRIC = new Set(['max', 'min', 'swap', 'equal', 'hypot', 'gcd', 'lcm', 'isEqual', 'assertEqual', 'assertEquals',
  'add', 'Math.max', 'Math.min', 'std::max', 'std::min', 'set', 'eq', 'isclose', 'zip', 'print', 'console.log', 'printf']);

function at(raw, idx, len, repl) {
  return raw.slice(0, idx) + repl + raw.slice(idx + len);
}

/** Generic regex operator: every match of `re` on the masked line yields a mutation. */
function regexOp(id, opts) {
  return {
    id,
    families: opts.families,
    category: opts.category || 'basic',
    explain: opts.explain,
    apply(ml, raw, ctx) {
      if (opts.when && !opts.when(ml, ctx)) return [];
      const out = [];
      const re = new RegExp(opts.re.source, 'g');
      let m;
      while ((m = re.exec(ml))) {
        const g = m.index + (opts.group ? m[0].indexOf(m[opts.group]) : 0);
        const text = opts.group ? m[opts.group] : m[0];
        const repl = typeof opts.to === 'function' ? opts.to(text, m, ctx) : opts.to[text];
        if (repl == null || repl === text) continue;
        out.push({ mutated: at(raw, g, text.length, repl), from: text, to: repl });
      }
      return out;
    },
  };
}

const COND = /^\s*(?:\}?\s*(?:else\s+)?if\b|while\b|for\b|elif\b|return\b|assert\b|.*\?\s*.*:)/;

const OPS = [
  regexOp('boundary', {
    families: ['c', 'js', 'py'],
    re: /\s(<=|>=|<|>)\s/,
    group: 1,
    when: (ml) => COND.test(ml) || /=\s*[^=].*\s[<>]=?\s/.test(ml),
    to: { '<': '<=', '<=': '<', '>': '>=', '>=': '>' },
    explain: (m) => `The comparison \`${m.from}\` became \`${m.to}\`, moving the boundary by one. The edge value is now handled on the wrong side (an off-by-one).`,
  }),
  regexOp('equality', {
    families: ['c', 'js', 'py'],
    re: /\s(===|!==|==|!=)\s/,
    group: 1,
    to: { '==': '!=', '!=': '==', '===': '!==', '!==': '===' },
    explain: (m) => `The equality test \`${m.from}\` was inverted to \`${m.to}\`, so the branch runs in exactly the wrong cases.`,
  }),
  regexOp('logic', {
    families: ['c', 'js'],
    re: /\s(&&|\|\|)\s/,
    group: 1,
    to: { '&&': '||', '||': '&&' },
    explain: (m) => `The logical operator \`${m.from}\` became \`${m.to}\`, so the condition is true in a different set of cases.`,
  }),
  regexOp('py-logic', {
    families: ['py'],
    re: /\s(and|or)\s/,
    group: 1,
    to: { and: 'or', or: 'and' },
    explain: (m) => `\`${m.from}\` became \`${m.to}\`, so the condition is true in a different set of cases.`,
  }),
  regexOp('py-none', {
    families: ['py'],
    re: /\bis( not)? None\b/,
    to: (t) => (t.includes('not') ? 'is None' : 'is not None'),
    explain: (m) => `\`${m.from}\` was inverted to \`${m.to}\`, so the None check passes when it should fail.`,
  }),
  regexOp('arith', {
    families: ['c', 'js', 'py'],
    re: /(?<=[\w)\]])\s([+-])=?\s/,
    group: 1,
    when: (ml) => !/^\s*(#|\/\/)/.test(ml),
    to: { '+': '-', '-': '+' },
    explain: (m) => `An arithmetic \`${m.from}\` became \`${m.to}\`, so the computed value is wrong.`,
  }),
  regexOp('incdec', {
    families: ['c', 'js'],
    re: /(\+\+|--)/,
    group: 1,
    when: (ml) => !/^\s*for\s*\(/.test(ml), // i++ -> i-- in a for header is an infinite loop, not a puzzle
    to: { '++': '--', '--': '++' },
    explain: (m) => `\`${m.from}\` became \`${m.to}\`, so the counter moves in the wrong direction.`,
  }),
  regexOp('negation', {
    families: ['c', 'js'],
    re: /(?<=[(\s&|])!(?=[A-Za-z_(])/,
    when: (ml) => COND.test(ml),
    to: () => '',
    explain: () => 'A `!` negation was dropped, so the condition is inverted.',
  }),
  regexOp('py-not', {
    families: ['py'],
    re: /\bnot (?!in\b)/,
    when: (ml) => COND.test(ml),
    to: () => '',
    explain: () => 'A `not` was dropped, so the condition is inverted.',
  }),
  regexOp('bool-return', {
    families: ['c', 'js', 'py'],
    re: /\breturn (true|false|True|False)\b/,
    group: 1,
    to: { true: 'false', false: 'true', True: 'False', False: 'True' },
    explain: (m) => `The function now returns \`${m.to}\` instead of \`${m.from}\` on this path.`,
  }),
  regexOp('loop-start', {
    families: ['c', 'js'],
    re: /\bfor\s*\(\s*(?:[\w:<>]+\s+)?\w+\s*=\s*(0)\s*;/,
    group: 1,
    to: { 0: '1' },
    explain: () => 'The loop now starts at 1 instead of 0, so the first element is skipped (off-by-one).',
  }),
  regexOp('py-range', {
    families: ['py'],
    re: /\brange\(([^()]*(?:\([^()]*\)[^()]*)*)\)/,
    to: (t, m) => {
      const inner = m[1];
      const parts = inner.split(',');
      if (parts.length > 2) return null;
      parts[parts.length - 1] = parts[parts.length - 1].trimEnd() + ' - 1';
      return `range(${parts.join(',')})`;
    },
    explain: () => 'The range end was reduced by one, so the last iteration is skipped (off-by-one).',
  }),
  regexOp('py-slice', {
    families: ['py'],
    re: /\[(\w+) ?\+ ?1\]/,
    to: (t, m) => `[${m[1]}]`,
    explain: () => 'An index `i + 1` became `i`, so the code reads the wrong element.',
  }),
  {
    id: 'swap-args',
    families: ['c', 'js', 'py'],
    category: 'basic',
    explain: (m) => `The two arguments of \`${m.fn}\` were swapped.`,
    apply(ml, raw) {
      const out = [];
      const re = /([A-Za-z_][\w.:]*)\(\s*([A-Za-z_][\w.]*|\d+)\s*,\s*([A-Za-z_][\w.]*|\d+)\s*\)/g;
      let m;
      while ((m = re.exec(ml))) {
        const fn = m[1];
        const base = fn.split(/[.:]/).pop();
        if (SYMMETRIC.has(fn) || SYMMETRIC.has(base) || m[2] === m[3]) continue;
        if (/^(if|while|for|switch|return|range|isinstance|getattr|hasattr|setattr)$/.test(base)) continue;
        const idx = m.index;
        const repl = `${fn}(${m[3]}, ${m[2]})`;
        out.push({ mutated: at(raw, idx, m[0].length, repl), from: m[0], to: repl, fn });
      }
      return out;
    },
  },
  {
    id: 'drop-jump',
    families: ['c', 'js', 'py'],
    category: 'basic',
    explain: (m) => `A \`${m.from}\` statement was removed, so control flow falls through where it used to ${m.from === 'continue' ? 'skip to the next iteration' : m.from === 'break' ? 'leave the loop' : 'return early'}.`,
    apply(ml, raw, ctx) {
      const out = [];
      if (ctx.fam === 'py') {
        const m = /^(\s*)(continue|break)\s*$/.exec(ml);
        if (m) out.push({ mutated: `${m[1]}pass`, from: m[2], to: 'pass' });
        return out;
      }
      const inline = /(\s*)\b(continue|break);/.exec(ml);
      if (inline) {
        const before = ml.slice(0, inline.index);
        if (before.trim()) {
          out.push({ mutated: at(raw, inline.index, inline[0].length, ''), from: inline[2], to: '' });
        } else {
          out.push({ remove: true, from: inline[2], to: '' });
        }
      }
      return out;
    },
  },
  // ---- concurrency
  {
    id: 'drop-lock',
    families: ['c'],
    category: 'concurrency',
    explain: () => 'The lock guard was removed, so this critical section is no longer protected: concurrent callers race on the shared state (a data race).',
    apply(ml) {
      if (/\bstd::(lock_guard|unique_lock|scoped_lock)\b|\b(lock_guard|unique_lock|scoped_lock)\s*</.test(ml) || /^\s*[\w.>-]+\.lock\(\);\s*$/.test(ml) || /pthread_mutex_lock\(/.test(ml)) {
        return [{ remove: true, from: ml.trim(), to: '' }];
      }
      return [];
    },
  },
  regexOp('relaxed-order', {
    families: ['c'],
    category: 'concurrency',
    re: /\b(?:std::)?memory_order_(acquire|release|acq_rel|seq_cst)\b/,
    to: (t) => t.replace(/memory_order_\w+/, 'memory_order_relaxed'),
    explain: (m) => `\`${m.from}\` was weakened to \`memory_order_relaxed\`, which removes the happens-before edge other threads rely on.`,
  }),
  regexOp('drop-await', {
    families: ['js', 'py'],
    category: 'concurrency',
    re: /\bawait\s+/,
    to: () => '',
    explain: () => 'An `await` was dropped, so the code uses a pending promise/coroutine instead of its result and no longer waits for it to finish.',
  }),
  {
    id: 'py-drop-lock',
    families: ['py'],
    category: 'concurrency',
    explain: () => 'The `with lock:` guard was replaced by a no-op context, so the block is no longer mutually exclusive.',
    apply(ml, raw) {
      const m = /^(\s*)(async\s+)?with\s+([\w.]*(?:lock|mutex|Lock|_mu|sem)\w*)\s*:\s*$/.exec(ml);
      if (!m) return [];
      return [{ mutated: `${m[1]}${m[2] || ''}with contextlib.nullcontext():`, from: raw.trim(), to: 'contextlib.nullcontext()' }];
    },
  },
  // ---- lifetime
  regexOp('ref-to-copy', {
    families: ['c'],
    category: 'lifetime',
    re: /\bfor\s*\(\s*(?:const\s+)?auto\s*(&&?)\s*\w+\s*:/,
    group: 1,
    when: (ml) => !/\bconst\b/.test(ml),
    to: () => '',
    explain: () => 'The range-for variable became a copy instead of a reference, so writes inside the loop modify a temporary and are lost.',
  }),
  regexOp('drop-move', {
    families: ['c'],
    category: 'lifetime',
    re: /std::move\(([^()]+)\)/,
    to: (t, m) => m[1],
    explain: () => '`std::move` was removed, so the object is copied rather than moved (for move-only types this no longer compiles; for others it changes ownership and cost).',
  }),
];

function loadCustomOps() {
  const dir = path.join(home(), 'operators');
  const ops = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const spec = readJson(path.join(dir, f), null);
      if (!spec || !spec.id || !spec.pattern || spec.replacement == null) continue;
      let re;
      try {
        re = new RegExp(spec.pattern);
      } catch {
        continue;
      }
      ops.push(regexOp(`custom:${spec.id}`, {
        families: spec.families || ['c', 'js', 'py'],
        category: 'custom',
        re,
        to: (t) => t.replace(re, spec.replacement),
        explain: () => spec.explanation || `Custom operator ${spec.id} changed this line.`,
      }));
    }
  } catch {
    /* no custom operators */
  }
  return ops;
}

function difficultyFor(lines, idx, category, fnLength) {
  if (category === 'concurrency' || category === 'lifetime') return 'hard';
  const ind = (s) => s.match(/^\s*/)[0].length;
  const firstBody = lines.slice(1).find((l) => l.trim()) || '';
  const inner = ind(lines[idx]) > ind(firstBody) || COND.test(lines[idx]) || /\bcatch\b|\bexcept\b/.test(lines[idx]);
  if (inner && fnLength > 35) return 'hard';
  if (inner) return 'medium';
  return 'easy';
}

/**
 * Enumerate mutants of a code excerpt.
 * @returns [{op, category, line, original, mutatedLine, removed, acceptLines, code, difficulty, explanation}]
 * `line` and `acceptLines` are 1-based positions in the *mutated* code as displayed.
 */
function mutants(code, lang, { categories = ['basic'], custom = false, headerLines = 1 } = {}) {
  const fam = family(lang);
  if (!fam) return [];
  const lines = code.split('\n');
  const mlines = mask(code, lang).split('\n');
  const ops = OPS.concat(custom ? loadCustomOps() : []).filter(
    (o) => o.families.includes(fam) && (categories.includes(o.category) || o.category === 'custom'),
  );
  const out = [];
  for (let i = headerLines; i < lines.length; i++) {
    const ml = mlines[i];
    if (/^\s*(?:async\s+)?def\s|^\s*(?:export\s+)?(?:async\s+)?function\b/.test(ml)) continue;
    if (!ml.trim() || /^\s*#\s*(include|define|if|endif|pragma)/.test(ml)) continue;
    if (/^\s*(import|from|using|#include)\b/.test(ml)) continue;
    for (const op of ops) {
      let found;
      try {
        found = op.apply(ml, lines[i], { fam, lang });
      } catch {
        continue;
      }
      for (const f of found) {
        let newLines;
        let line;
        let acceptLines;
        if (f.remove) {
          newLines = lines.slice(0, i).concat(lines.slice(i + 1));
          line = Math.min(i + 1, newLines.length);
          acceptLines = [i, i + 1].filter((n) => n >= 1 && n <= newLines.length);
        } else {
          if (f.mutated === lines[i]) continue;
          newLines = lines.slice();
          newLines[i] = f.mutated;
          line = i + 1;
          acceptLines = [i + 1];
        }
        out.push({
          op: op.id,
          category: op.category,
          line,
          originalLine: i + 1,
          original: lines[i],
          mutatedLine: f.remove ? null : f.mutated,
          removed: !!f.remove,
          acceptLines,
          code: newLines.join('\n'),
          difficulty: difficultyFor(lines, i, op.category, lines.length),
          explanation: op.explain(f),
        });
      }
    }
  }
  return out;
}

module.exports = { mutants, OPS, loadCustomOps };
