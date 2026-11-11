'use strict';
// Question pipeline, run by the async Stop hook (and `diffdojo generate`):
//   diff collector -> structure analyzer -> topic detector -> rationale extractor
//   -> generators (code / design / questionnaire, optional model path)
//   -> validation -> secret scan -> SQLite queue.

const fs = require('fs');
const path = require('path');
const git = require('./git');
const lang = require('./lang');
const { analyze } = require('./lang/structure');
const { matchesAny } = require('./glob');
const { hasSecret } = require('./secrets');
const topics = require('./topics');
const rationale = require('./rationale');
const rewards = require('./rewards');
const store = require('./store');
const model = require('./model');
const codeGen = require('./generators/code');
const design = require('./generators/design');
const { buildPredict } = require('./generators/predict');
const { conceptQs } = require('./generators/concepts');
const { pickPack } = require('./generators/questionnaire');
const { repoDir, readJson, writeJson, nowIso, log, shuffle, ensureDir } = require('./util');

// ---------- session state (plain JSON so hooks stay fast)

function sessionFile(repoId, sessionId) {
  return path.join(repoDir(repoId), 'sessions', `${String(sessionId).replace(/[^\w-]/g, '_')}.json`);
}

function loadSession(repoId, sessionId) {
  return readJson(sessionFile(repoId, sessionId), null);
}

function saveSession(repoId, sessionId, data) {
  writeJson(sessionFile(repoId, sessionId), data);
}

function startSession(root, repoId, sessionId) {
  const existing = loadSession(repoId, sessionId);
  if (existing) return existing; // resume: keep the original base
  const s = { id: sessionId, started_at: nowIso(), base_head: git.head(root), base_tree: git.baseTree(root), last_tree: null, last_stop_at: null, generated: 0 };
  s.last_tree = s.base_tree;
  saveSession(repoId, sessionId, s);
  return s;
}

// ---------- lock

