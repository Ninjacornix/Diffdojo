'use strict';
// Command-line entry point: `diffdojo <command> [options]`.

const fs = require('fs');
const path = require('path');
const util = require('./util');
const config = require('./config');

const HELP = `DiffDojo — practice on the code Claude just wrote. Local only.

Usage: diffdojo <command> [options]

Setup
  enable [--test-cmd "<cmd>"]     Turn DiffDojo on for this repository (/diffdojo:start); on by default everywhere
  disable                         Turn it off for this repository only (/diffdojo:stop)
  status                          Show whether this repo is enabled, queue size, last run
  doctor                          Check toolchains, hook speed and configuration
  config [get [key] | set <key> <value>] [--global]
                                  Show or change settings (testCommand, model.enabled, quiet, mix.code, ...)

Practice
  quiz [--topic T] [--family code|design|questionnaire] [--once] [--count N]
                                  Answer queued questions (s skip · z snooze · b bad question · q quit)
  battle [--snapshot]             Play DiffDojo Battle right here in the terminal (no Claude Code needed)
  demo [--dir <folder>]           Make a sandbox project with a simulated Claude change, to try everything
  review                          Revisit questions you missed (half XP)
  exam [track]                    Take (or resume) the next belt exam in a track
  boss [track]                    Boss fight: find 2-3 hidden mutations (Blue belt+)
  audit [track]                   Audit mode: is there a seeded bug at all? (Brown belt+)
  serve [--port N]                Local web UI on 127.0.0.1 with a one-time token
  generate [--since <ref>]        Generate questions now from the diff against <ref> (default HEAD)
  topics [list | pin <topic> | unpin <topic>]

Progress
  stats [--repo] [--json]         Belts, XP, accuracy, streak, trophies, bugs caught, across all projects (/diffdojo:stats)
  badge [--out <dir>] [--style flat|square]
                                  Write an SVG + Markdown badge (self-reported)
  share [--yes] [--projects] [--secret] | share --remove
                                  Put your score card in a GitHub Gist on your account (uses the gh CLI);
                                  numbers only, no code or project names unless --projects
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
    if (must) throw new Error('Not inside a project folder. DiffDojo works in any folder except your home folder and a drive root.');
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
    fs.rmSync(path.join(dir, 'disabled'), { force: true });
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
    console.log('Questions appear above your prompt while Claude works (/dojo opens the full pane). Terminal alternative: diffdojo quiz');
  },

  disable() {
    const { root, repoId } = repoContext({ require: true });
    const dir = util.ensureDir(util.repoDir(repoId));
    fs.rmSync(path.join(dir, 'enabled'), { force: true });
    fs.writeFileSync(path.join(dir, 'disabled'), util.nowIso());
    registerRepo(db(), root, repoId, false);
    console.log(`DiffDojo is off for ${root} (it stays on everywhere else). Your progress is kept; /diffdojo:start turns it back on.`);
  },

  status() {
    const { root, repoId } = repoContext();
    if (!root) return console.log('Not in a project folder (DiffDojo skips your home folder and drive roots).');
    const d = db();
    const enabled = util.isEnabled(repoId);
    const queue = require('./queue');
    const last = util.readJson(path.join(util.repoDir(repoId), 'last-stop.json'), null);
    const cfg = config.load(repoId);
    const why = fs.existsSync(path.join(util.repoDir(repoId), 'disabled')) ? 'turned off here with /diffdojo:stop' : fs.existsSync(path.join(util.repoDir(repoId), 'enabled')) ? 'turned on with /diffdojo:start' : util.autoEnable() ? 'on automatically (autoEnable)' : 'autoEnable is off; run /diffdojo:start';
    console.log(`${root}: ${enabled ? 'enabled' : 'disabled'} (${why})`);
    console.log(`queued questions: ${queue.queuedCount(d, repoId)}`);
    if (last) console.log(`last Claude turn processed ${last.at}: ${last.questions || 0} questions from ${last.files || 0} files${last.skipped ? ` (${last.skipped})` : ''}`);
    console.log(`test command: ${cfg.testCommand || '(none)'} · model path: ${cfg.model.enabled ? 'on' : 'off'} · quiet: ${cfg.quiet}`);
  },

  async demo({ flags }) {
    const r = await require('./demo').create({ dir: flags.dir });
    const root = require('path').resolve(__dirname, '..');
    console.log(`Demo project ready: ${r.dir}`);
    console.log(`A simulated Claude change to ${r.files} files produced ${r.questions} questions about it.`);
    console.log('');
    console.log('Try it without prompting Claude:');
    console.log(`  1. In this terminal:   cd "${r.dir}" && node "${root}/bin/diffdojo" battle`);
    console.log(`  2. Inside Claude Code: cd "${r.dir}" && claude --plugin-dir "${root}"`);
    console.log('                        then type /battle (or /dojo for the plain question view)');
    console.log(`  3. Plain quiz:         cd "${r.dir}" && node "${root}/bin/diffdojo" quiz`);
    console.log('');
    console.log('Professional mode asks about this code first; the other modes mix it with concept questions.');
  },

  async battle({ flags }) {
    const term = require('./battle-term');
    if (flags.snapshot) return console.log(await term.snapshot({ mode: flags.mode || 'easy', width: flags.width ? +flags.width : 72, color: !!flags.color }));
    await term.play({ width: flags.width ? +flags.width : undefined });
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
    for (const p of prof.slice(0, 20)) console.log(`${p.pinned ? '*' : ' '} ${p.topic.padEnd(32)} ${p.score.toFixed(1)}`);
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
    // Progress is global across every project; --repo narrows it to this one.
    const s = st.compute(db(), { repoId: flags.repo ? repoId : null });
    if (flags.json) return console.log(JSON.stringify(s, null, 2));
    console.log(st.format(s, { color: color(flags) }));
  },

  share({ flags }) {
    const share = require('./share');
    if (flags.remove) {
      const r = share.remove();
      return console.log(r.removed ? `Deleted your shared score (${r.url}).` : r.error);
    }
    const opts = { projects: !!flags.projects, secret: !!flags.secret };
    if (!flags.yes) {
      const p = share.preview(db(), opts);
      console.log('This is what would be published as a GitHub Gist on your account:\n');
      console.log(p.text.split('\n').map((l) => '  ' + l).join('\n'));
      console.log(`\n${opts.secret ? 'A secret gist (only people with the link can see it).' : 'A public gist: anyone can see it.'} Plus diffdojo-score.json (the same numbers) and your badge.`);
      if (p.shared) console.log(`Already shared at ${p.shared.url}: publishing updates it.`);
      return console.log('Re-run with --yes to publish.');
    }
    const r = share.publish(db(), opts);
    if (r.error) {
      process.exitCode = 1;
      return console.log(r.error);
    }
    console.log(`${r.created ? 'Shared' : 'Updated'}: ${r.url}`);
    console.log(`Badge: ${r.badgeUrl}`);
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
    for (const t of r.trophies) console.log(`Trophy unlocked: ${t.name}`);
  },

  trophy({ pos, flags }) {
    if (pos[1] !== 'claim' || pos[2] !== 'pack-author' || !flags.link) return console.log('Usage: diffdojo trophy claim pack-author --link <merged PR url>');
    const t = require('./rewards').grant(db(), 'pack-author', 'self-reported', flags.link);
    console.log(t ? `Trophy: ${t.name}` : 'Already claimed.');
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
    if (flags.repo && !repoId) return console.log('Not in a project folder (DiffDojo skips your home folder and drive roots).');
    if (!flags.yes) return console.log(`This deletes ${flags.repo ? 'all DiffDojo data for this repository' : 'ALL DiffDojo data (progress, belts, trophies, questions)'}. Re-run with --yes to confirm.`);
    const r = require('./data').purge(db(), { repoId: flags.repo ? repoId : null });
    console.log(`Deleted ${r.removed}`);
  },

  /**
   * Machine interface for the in-app UI (hooks/ui.tsx): one JSON object on stdout.
   *   api status | next | fill | answer <id> <response...> | skip <id> | snooze <id> | bad <id>
   *   api gate (tool call JSON on stdin) | gate-answer <id> <label or letter>   (No Mercy)
   *   api battle-state | battle-start <mode> | battle-question | battle-answer <a-d> | battle-quit | battle-resume | battle-turn-end <reason>
   */
  async api({ pos }) {
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    const { root, repoId } = repoContext();
    const enabled = !!(repoId && util.isEnabled(repoId));
    const sub = pos[1] || 'status';
    // Inside DiffDojo's own `claude -p` (writing questions), the plugin's UI must do nothing.
    if (process.env.DIFFDOJO_CHILD === '1') return out({ enabled: false, battleAllowed: false, battle: false, noMercy: false, queued: 0, question: null, skip: 'DiffDojo child session' });
    // Battles also run where there is no project (home folder, drive root), on concept questions, unless
    // DiffDojo was switched off for this repo or globally (autoEnable: false).
    const battleAllowed = root ? enabled : util.autoEnable();
    if (!root && !sub.startsWith('battle') && !sub.startsWith('gate') && !['status', 'achievements', 'scores', 'settings', 'topics', 'prepare', 'share', 'share-preview', 'share-remove'].includes(sub)) return out({ enabled: false, battleAllowed, queued: 0, question: null });
    const d = db();
    const queue = require('./queue');
    const server = require('./server');
    const stats = require('./stats');
    const status = () => {
      if (!root) return { enabled: false, battleAllowed, queued: 0, lastStop: null, header: stats.header(d, {}) };
      const last = util.readJson(path.join(util.repoDir(repoId), 'last-stop.json'), null);
      return { enabled, battleAllowed, queued: queue.queuedCount(d, repoId), lastStop: last && last.at, header: stats.header(d, {}) };
    };
    if (sub === 'status') {
      const cfg = config.load(repoId);
      // Told once: Claude writes questions from code excerpts (model path, on by default).
      const noticeFile = path.join(util.home(), 'model-notice.json');
      const modelNotice = !!(cfg.model && cfg.model.enabled && enabled && !fs.existsSync(noticeFile));
      return out({ ...status(), battle: cfg.battle, noMercy: require('./battle').noMercyActive(), modelNotice, model: cfg.model && cfg.model.enabled ? cfg.model.model : null });
    }
    if (sub === 'achievements') {
      // The battle menu's Achievements tab: trophies (earned or not), belts, battle records.
      const rewards = require('./rewards');
      const st = stats.compute(d, {});
      const earned = new Map(st.trophies.map((t) => [t.id, t.awarded_at]));
      const b = require('./battle').load();
      return out({
        belt: st.overallBelt, xp: st.totalXp, streak: st.streak,
        trophies: Object.entries(rewards.TROPHIES).map(([id, name]) => ({ id, name, earned: earned.has(id), at: earned.get(id) || null })),
        tracks: st.tracks.map((t) => ({ name: t.name, belt: t.belt, xp: t.xp, nextAt: t.nextAt })),
        battle: { wins: b.wins || {}, best: b.best || {} },
      });
    }
    if (sub === 'scores') {
      // The battle menu's Scores screen: totals across every project, then each project.
      const st = stats.compute(d, {});
      const acc = (rid) => {
        const r = d.get(
          `SELECT COUNT(*) AS n, COALESCE(SUM(a.correct), 0) AS ok FROM answers a JOIN questions q ON q.id = a.question_id
           WHERE a.correct IS NOT NULL AND ${rid === null ? 'q.repo_id IS NULL' : 'q.repo_id = ?'}`, ...(rid === null ? [] : [rid]));
        return r.n ? Math.round((100 * r.ok) / r.n) : null;
      };
      const all = d.get('SELECT COUNT(*) AS n, COALESCE(SUM(correct), 0) AS ok FROM answers WHERE correct IS NOT NULL');
      const projects = d.all(
        `SELECT r.id, r.path,
          (SELECT COALESCE(SUM(amount), 0) FROM xp_events x WHERE x.repo_id = r.id) AS xp,
          (SELECT COUNT(*) FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.repo_id = r.id AND a.correct IS NOT NULL) AS answered,
          (SELECT MAX(a.answered_at) FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.repo_id = r.id) AS last
         FROM repos r ORDER BY xp DESC, answered DESC`,
      ).map((p) => ({ name: path.basename(p.path || '') || p.id, path: p.path, xp: p.xp, answered: p.answered, accuracy: acc(p.id), last: p.last, here: p.id === repoId }));
      // Whatever the listed projects don't account for (battles outside a project, removed projects).
      const loose = st.totalXp - projects.reduce((n, p) => n + p.xp, 0);
      if (loose) projects.push({ name: '(battles and quizzes outside a project)', path: null, xp: loose, answered: null, accuracy: acc(null), last: null, here: false });
      const b = require('./battle').load();
      return out({
        belt: st.overallBelt, xp: st.totalXp, xpToday: st.xpToday, streak: st.streak,
        answered: all.n, accuracy: all.n ? Math.round((100 * all.ok) / all.n) : null,
        trophies: st.trophies.length, projects, battle: { wins: b.wins || {}, best: b.best || {} },
      });
    }
    if (sub === 'share-preview') return out(require('./share').preview(d, { projects: pos[2] === 'projects' }));
    if (sub === 'share') return out(require('./share').publish(d, { projects: pos[2] === 'projects' }));
    if (sub === 'share-remove') return out(require('./share').remove());
    if (sub === 'settings') {
      const m = config.load(repoId).model || {};
      return out({ enabled: !!m.enabled, model: m.model || null, effort: m.effort || 'low', perHour: m.perHour || null });
    }
    if (sub === 'topics') {
      // Suggestions for "Prepare questions": this project's topics first, then the packs' tracks.
      const prof = root ? require('./topics').profile(d, repoId, config.load(repoId).pinnedTopics) : [];
      const names = require('./topics').TRACK_NAMES;
      const fromProject = (Array.isArray(prof) ? prof : []).map((t) => (typeof t === 'string' ? t : t.topic)).filter(Boolean).slice(0, 6);
      const extra = ['epoll and non-blocking sockets', 'C++ move semantics', 'Python asyncio', 'JavaScript promises and the event loop', 'Big-O and data structures', 'SQL indexes'];
      const seen = new Set();
      const list = [...fromProject, ...Object.values(names).filter((n) => n !== 'General'), ...extra].filter((t) => t && !seen.has(t) && seen.add(t));
      return out({ topics: list.slice(0, 16) });
    }
    if (sub === 'prepare') {
      // Questions written in advance on a topic: by Claude (model path), else picked from the packs.
      const topic = pos.slice(2).join(' ').trim();
      if (!topic) return out({ error: 'name a topic' });
      const cfg = config.load(repoId);
      const batch = `${util.nowIso()}#prepared`;
      const store = require('./store');
      const slug = util.slug ? util.slug(topic) : topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      let added = 0;
      let via = 'packs';
      const model = require('./model');
      if (model.available(d, cfg).ok) {
        const prof = root ? require('./topics').profile(d, repoId, cfg.pinnedTopics) : [];
        const qs = await model.topicQuestions(d, cfg, { topic, projectTopics: (Array.isArray(prof) ? prof : []).map((t) => (typeof t === 'string' ? t : t.topic)).filter(Boolean) });
        for (const q of qs) {
          store.insertQuestion(d, {
            family: 'questionnaire', type: 'prepared', format: 'choice', topic: `prepared/${slug}`, track: null, difficulty: q.difficulty,
            grading: 'model', xp: { easy: 5, medium: 8, hard: 10 }[q.difficulty] || 8, title: `Prepared · ${topic}`, prompt: q.question,
            choices: q.choices, answer: q.answer, explanation: q.explanation, evidence: 'written by Claude on request, confirmed by a blind second answer',
            meta: { selectedBy: `prepared: ${topic}`, generatedBy: 'model' }, repo_id: repoId || null, batch,
          });
          added++;
        }
        if (added) via = 'claude';
      }
      if (!added) {
        const words = topic.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const hits = require('./packs').load().questions.filter((q) => q.format === 'multiple_choice' && words.some((w) => `${q.topic} ${q.track} ${q.question}`.toLowerCase().includes(w)));
        for (const pq of util.shuffle(hits).slice(0, 6)) {
          store.insertQuestion(d, { ...require('./packs').toQuestion(pq, { type: 'prepared', meta: { pack: pq.pack, selectedBy: `prepared: ${topic}` } }), repo_id: repoId || null, batch });
          added++;
        }
      }
      return out({ added, via, topic });
    }
    if (sub === 'model-notice-ack') {
      util.writeJson(path.join(util.home(), 'model-notice.json'), { at: util.nowIso() });
      return out({ ok: true });
    }
    if (sub === 'gate') {
      // No Mercy: while a fight against SKYNET is on, a question about the edit in the tool call on stdin.
      if (!require('./battle').noMercyActive()) return out({ skip: 'no No Mercy fight is on' });
      if (root && !enabled) return out({ skip: 'DiffDojo is stopped here' });
      let input;
      try {
        input = JSON.parse(util.readStdin() || '{}');
      } catch {
        return out({ skip: 'unreadable tool call' });
      }
      try {
        return out(require('./gate').create(d, input, { root: root || process.cwd(), repoId }));
      } catch (e) {
        util.log('gate', e);
        return out({ skip: `no question: ${e.message}` });
      }
    }
    if (sub === 'gate-answer') {
      const r = await require('./gate').answer(d, pos[2], pos.slice(3).join(' '), { cfg: config.load(repoId), root });
      // SKYNET's ability lands in the fight: a right answer hits it, a wrong one costs you tokens.
      const hit = r.error ? null : require('./battle').intercept(d, r);
      return out({ ...r, ...(hit ? { fight: hit } : {}), ...status() });
    }
    if (sub.startsWith('battle')) {
      const battle = require('./battle');
      try {
        if (sub === 'battle-state') return out({ ...status(), battle: config.load(repoId).battle, noMercy: battle.noMercyActive(), state: battle.view() });
        if (sub === 'battle-start') return out({ state: battle.view(battle.start(pos[2])) });
        if (sub === 'battle-quit') return out({ state: battle.view(battle.quit()) });
        if (sub === 'battle-resume') return out({ state: battle.view(battle.resume()) });
        if (sub === 'battle-turn-end') return out(battle.turnEnd(d, { reason: pos[2] }));
        if (sub === 'battle-question') return out(battle.nextQuestion(d, { repoId: enabled ? repoId : null }));
        if (sub === 'battle-answer') return out({ ...(await battle.answer(d, pos[2], { cfg: config.load(repoId), root })), ...status() });
      } catch (e) {
        return out({ error: e.message });
      }
      return out({ error: `unknown api command ${sub}` });
    }
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
    const sb = r.sandboxKind();
    const SB = { bwrap: 'bubblewrap (no network, read-only system, home hidden)', unshare: 'unshare (no network only; install bubblewrap for file isolation)', 'sandbox-exec': 'sandbox-exec (no network, no writes outside a temp folder)' };
    ok(sb === 'bwrap' || sb === 'sandbox-exec', `sandbox for Claude's code: ${SB[sb] || `none (runs with a timeout and minimal environment; set snippetSandbox to "require" to skip those questions)`}`);
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
