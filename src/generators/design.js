'use strict';
// Family C: design and reasoning questions about Claude's change.
// Structural questions are answered from the parsed code (verified).
// "Why Claude did it" is answered from Claude's own stated reasoning in the
// session transcript (cited). Critique / "why this fits" are feedback only.

const { shuffle, pick } = require('../util');
const { splitReason } = require('../rationale');
const { trackFor } = require('../lang');

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'];

const TYPE_POOL = {
  cpp: [
    'std::vector<T>', 'std::deque<T>', 'std::list<T>', 'std::map<K, V>', 'std::unordered_map<K, V>', 'std::set<T>',
    'std::unordered_set<T>', 'std::priority_queue<T>', 'std::queue<T>', 'std::stack<T>', 'std::array<T, N>',
    'std::shared_ptr<T>', 'std::unique_ptr<T>', 'std::atomic<T>', 'std::optional<T>', 'std::multimap<K, V>', 'std::mutex', 'std::string',
  ],
  python: [
    'list', 'dict', 'set', 'tuple', 'collections.deque', 'collections.defaultdict(list)', 'collections.Counter',
    'collections.OrderedDict', 'list used as a binary heap (heapq)', 'queue.Queue', 'frozenset', 'threading.Lock',
  ],
  javascript: ['Array', 'Object', 'Map<K, V>', 'Set<T>', 'WeakMap<K, V>', 'Int32Array', 'Record<K, V>', 'Promise<T>'],
};

function choiceQ(correct, distractors, rnd) {
  const opts = shuffle([correct, ...distractors.slice(0, 3)], rnd);
  return { choices: Object.fromEntries(opts.map((o, i) => [KEYS[i], o])), answer: KEYS[opts.indexOf(correct)] };
}

function poolFor(lang) {
  if (lang === 'c' || lang === 'cpp') return TYPE_POOL.cpp;
  if (lang === 'python') return TYPE_POOL.python;
  return TYPE_POOL.javascript;
}

