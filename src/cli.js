'use strict';
// Command-line entry point: `diffdojo <command> [options]`.

const fs = require('fs');
const path = require('path');
const util = require('./util');
const config = require('./config');

const HELP = `DiffDojo — practice on the code Claude just wrote. Local only.

Usage: diffdojo <command> [options]

Setup
  enable [--test-cmd "<cmd>"]     Enable DiffDojo for the current git repository (/diffdojo:start)
  disable                         Disable it for this repository (/diffdojo:stop)
  status                          Show whether this repo is enabled, queue size, last run
  doctor                          Check toolchains, hook speed and configuration
  config [get [key] | set <key> <value>] [--global]
                                  Show or change settings (testCommand, model.enabled, quiet, mix.code, ...)

Practice
  quiz [--topic T] [--family code|design|questionnaire] [--once] [--count N]
                                  Answer queued questions (s skip · z snooze · b bad question · q quit)
  review                          Revisit questions you missed (half XP)
  exam [track]                    Take (or resume) the next belt exam in a track
  boss [track]                    Boss fight: find 2-3 hidden mutations (Blue belt+)
  audit [track]                   Audit mode: is there a seeded bug at all? (Brown belt+)
  serve [--port N]                Local web UI on 127.0.0.1 with a one-time token
  generate [--since <ref>]        Generate questions now from the diff against <ref> (default HEAD)
  topics [list | pin <topic> | unpin <topic>]

Progress
  stats [--json]                  Belts, XP, accuracy, streak, trophies, bugs caught (/diffdojo:stats)
  badge [--out <dir>] [--style flat|square]
                                  Write an SVG + Markdown badge (self-reported)
  report-bug --title "<t>" --test <path> [--file <f> --lines a-b] [--cmd "<cmd>"] [--critique <qid>]
  report-bug --scaffold --file <f> [--function <name>] [--title "<t>"]
                                  Prove a real bug in Claude's code with a failing test (/diffdojo:report-bug)
  trophy claim pack-author --link <url>
  packs [list | validate]         Questionnaire packs shipped and in ~/.diffdojo/packs

Data
  export [--repo] [--out <file>]  Write all data (or this repo's) to one JSON file
  purge [--repo] --yes            Delete all data (or this repo's)
`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function color(flags) {
  return !flags['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY;
}

function repoContext({ require: must = false } = {}) {
  const root = util.findRepoRoot(process.cwd());
  if (!root) {
    if (must) throw new Error('Not inside a git repository. DiffDojo works per repository (non-git directories are not supported).');
    return { root: null, repoId: null };
  }
  return { root, repoId: util.repoId(root) };
}

function db() {
  return require('./store').open();
}

function registerRepo(d, root, repoId, enabled) {
  d.run(
    `INSERT INTO repos(id, path, enabled, created_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, path = excluded.path, updated_at = excluded.updated_at`,
    repoId, root, enabled ? 1 : 0, util.nowIso(), util.nowIso(),
  );
}

const commands = {
  help() {
    console.log(HELP);
  },

  enable({ flags }) {
    const { root, repoId } = repoContext({ require: true });
    const git = require('./git');
    const dir = util.ensureDir(util.repoDir(repoId));
    fs.writeFileSync(path.join(dir, 'enabled'), util.nowIso());
    // Base snapshot for the session that is already running (SessionStart already fired).
    const tree = git.baseTree(root);
    util.writeJson(path.join(dir, 'enable-base.json'), { tree, head: git.head(root), at: util.nowIso() });
    if (flags['test-cmd']) config.setValue('testCommand', flags['test-cmd'], repoId);
    const d = db();
    registerRepo(d, root, repoId, true);
    const cfg = config.load(repoId);
    console.log(`DiffDojo enabled for ${root}`);
    console.log(`  data: ${dir} (nothing is written into the repository)`);
    console.log(`  test command: ${cfg.testCommand || '(none — set one to unlock killing-test questions and bug reports: diffdojo config testCommand "<cmd>")'}`);
    console.log(`  model path: ${cfg.model.enabled ? 'ON (' + cfg.model.provider + ')' : 'off (offline questions only)'}`);
    console.log('Questions are generated in the background after each Claude turn. Answer them in a second terminal: diffdojo quiz');
  },

  disable() {
    const { root, repoId } = repoContext({ require: true });
    try {
      fs.unlinkSync(path.join(util.repoDir(repoId), 'enabled'));
    } catch {
      /* already off */
    }
    registerRepo(db(), root, repoId, false);
    console.log(`DiffDojo disabled for ${root}. Your progress is kept (diffdojo purge --repo to delete it).`);
  },

  status() {
    const { root, repoId } = repoContext();
    if (!root) return console.log('Not in a git repository.');
    const d = db();
    const enabled = util.isEnabled(repoId);
    const queue = require('./queue');
    const last = util.readJson(path.join(util.repoDir(repoId), 'last-stop.json'), null);
    const cfg = config.load(repoId);
    console.log(`${root}: ${enabled ? 'enabled' : 'not enabled (run /diffdojo:start or diffdojo enable)'}`);
    console.log(`queued questions: ${queue.queuedCount(d, repoId)}`);
    if (last) console.log(`last Claude turn processed ${last.at}: ${last.questions || 0} questions from ${last.files || 0} files${last.skipped ? ` (${last.skipped})` : ''}`);
    console.log(`test command: ${cfg.testCommand || '(none)'} · model path: ${cfg.model.enabled ? 'on' : 'off'} · quiet: ${cfg.quiet}`);
  },

  async quiz({ flags }) {
    const { root, repoId } = repoContext();
    const d = db();
    const opts = { db: d, root, repoId, color: color(flags), family: flags.family, once: !!flags.once, count: flags.count ? +flags.count : 0 };
    if (flags.topic) {
      require('./queue').topicQuiz(d, { topic: flags.topic, count: flags.count ? +flags.count : 5, difficulty: flags.difficulty });
      opts.topic = flags.topic;
      opts.family = 'questionnaire';
    }
    await require('./quiz').run(opts);
  },

  async review({ flags }) {
    const { root, repoId } = repoContext();
    const d = db();
    const ids = require('./queue').reviewIds(d, { repoId, limit: flags.count ? +flags.count : 10 });
    await require('./quiz').run({ db: d, root, repoId, color: color(flags), review: true, ids });
  },

  async exam({ pos, flags }) {
    const { root, repoId } = repoContext();
    const d = db();
    const queue = require('./queue');
    const track = pos[1] || queue.defaultTrack(d, repoId);
    const r = queue.startExam(d, track);
    if (r.error) return console.log(r.error);
    console.log(`${r.resumed ? 'Resuming' : 'Starting'} the ${r.target} belt exam in ${track}: ${r.count} question${r.count === 1 ? '' : 's'}. Skipping counts as wrong.`);
    await require('./quiz').run({ db: d, root, repoId, color: color(flags), examId: r.examId });
  },

  async boss({ pos, flags }) {
    const { root, repoId } = repoContext();
    const d = db();
    const queue = require('./queue');
    const r = queue.boss(d, pos[1] || queue.defaultTrack(d, repoId));
    if (r.error) return console.log(r.error);
    await require('./quiz').run({ db: d, root, repoId, color: color(flags), ids: [r.id] });
  },

  async audit({ pos, flags }) {
    const { root, repoId } = repoContext();
    const d = db();
    const queue = require('./queue');
    const r = queue.auditQ(d, pos[1] || queue.defaultTrack(d, repoId));
    if (r.error) return console.log(r.error);
    await require('./quiz').run({ db: d, root, repoId, color: color(flags), ids: [r.id] });
  },

  async serve({ flags }) {
    const { root, repoId } = repoContext();
    const s = await require('./server').start({ db: db(), root, repoId, port: flags.port ? +flags.port : 0 });
    console.log(`DiffDojo web UI (local only): ${s.url}`);
    console.log('Press Ctrl+C to stop.');
  },

  async generate({ flags }) {
    const { root, repoId } = repoContext({ require: true });
    const d = db();
    registerRepo(d, root, repoId, util.isEnabled(repoId));
    const git = require('./git');
    const { generate } = require('./pipeline');
    const since = flags.since || (git.head(root) ? 'HEAD' : null);
    const fromTree = since ? `${since}^{tree}` : git.emptyTree(root);
    const toTree = git.snapshot(root);
    const cfg = config.load(repoId);
    const r = await generate({ db: d, root, repoId, sessionId: 'manual', cfg, fromTree, toTree, onlyFiles: null, cap: flags.count ? +flags.count : cfg.questionsPerTurn });
    console.log(`Generated ${r.questions} question${r.questions === 1 ? '' : 's'} from ${r.files} changed file${r.files === 1 ? '' : 's'}` +
      (r.topics.length ? ` · topics: ${r.topics.slice(0, 6).join(', ')}` : '') + '. Run: diffdojo quiz');
  },

  topics({ pos }) {
    const { repoId } = repoContext();
    const sub = pos[1] || 'list';
    const cfg = config.load(repoId);
    if (sub === 'pin' || sub === 'unpin') {
      const t = pos[2];
      if (!t) return console.log(`Usage: diffdojo topics ${sub} <topic>`);
      const set = new Set(cfg.pinnedTopics);
      if (sub === 'pin') set.add(t);
      else set.delete(t);
      config.setValue('pinnedTopics', [...set], repoId || undefined);
      return console.log(`Pinned topics: ${[...set].join(', ') || '(none)'}`);
    }
    const prof = require('./topics').profile(db(), repoId, cfg.pinnedTopics);
    if (!prof.length) console.log('No topics detected yet.');
    for (const p of prof.slice(0, 20)) console.log(`${p.pinned ? '📌' : '  '} ${p.topic.padEnd(32)} ${p.score.toFixed(1)}`);
    const packs = require('./packs').load();
    const areas = [...new Set(packs.questions.map((q) => q.topic.split('/').slice(0, 2).join('/')))].sort();
    console.log(`\nAvailable quiz topics: ${areas.join(', ')}`);
  },

  config({ pos, flags }) {
    const { repoId } = repoContext();
    const sub = pos[1] || 'get';
    if (sub === 'set' || (pos[1] && pos[2] !== undefined && sub !== 'get')) {
      const key = sub === 'set' ? pos[2] : pos[1];
      const raw = sub === 'set' ? pos.slice(3).join(' ') : pos.slice(2).join(' ');
      if (!key) return console.log('Usage: diffdojo config set <key> <value>');
      const target = flags.global || !repoId ? undefined : repoId;
      config.setValue(key, config.parseValue(raw), target);
      if (key === 'model.enabled' && config.parseValue(raw) === true) {
        console.log('Model path ON. Excerpts (a few dozen lines of code and Claude\'s extracted reasoning) will be sent to the model with your own Claude plan or API key,');
        console.log('under that account\'s normal terms (including its model-training preference). Keep it off for confidential code.');
      }
      return console.log(`${key} = ${JSON.stringify(config.parseValue(raw))} (${target ? 'this repo' : 'global'})`);
    }
    const cfg = config.load(repoId);
    const key = sub === 'get' ? pos[2] : sub;
    if (key) {
      const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg);
      return console.log(JSON.stringify(v, null, 2));
    }
    console.log(JSON.stringify(cfg, null, 2));
  },

  stats({ flags }) {
    const { repoId } = repoContext();
    const st = require('./stats');
    const s = st.compute(db(), { repoId: flags.all ? null : repoId });
    if (flags.json) return console.log(JSON.stringify(s, null, 2));
    console.log(st.format(s, { color: color(flags) }));
  },

  badge({ flags }) {
    const out = path.resolve(flags.out || '.');
    const r = require('./badge').write(db(), out, { style: flags.style });
    console.log(`Wrote ${r.svgPath}`);
    console.log(`Markdown: ${r.markdown}`);
    console.log('The badge is generated locally and marked "self-reported"; commit it wherever you like.');
  },

  'report-bug'({ flags }) {
    const { root, repoId } = repoContext({ require: true });
    const bugs = require('./bugs');
    if (flags.scaffold) {
      const s = bugs.scaffold(root, { file: flags.file, fn: flags.function, title: flags.title });
      console.log(`Framework: ${s.framework}${s.command ? ` (suggested test command: ${s.command})` : ''}`);
      console.log(`Suggested file: ${s.path}\n`);
      console.log(s.code);
      return;
    }
    if (!flags.title || !flags.test) return console.log('Usage: diffdojo report-bug --title "<what is wrong>" --test <test file> [--file <src> --lines a-b] [--cmd "<test cmd>"]');
    const d = db();
    registerRepo(d, root, repoId, util.isEnabled(repoId));
    const r = bugs.report(d, { root, repoId, cfg: config.load(repoId), title: flags.title, file: flags.file, lines: flags.lines, testPath: flags.test, critiqueId: flags.critique ? +flags.critique : null, testCommand: flags.cmd });
    if (!r.confirmed) {
      console.log(`Not confirmed: ${r.reason}`);
      if (r.output) console.log(r.output.slice(-1500));
      process.exitCode = 1;
      return;
    }
    console.log(`Bug confirmed: the test fails on the current code. +${r.xp} XP`);
    console.log(`Report saved: ${r.reportPath}`);
    if (!r.fromClaude) console.log('(Note: this file/line range was not found in a recorded Claude change.)');
    for (const t of r.trophies) console.log(`🏆 Trophy unlocked: ${t.name}`);
  },

  trophy({ pos, flags }) {
    if (pos[1] !== 'claim' || pos[2] !== 'pack-author' || !flags.link) return console.log('Usage: diffdojo trophy claim pack-author --link <merged PR url>');
    const t = require('./rewards').grant(db(), 'pack-author', 'self-reported', flags.link);
    console.log(t ? `🏆 ${t.name}` : 'Already claimed.');
  },

  packs({ pos }) {
    const packs = require('./packs');
    const p = packs.load({ fresh: true });
    if ((pos[1] || 'list') === 'validate') {
      for (const e of p.errors) console.log(`✗ ${e.file}${e.id ? ` [${e.id}]` : ''}: ${e.error}`);
      const d = packs.duplicates(p.questions);
      for (const [a, b] of d) console.log(`✗ duplicate question text: ${a} / ${b}`);
      console.log(`${p.questions.length} valid questions, ${p.errors.length + d.length} problems.`);
      if (p.errors.length || d.length) process.exitCode = 1;
      return;
    }
    const by = new Map();
    for (const q of p.questions) by.set(`${q.pack} (${q.origin})`, (by.get(`${q.pack} (${q.origin})`) || 0) + 1);
    for (const [k, n] of by) console.log(`${k.padEnd(36)} ${n} questions`);
    if (p.errors.length) console.log(`${p.errors.length} invalid entries skipped (diffdojo packs validate)`);
  },

  export({ flags }) {
    const { repoId } = repoContext();
    const data = require('./data').exportAll(db(), { repoId: flags.repo ? repoId : null });
    const out = path.resolve(flags.out || `diffdojo-export-${util.dayKey()}.json`);
    fs.writeFileSync(out, JSON.stringify(data, null, 2));
    console.log(`Exported to ${out}`);
  },

  purge({ flags }) {
    const { repoId } = repoContext();
    if (flags.repo && !repoId) return console.log('Not in a git repository.');
    if (!flags.yes) return console.log(`This deletes ${flags.repo ? 'all DiffDojo data for this repository' : 'ALL DiffDojo data (progress, belts, trophies, questions)'}. Re-run with --yes to confirm.`);
    const r = require('./data').purge(db(), { repoId: flags.repo ? repoId : null });
    console.log(`Deleted ${r.removed}`);
  },

  /**
   * Machine interface for the in-app UI (hooks/ui.tsx): one JSON object on stdout.
   *   api status | next | fill | answer <id> <response...> | skip <id> | snooze <id> | bad <id>
   */
  async api({ pos }) {
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    const { root, repoId } = repoContext();
    const enabled = !!(repoId && util.isEnabled(repoId));
    const sub = pos[1] || 'status';
    if (!root) return out({ enabled: false, queued: 0, question: null });
    const d = db();
    const queue = require('./queue');
    const server = require('./server');
    const stats = require('./stats');
    const status = () => {
      const last = util.readJson(path.join(util.repoDir(repoId), 'last-stop.json'), null);
      return { enabled, queued: queue.queuedCount(d, repoId), lastStop: last && last.at, header: stats.header(d, { repoId }) };
    };
    if (sub === 'status') return out(status());
    if (sub === 'next') return out({ ...status(), question: enabled ? server.publicQuestion(queue.next(d, { repoId })) : null });
    if (sub === 'fill') {
      // Keep something to answer while Claude works: concept questions on the detected/pinned topics.
      let added = 0;
      if (enabled && queue.queuedCount(d, repoId) === 0) {
        const cfg = config.load(repoId);
        const prof = require('./topics').profile(d, repoId, cfg.pinnedTopics);
        const qs = require('./generators/questionnaire').pickPack(d, { topics: prof, count: 3 });
        const batch = `${util.nowIso()}#fill`;
        for (const q of qs) require('./store').insertQuestion(d, { ...q, repo_id: repoId, batch });
        added = qs.length;
      }
      return out({ ...status(), added });
    }
    const q = pos[2] ? queue.get(d, Number(pos[2])) : null;
    if (!q) return out({ error: 'no such question' });
    const cfg = config.load(q.repo_id || repoId);
    if (sub === 'answer') {
      if (q.status === 'answered') return out({ error: 'already answered' });
      const grader = require('./grader');
      const r = await grader.answer(d, q, pos.slice(3).join(' '), { mode: q.exam_id ? 'exam' : 'normal', root: queue.repoPath(d, q.repo_id) || root, cfg });
      return out({ correct: r.correct, xp: r.xp, answerText: server.answerText(q, r), explanation: r.explanation, evidence: r.evidence, detail: r.detail, feedback: r.feedback, trophies: r.trophies, ...status() });
    }
    const grader = require('./grader');
    if (sub === 'skip') grader.skip(d, q);
    else if (sub === 'snooze') grader.snooze(d, q, cfg.snoozeMinutes);
    else if (sub === 'bad') grader.bad(d, q);
    else return out({ error: `unknown api command ${sub}` });
    return out({ ok: true, ...status() });
  },

  doctor() {
    const lines = [];
    const ok = (b, msg) => lines.push(`${b ? '✓' : '✗'} ${msg}`);
    const major = +process.versions.node.split('.')[0];
    ok(major >= 22, `Node ${process.versions.node} (22.5+ needed for node:sqlite)`);
    try {
      db();
      ok(true, `SQLite store at ${require('./store').dbPath()}`);
    } catch (e) {
      ok(false, `SQLite: ${e.message}`);
    }
    ok(!!util.which('git'), 'git');
    const r = require('./runner');
    ok(!!r.pythonBin(), `python (predict-output / pack snippets): ${r.pythonBin() || 'not found'}`);
    ok(!!r.cxxBin('cpp'), `C++ compiler: ${r.cxxBin('cpp') || 'not found'}`);
    ok(!!util.which('claude'), 'claude CLI (only needed for the optional model path)');
    const { repoId, root } = repoContext();
    if (root) {
      const cfg = config.load(repoId);
      ok(util.isEnabled(repoId), `repo ${root} enabled`);
      ok(!!cfg.testCommand, `test command: ${cfg.testCommand || 'not set (killing tests, bug reports and test-validated mutants need it)'}`);
      lines.push(`  model path: ${cfg.model.enabled ? require('./model').available(db(), cfg).reason || 'ready' : 'off'}`);
    }
    // Hook overhead
    const { spawnSync } = require('child_process');
    const t0 = Date.now();
    spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'on-edit.js')], { input: JSON.stringify({ cwd: process.cwd(), tool_name: 'Edit', tool_input: { file_path: 'x' } }), env: { ...process.env, DIFFDOJO_DOCTOR: '1' } });
    const ms = Date.now() - t0;
    ok(ms < 300, `edit hook round trip ${ms} ms (target < 100 ms of work; includes Node startup)`);
    const packs = require('./packs').load();
    ok(packs.errors.length === 0, `${packs.questions.length} pack questions loaded${packs.errors.length ? `, ${packs.errors.length} invalid` : ''}`);
    console.log(lines.join('\n'));
  },
};

async function main(argv = process.argv.slice(2)) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0] || 'help';
  if (flags.help || cmd === '--help' || cmd === '-h') return commands.help();
  const fn = commands[cmd];
  if (!fn) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exitCode = 2;
    return;
  }
  try {
    await fn({ pos, flags });
  } catch (e) {
    console.error(`diffdojo: ${e.message}`);
    util.log(`cli ${cmd}`, e);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, commands };