function withLock(repoId, fn) {
  const file = path.join(ensureDir(repoDir(repoId)), 'generate.lock');
  try {
    const cur = readJson(file, null);
    if (cur) {
      let alive = false;
      try {
        process.kill(cur.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive && Date.now() - cur.at < 10 * 60000) return { locked: true };
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch (e) {
    log('lock', e);
  }
  const release = () => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
  let r;
  try {
    r = fn();
  } catch (e) {
    release();
    throw e;
  }
  if (r && typeof r.then === 'function') return r.finally(release);
  release();
  return r;
}

// ---------- events

function eventsFile(repoId) {
  return path.join(repoDir(repoId), 'events.jsonl');
}

function readEvents(repoId, sinceIso) {
  let text = '';
  try {
    text = fs.readFileSync(eventsFile(repoId), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!sinceIso || e.ts > sinceIso) out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

// ---------- collection

function collect(root, cfg, fromTree, toTree, onlyFiles) {
  let files = git.changedFiles(root, fromTree, toTree);
  if (onlyFiles) {
    const set = new Set(onlyFiles.map((f) => f.replace(/\\/g, '/')));
    files = files.filter((f) => set.has(f));
  }
  files = files.filter((f) => !matchesAny(f, cfg.deny) && (!cfg.allow.length || matchesAny(f, cfg.allow)) && lang.detect(f));
  if (!files.length) return [];
  const parsed = git.parseDiff(git.diff(root, fromTree, toTree, files));
  const out = [];
  let budget = cfg.maxChangedLines;
  for (const d of parsed) {
    if (d.binary || d.deleted || !d.added.length) continue;
    if (budget <= 0) break;
    const l = lang.detect(d.file);
    let src;
    try {
      src = fs.readFileSync(path.join(root, d.file), 'utf8');
    } catch {
      continue;
    }
    if (src.length > 1024 * 1024 || /\u0000/.test(src)) continue;
    const added = d.added.slice(0, budget);
    budget -= added.length;
    const addedText = d.hunks.flatMap((h) => h.lines.filter((x) => x.t === '+').map((x) => x.text)).join('\n');
    out.push({ file: d.file, lang: l, src, added, addedSet: new Set(added), addedText, created: d.created, removedCount: d.removed });
  }
  return out;
}

/** Old version of a file (to tell new functions from changed ones). */
function oldFunctionNames(root, fromTree, file, l) {
  const old = git.showFile(root, fromTree, file);
  if (old == null) return new Set();
  return new Set(analyze(old, l).functions.map((f) => f.qualified));
}

// ---------- main

function mixCounts(cfg, total) {
  const fams = cfg.families || ['code', 'design', 'questionnaire'];
  const mix = Object.fromEntries(fams.map((f) => [f, cfg.mix[f] || 0]));
  const sum = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  let left = total;
  for (const f of fams) {
    out[f] = Math.floor((total * mix[f]) / sum);
    left -= out[f];
  }
  for (const f of fams) {
    if (left <= 0) break;
    out[f]++;
    left--;
  }
  return out;
}

function clean(q, cfg) {
  if (q.code && q.code.split('\n').length > cfg.maxExcerptLines * 1.5) return null;
  if (hasSecret(q.code) || hasSecret(q.prompt) || hasSecret(q.explanation) || hasSecret(q.evidence)) return null;
  return q;
}

/**
 * Generate questions for the change fromTree -> toTree.
 * @returns {Promise<{questions:number, files:number, topics:string[], skipped?:string}>}
 */
async function generate(opts) {
  const { db, root, repoId, sessionId, cfg } = opts;
  const rnd = opts.rnd || Math.random;
  const deadline = opts.deadline || Date.now() + 240000;
  const files = collect(root, cfg, opts.fromTree, opts.toTree, opts.onlyFiles);

  // Topic detection always runs (also feeds questionnaire-only refills).
  const scores = topics.detect(files.map((f) => ({ file: f.file, lang: f.lang, addedText: f.addedText })), root);
  if (scores.size) topics.updateProfile(db, repoId, scores);

  const batch = `${nowIso()}#${sessionId || 'manual'}`;
  const created = { design: [], code: [], questionnaire: [] };
  const total = Math.max(0, Math.min(cfg.questionsPerTurn, opts.cap == null ? cfg.questionsPerTurn : opts.cap));
  const want = mixCounts(cfg, total);
  if (!files.length) {
    // No new diff: the queue is filled with questionnaire questions only (if the queue is low).
    want.questionnaire = (want.code || 0) + (want.design || 0) + (want.questionnaire || 0);
    want.code = 0;
    want.design = 0;
  }

  // Structure
  const allFunctions = [];
  const classNames = [];
  const fileInfos = files.map((f) => {
    const structure = analyze(f.src, f.lang);
    const old = oldFunctionNames(root, opts.fromTree, f.file, f.lang);
    const lines = f.src.split('\n');
    for (const fn of structure.functions) {
      let changed = false;
      for (let l = fn.start; l <= fn.end; l++) if (f.addedSet.has(l)) changed = true;
      allFunctions.push({ ...fn, file: f.file, lang: f.lang, changed, isNew: !old.has(fn.qualified), code: lines.slice(fn.start - 1, fn.end).join('\n') });
    }
    for (const c of structure.classes) classNames.push(c.name);
    return { ...f, structure };
  });

  // Code units (kept for exams, boss fights and audits)
  const units = [];
  for (const fn of allFunctions.filter((f) => f.changed)) {
    if (fn.code.split('\n').length > cfg.maxExcerptLines || hasSecret(fn.code)) continue;
    const tracks = [lang.trackFor(fn.lang)];
    if (/\bstd::(mutex|atomic|thread|lock_guard|unique_lock|scoped_lock)|threading\.|asyncio\.|\bawait\b/.test(fn.code)) tracks.push('concurrency');
    if (/\b(socket|recv|send|epoll_\w+|accept|connect)\s*\(/.test(fn.code)) tracks.push('networking');
    if (/\b(heapq|priority_queue|sort|sorted|bisect|lower_bound|upper_bound|binary_search|unordered_map|deque|memo)\b|\bnew Map\b|\bstd::map\b/.test(fn.code)) tracks.push('dsa');
    const r = db.run(
      'INSERT INTO code_units(repo_id, session_id, file, language, name, start_line, end_line, code, tracks, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      repoId, sessionId, fn.file, fn.lang, fn.name, fn.start, fn.end, fn.code, JSON.stringify(tracks), nowIso(),
    );
    units.push({ id: Number(r.lastInsertRowid), repo_id: repoId, file: fn.file, language: fn.lang, name: fn.name, start_line: fn.start, end_line: fn.end, code: fn.code, tracks: JSON.stringify(tracks), fn });
  }
  const ctx = { root, cfg, repoFiles: files.length ? git.listFiles(root) : [], classNames, track: files[0] ? lang.trackFor(files[0].lang) : 'general' };
  const budget = { testRuns: cfg.testCommand ? 4 : 0, deadline }; // 1 baseline + up to 3 mutant runs

  // ---- Design & reasoning (first in queue: doubles as review)
  if (want.design > 0) {
    let pool = [];
    for (const fi of fileInfos) pool.push(...design.dataStructureQs(ctx, fi, rnd));
    pool.push(...design.architectureQs(ctx, fileInfos, allFunctions, rnd));
    if (cfg.whyQuestions && opts.transcriptPath) {
      const symbols = allFunctions.filter((f) => f.changed).map((f) => f.name);
      const rat = rationale.extract(opts.transcriptPath, { files: files.map((f) => f.file), symbols, lastAssistantMessage: opts.lastAssistantMessage });
      if (rat && rat.sentences.length) {
        for (const s of rat.sentences.slice(0, 5)) {
          db.run('INSERT INTO rationale(repo_id, session_id, turn, message_ref, sentence, files, created_at) VALUES (?,?,?,?,?,?,?)',
            repoId, sessionId, rat.turn, s.ref, s.sentence, JSON.stringify(s.files), nowIso());
        }
        const avail = model.available(db, cfg);
        if (avail.ok && Date.now() < deadline) {
          const s = rat.sentences[0];
          const fn = allFunctions.find((f) => f.changed && (s.symbols.includes(f.name) || s.files.includes(f.file)));
          const q = await model.whyQuestion(db, cfg, { sentence: s.sentence, excerpt: fn && fn.code, file: fn && fn.file });
          if (q) {
            pool.unshift({
              family: 'design', type: 'why', format: 'choice', topic: 'reasoning/why', track: ctx.track, difficulty: 'medium',
              grading: 'session', xp: 10, est_seconds: 45, title: 'Design · Why Claude did it', prompt: q.question,
              choices: q.choices, answer: q.answer, explanation: `${q.explanation}\nClaude said (turn ${rat.turn}): "${s.sentence}"`,
              evidence: `transcript turn ${rat.turn}, message ${s.ref || 'n/a'}`, code_file: fn && fn.file,
              meta: { turn: rat.turn, ref: s.ref, sentence: s.sentence, generatedBy: 'model' },
            });
          } else pool.push(...design.whyQs(ctx, rat, rnd));
        } else pool.push(...design.whyQs(ctx, rat, rnd));
      }
    }
    // Algorithm / complexity via model path (half XP, model-checked)
    const avail = model.available(db, cfg);
    if (avail.ok && Date.now() < deadline) {
      const fn = shuffle(allFunctions.filter((f) => f.changed && f.end - f.start >= 5 && f.end - f.start <= cfg.maxExcerptLines && !hasSecret(f.code)), rnd)[0];
      if (fn) {
        const kind = rnd() < 0.5 ? 'algorithm' : 'complexity';
        const q = await model.algoQuestion(db, cfg, { kind, name: fn.qualified, code: fn.code, file: fn.file });
        if (q) {
          pool.push({
            family: 'design', type: kind, format: 'choice', topic: `dsa/${kind}`, track: 'dsa', difficulty: 'medium',
            grading: 'model', xp: 5, est_seconds: 60, title: `Design · ${kind === 'algorithm' ? 'Algorithm used' : 'Complexity'}`,
            prompt: q.question, choices: q.choices, answer: q.answer, explanation: q.explanation,
            code: fn.code, code_lang: fn.lang, code_file: fn.file, code_start: fn.start, code_end: fn.end,
            evidence: 'model label, confirmed by a blind second call', meta: { generatedBy: 'model' },
          });
        }
      }
    }
    // Prefer variety: one of each type before repeats; critique at most one.
    const byType = new Map();
    for (const q of pool) {
      if (!byType.has(q.type)) byType.set(q.type, []);
      byType.get(q.type).push(q);
    }
    const order = ['data_structure', 'algorithm', 'complexity', 'architecture', 'why_fits', 'why'];
    while (created.design.length < want.design && [...byType.values()].some((l) => l.length)) {
      for (const t of order) {
        const l = byType.get(t);
        if (l && l.length && created.design.length < want.design) created.design.push(l.shift());
      }
    }
    const changedFn = allFunctions.find((f) => f.changed && f.end - f.start >= 4);
    if (changedFn && cfg.critique && created.design.length < want.design + 1) created.design.push(design.critiqueQ(ctx, changedFn));
  }

  // ---- Code challenges: technical questions about what Claude used come first
  if (want.code > 0 && files.length) {
    created.code.push(...conceptQs(fileInfos, { max: Math.max(1, want.code - (units.length ? 1 : 0)), rnd }));
  }
  if (want.code > 0 && units.length) {
    const tryOrder = shuffle(units, rnd);
    // Predict the output (at most one per batch)
    for (const u of tryOrder) {
      if (created.code.length >= want.code || Date.now() > deadline) break;
      const fi = fileInfos.find((f) => f.file === u.file);
      const p = buildPredict(u.fn, u.language, fi.structure, fi.src, { timeoutSec: cfg.snippetTimeoutSec });
      if (!p) continue;
      created.code.push({
        family: 'code', type: 'predict', format: 'output', topic: `${lang.trackFor(u.language)}/predict`, track: lang.trackFor(u.language),
        difficulty: p.difficulty, grading: 'verified', xp: p.difficulty === 'hard' ? 20 : 10, est_seconds: 120,
        title: 'Code challenge · Predict the output',
        prompt: `Using Claude's \`${u.name}\` from ${u.file}:${u.start_line}-${u.end_line}: what does \`${p.call}\` return? ` +
          (p.lang === 'python' ? "Answer in Python repr form, e.g. [1, 2] or 'abc'."
            : p.lang === 'typescript' ? 'Answer in JSON form, e.g. [1,2] or "abc".'
              : 'Answer as printed: strings in double quotes, vectors as [1, 2], bools as true/false.'),
        code: p.shown, code_lang: p.lang, code_file: u.file, code_start: u.start_line, code_end: u.end_line,
        answer: { output: p.output }, explanation: `Recorded by compiling and running it: ${p.output}`,
        evidence: `${p.call} -> ${p.output}`, meta: { call: p.call, unitId: u.id },
      });
      break;
    }
    // Killing test (Yellow+)
    if (created.code.length < want.code && cfg.testCommand) {
      for (const u of tryOrder) {
        const track = lang.trackFor(u.language);
        if (!rewards.unlocked(db, track, 'killtest') || Date.now() > deadline) break;
        const q = codeGen.killTest(ctx, u, { categories: rewards.categoriesFor(db, track), rnd, budget });
        if (q) {
          created.code.push(q);
          break;
        }
      }
    }
    // Warning explanation (at most one)
    for (const fi of fileInfos) {
      if (created.code.length >= want.code || Date.now() > deadline) break;
      const ws = codeGen.warnings(ctx, fi.file, fi.lang, fi.added, fi.src, { rnd, max: 1 });
      if (ws.length) {
        created.code.push(ws[0]);
        break;
      }
    }
    // At most one "spot the bug" per batch (quiz only; the battle sticks to technical questions)
    for (const u of tryOrder) {
      if (created.code.length >= want.code || created.code.some((c) => c.type === 'seeded_bug') || Date.now() > deadline) break;
      const track = lang.trackFor(u.language);
      const q = codeGen.seededBug(ctx, u, {
        categories: rewards.categoriesFor(db, track),
        maxDifficulty: rewards.unlocked(db, track, 'hard') ? 'hard' : 'medium',
        rnd,
        budget,
      });
      if (q && !created.code.some((c) => c.meta && c.meta.unitId === u.id && c.type === 'seeded_bug')) created.code.push(q);
    }
  }

  // ---- Questionnaire
  const unfilled = (want.code - created.code.length) + (want.design - Math.min(created.design.length, want.design));
  const qCount = (want.questionnaire || 0) + Math.max(0, unfilled);
  if (qCount > 0 && (cfg.families || []).includes('questionnaire')) {
    const prof = topics.profile(db, repoId, cfg.pinnedTopics);
    const used = new Set(created.code.concat(created.design).map((q) => q.source && q.source.slice(5)).filter(Boolean));
    created.questionnaire.push(...pickPack(db, { topics: prof, count: qCount, rnd, exclude: used }));
  }

  // ---- Store
  let n = 0;
  db.tx(() => {
    for (const fam of ['design', 'code', 'questionnaire']) {
      for (const q0 of created[fam]) {
        const q = clean(q0, cfg);
        if (!q) continue;
        store.insertQuestion(db, { ...q, repo_id: q.family === 'questionnaire' && !files.length ? repoId : repoId, session_id: sessionId, batch });
        n++;
      }
    }
  });
  return { questions: n, files: files.length, units: units.length, topics: [...scores.keys()], batch };
}

/** Called from the Stop hook (and `diffdojo generate`). */
async function onStop({ root, repoId, sessionId, transcriptPath, lastAssistantMessage, cfg, manual = false }) {
  return withLock(repoId, async () => {
    const db = store.open();
    store.ensureRepo(db, root, repoId, true); // every project is tracked, no setup needed
    let sess = loadSession(repoId, sessionId);
    if (!sess) {
      // Session started before the repo was enabled (or SessionStart was missed):
      // use the snapshot taken by `diffdojo enable`, else HEAD.
      const eb = readJson(path.join(repoDir(repoId), 'enable-base.json'), null);
      const base = (eb && eb.tree) || (git.head(root) ? `${git.head(root)}^{tree}` : git.emptyTree(root));
      sess = { id: sessionId, started_at: nowIso(), base_head: git.head(root), base_tree: base, last_tree: base, last_stop_at: eb ? eb.at : null, generated: 0 };
      saveSession(repoId, sessionId, sess);
    }
    const toTree = git.snapshot(root);
    if (!toTree) return { skipped: 'snapshot failed' };
    const events = readEvents(repoId, sess.last_stop_at);
    const sessionEvents = events.filter((e) => !e.session || e.session === sessionId);
    const onlyFiles = manual ? null : [...new Set(sessionEvents.map((e) => e.path))];
    db.run(
      `INSERT INTO sessions(id, repo_id, started_at, base_head, base_tree, last_tree, last_stop_at, turns, generated)
       VALUES (?,?,?,?,?,?,?,0,0) ON CONFLICT(id) DO NOTHING`,
      sessionId, repoId, sess.started_at, sess.base_head, sess.base_tree, sess.last_tree, sess.last_stop_at,
    );
    const left = cfg.sessionCap - (sess.generated || 0);
    let result = { questions: 0, files: 0, topics: [] };
    if (cfg.quiet && !manual) result.skipped = 'quiet mode';
    else if (left <= 0) result.skipped = 'session question cap reached';
    else if (!manual && onlyFiles.length === 0) {
      // No edits this turn: top up the questionnaire only when the queue is nearly empty.
      const queued = db.get("SELECT COUNT(*) AS n FROM questions WHERE status = 'queued' AND repo_id = ?", repoId).n;
      if (queued < 3) result = await generate({ db, root, repoId, sessionId, cfg, fromTree: sess.last_tree, toTree, onlyFiles: [], cap: Math.min(3, left) });
    } else {
      result = await generate({ db, root, repoId, sessionId, cfg, fromTree: sess.last_tree, toTree, onlyFiles, transcriptPath, lastAssistantMessage, cap: left });
    }
    sess.last_tree = toTree;
    sess.last_stop_at = nowIso();
    sess.generated = (sess.generated || 0) + (result.questions || 0);
    sess.turns = (sess.turns || 0) + 1;
    saveSession(repoId, sessionId, sess);
    db.run('UPDATE sessions SET last_tree = ?, last_stop_at = ?, turns = turns + 1, generated = generated + ? WHERE id = ?', toTree, sess.last_stop_at, result.questions || 0, sessionId);
    return result;
  });
}

module.exports = { generate, onStop, startSession, loadSession, saveSession, readEvents, eventsFile, collect, withLock, mixCounts };