/** Simplify a concrete type into the pool's generic shape for matching distractors. */
function family(type) {
  return type.replace(/<.*>/, '').replace(/\(.*\)/, '').replace(/\s*\(annotated.*$/, '').trim();
}

function dataStructureQs(ctx, fileInfo, rnd) {
  const out = [];
  const { file, lang, structure, addedSet } = fileInfo;
  for (const mem of structure.members) {
    if (!addedSet.has(mem.line)) continue;
    const correct = mem.type.replace(/\s*\(annotated.*$/, '');
    const distract = shuffle(poolFor(lang).filter((t) => family(t) !== family(correct) && t !== correct), rnd);
    if (distract.length < 3) continue;
    const { choices, answer } = choiceQ(correct, distract, rnd);
    const where = mem.owner ? ` (${mem.scope} of \`${mem.owner}\`)` : '';
    const diff = mem.scope === 'member' ? 'medium' : 'easy';
    out.push({
      family: 'design',
      type: 'data_structure',
      format: 'choice',
      topic: `dsa/containers`,
      track: trackFor(lang),
      difficulty: diff,
      grading: 'verified',
      xp: diff === 'medium' ? 10 : 5,
      est_seconds: 40,
      title: 'Design · Data structure',
      prompt: `\`${mem.name}\`${where} is declared in ${file}:${mem.line} in Claude's change. What is it?`,
      choices,
      answer,
      explanation: `Read from the declaration at ${file}:${mem.line}: \`${mem.name}\` is ${correct}.`,
      evidence: `${file}:${mem.line}`,
      code_file: file,
      code_start: mem.line,
      code_end: mem.line,
      meta: { symbol: mem.name, container: mem.container },
    });
    // follow-up: why this fits (feedback only)
    if (mem.scope === 'member' && out.filter((q) => q.type === 'why_fits').length === 0) {
      out.push({
        family: 'design', type: 'why_fits', format: 'text', topic: 'dsa/containers', track: trackFor(lang), difficulty: 'medium',
        grading: 'feedback', xp: 0, est_seconds: 120, title: 'Design · Why this choice fits',
        prompt: `Why is ${correct} a reasonable choice for \`${mem.name}\` here, and when would a different container be better?`,
        code_file: file, code_start: mem.line, code_end: mem.line, explanation: 'Open question: feedback only, no XP.', meta: { symbol: mem.name },
      });
    }
  }
  return out;
}

function architectureQs(ctx, files, allFunctions, rnd) {
  const out = [];
  const changedFns = allFunctions.filter((f) => f.changed);
  const fileList = [...new Set(files.map((f) => f.file))];
  const others = shuffle((ctx.repoFiles || []).filter((f) => !fileList.includes(f) && /\.(c|cc|cpp|cxx|h|hpp|py|js|ts|tsx|mjs)$/.test(f)), rnd);

  // 1. Which file defines new function X?
  for (const fn of shuffle(changedFns.filter((f) => f.isNew), rnd).slice(0, 1)) {
    const distract = shuffle(fileList.filter((f) => f !== fn.file).concat(others), rnd).slice(0, 3);
    if (distract.length < 3) break;
    const { choices, answer } = choiceQ(fn.file, distract, rnd);
    out.push({
      family: 'design', type: 'architecture', format: 'choice', topic: 'architecture/ownership', track: trackFor(fn.lang),
      difficulty: 'easy', grading: 'verified', xp: 10, est_seconds: 30, title: 'Design · Architecture: what changed',
      prompt: `Claude added \`${fn.qualified}\`. Which file owns it now?`, choices, answer,
      explanation: `\`${fn.qualified}\` is defined at ${fn.file}:${fn.start}.`, evidence: `${fn.file}:${fn.start}-${fn.end}`,
      code_file: fn.file, code_start: fn.start, code_end: fn.end, meta: { symbol: fn.qualified },
    });
  }

  // 2. Which of these does X call directly? (multiple select)
  const byName = new Map(allFunctions.map((f) => [f.name, f]));
  for (const fn of shuffle(changedFns, rnd)) {
    const known = fn.calls.filter((c) => byName.has(c) && c !== fn.name);
    if (!known.length) continue;
    const notCalled = shuffle(allFunctions.filter((f) => !fn.calls.includes(f.name) && f.name !== fn.name).map((f) => f.name), rnd);
    const correct = shuffle(known, rnd).slice(0, 2);
    const wrong = [...new Set(notCalled)].slice(0, 4 - correct.length);
    if (correct.length + wrong.length < 3) continue;
    const opts = shuffle([...correct, ...wrong], rnd);
    out.push({
      family: 'design', type: 'architecture', format: 'multi', topic: 'architecture/call-graph', track: trackFor(fn.lang),
      difficulty: 'medium', grading: 'verified', xp: 10, est_seconds: 60, title: 'Design · Architecture: call graph',
      prompt: `Which of these does \`${fn.qualified}\` (${fn.file}:${fn.start}) call directly? Select all that apply (e.g. "a,c").`,
      choices: Object.fromEntries(opts.map((o, i) => [KEYS[i], `\`${o}\``])),
      answer: correct.map((c) => KEYS[opts.indexOf(c)]).sort(),
      explanation: `Parsed from the body of \`${fn.qualified}\`: it calls ${correct.map((c) => `\`${c}\``).join(', ')}.`,
      evidence: `${fn.file}:${fn.start}-${fn.end}`, code_file: fn.file, code_start: fn.start, code_end: fn.end,
      meta: { symbol: fn.qualified },
    });
    break;
  }

  // 3. Order the call path A -> B -> C (needs a chain of length >= 3 touching the change).
  const chainFrom = (f, seen) => {
    for (const c of f.calls) {
      const g = byName.get(c);
      if (g && !seen.has(g.name)) {
        const rest = chainFrom(g, new Set([...seen, g.name]));
        return [g, ...rest];
      }
    }
    return [];
  };
  for (const fn of shuffle(changedFns, rnd)) {
    const chain = [fn, ...chainFrom(fn, new Set([fn.name]))].slice(0, 4);
    if (chain.length < 3) continue;
    const order = chain.map((_, i) => KEYS[i]);
    const shuffled = shuffle(chain.map((f, i) => ({ f, k: KEYS[i] })), rnd);
    const items = Object.fromEntries(shuffled.map((x, i) => [KEYS[i], `\`${x.f.qualified}\``]));
    const answer = order.map((k) => KEYS[shuffled.findIndex((x) => x.k === k)]);
    out.push({
      family: 'design', type: 'architecture', format: 'ordering', topic: 'architecture/call-path', track: trackFor(fn.lang),
      difficulty: 'hard', grading: 'verified', xp: 20, est_seconds: 90, title: 'Design · Architecture: call path',
      prompt: `Order the call path that starts at \`${fn.qualified}\` (outermost caller first). Enter the letters in order, e.g. "c,a,b".`,
      choices: items, answer,
      explanation: `Call path from the parsed call graph: ${chain.map((f) => f.qualified).join(' → ')}.`,
      evidence: chain.map((f) => `${f.file}:${f.start}`).join(' → '),
      code_file: fn.file, code_start: fn.start, code_end: fn.end, meta: { chain: chain.map((f) => f.qualified) },
    });
    break;
  }

  // 4. Which class owns method X?
  const methods = changedFns.filter((f) => f.cls);
  const classes = [...new Set(allFunctions.filter((f) => f.cls).map((f) => f.cls).concat(ctx.classNames || []))];
  for (const fn of shuffle(methods, rnd).slice(0, 1)) {
    const distract = shuffle(classes.filter((c) => c !== fn.cls), rnd).slice(0, 3);
    if (distract.length < 2) break;
    const opts = shuffle([fn.cls, ...distract], rnd);
    out.push({
      family: 'design', type: 'architecture', format: 'choice', topic: 'architecture/ownership', track: trackFor(fn.lang),
      difficulty: 'easy', grading: 'verified', xp: 10, est_seconds: 30, title: 'Design · Architecture: ownership',
      prompt: `Which class owns \`${fn.name}()\` as changed by Claude in ${fn.file}?`,
      choices: Object.fromEntries(opts.map((o, i) => [KEYS[i], o])), answer: KEYS[opts.indexOf(fn.cls)],
      explanation: `\`${fn.name}\` is a member of \`${fn.cls}\` (${fn.file}:${fn.start}).`, evidence: `${fn.file}:${fn.start}`,
      code_file: fn.file, code_start: fn.start, code_end: fn.end, meta: { symbol: fn.qualified },
    });
  }
  return out;
}

const GENERIC_REASONS = [
  'to keep the output order deterministic for tests',
  'to reduce memory use',
  'because the compiler required it to build',
  'to make startup faster',
  'to match the existing code style only',
  'so that the function can be called from other threads without locks',
  'to avoid an extra network round trip',
  'because the old API was deprecated in the standard library',
  'so that logging output is easier to read',
  'to support Windows paths',
];

/** Offline "why Claude did it" questions from extracted rationale. */
function whyQs(ctx, rationale, rnd) {
  const out = [];
  if (!rationale || !rationale.sentences.length) return out;
  const usable = rationale.sentences.map((s) => ({ s, parts: splitReason(s.sentence) })).filter((x) => x.parts);
  for (const { s, parts } of usable.slice(0, 2)) {
    const otherReasons = usable.filter((x) => x.s !== s).map((x) => x.parts.reason);
    const pool = shuffle(otherReasons.concat(GENERIC_REASONS), rnd).filter((r) => r.toLowerCase() !== parts.reason.toLowerCase());
    if (pool.length < 3) continue;
    const { choices, answer } = choiceQ(parts.reason, pool, rnd);
    const file = s.files[0] || null;
    out.push({
      family: 'design', type: 'why', format: 'choice', topic: 'reasoning/why', track: ctx.track || 'general',
      difficulty: 'medium', grading: 'session', xp: 10, est_seconds: 45, title: 'Design · Why Claude did it',
      prompt: `In this session Claude: "${parts.action}". According to Claude, why?`,
      choices, answer,
      explanation: `Claude said (turn ${rationale.turn}): "${s.sentence}"`,
      evidence: `transcript turn ${rationale.turn}, message ${s.ref || 'n/a'}`,
      code_file: file,
      meta: { turn: rationale.turn, ref: s.ref, sentence: s.sentence },
    });
  }
  return out;
}

function critiqueQ(ctx, fn) {
  return {
    family: 'design', type: 'critique', format: 'text', topic: 'reasoning/critique', track: trackFor(fn.lang),
    difficulty: 'medium', grading: 'feedback', xp: 0, est_seconds: 180, title: 'Design · Critique',
    prompt: `Do you agree with how Claude implemented \`${fn.qualified}\` (${fn.file}:${fn.start}-${fn.end})? What would you change? ` +
      'Your answer is saved as a note; if it points at a real defect, run /diffdojo:report-bug to prove it with a failing test.',
    code_file: fn.file, code_start: fn.start, code_end: fn.end,
    explanation: 'Open question: feedback only, no XP.', meta: { symbol: fn.qualified },
  };
}

module.exports = { dataStructureQs, architectureQs, whyQs, critiqueQ, GENERIC_REASONS, choiceQ, pick };
