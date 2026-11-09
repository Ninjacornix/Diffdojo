'use strict';
// `diffdojo demo`: a sandbox project for trying DiffDojo without prompting
// Claude. It commits a small "before" codebase, applies a simulated Claude
// change (with a matching session transcript), and runs the normal question
// pipeline on it, so the queue holds real questions about that change.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const util = require('./util');
const config = require('./config');

const SAMPLES = path.join(__dirname, '..', 'demo');
const SESSION = 'diffdojo-demo';

const TRANSCRIPT = [
  { type: 'user', version: '2.1.0', uuid: 'demo-u1', message: { content: 'Add a job scheduler, a retry queue and a few math helpers.' } },
  {
    type: 'assistant',
    version: '2.1.0',
    uuid: 'demo-a1',
    message: {
      content: [
        {
          type: 'text',
          text:
            'I added a Scheduler in scheduler.py. I store jobs in a heap because due() always needs the earliest deadline first and heappop gives that in O(log n). ' +
            'I also keep a bounded deque of recent jobs so that memory stays constant even when the scheduler runs for days. ' +
            'In retry_queue.cpp I guard push and drain with a mutex since both can be called from the network thread and the timer thread. ' +
            'I used a priority_queue ordered by deadline so that drain() can stop at the first request that is not due yet.',
        },
      ],
    },
  },
];

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

async function create({ dir } = {}) {
  const target = path.resolve(dir || path.join(os.homedir(), 'diffdojo-demo'));
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} already exists and is not empty (pass --dir <new folder>)`);
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q');
  git(target, 'config', 'user.email', 'demo@diffdojo.local');
  git(target, 'config', 'user.name', 'DiffDojo demo');
  for (const f of fs.readdirSync(path.join(SAMPLES, 'before'))) fs.copyFileSync(path.join(SAMPLES, 'before', f), path.join(target, f));
  fs.writeFileSync(path.join(target, 'README.md'), '# DiffDojo demo project\n\nA sandbox with a simulated Claude change. Delete it whenever you like.\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'before Claude');

  const repoId = util.repoId(target);
  const rdir = util.ensureDir(util.repoDir(repoId));
  const pipeline = require('./pipeline');
  pipeline.startSession(target, repoId, SESSION);

  // The simulated Claude change, recorded the way the edit hook records it.
  const events = [];
  for (const f of fs.readdirSync(path.join(SAMPLES, 'after'))) {
    fs.copyFileSync(path.join(SAMPLES, 'after', f), path.join(target, f));
    events.push(JSON.stringify({ ts: new Date().toISOString(), path: f, session: SESSION, tool: 'Write' }));
  }
  fs.appendFileSync(path.join(rdir, 'events.jsonl'), events.join('\n') + '\n');
  const transcriptPath = path.join(rdir, 'demo-transcript.jsonl');
  fs.writeFileSync(transcriptPath, TRANSCRIPT.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const cfg = { ...config.load(repoId), questionsPerTurn: 12, sessionCap: 60 };
  const r = await pipeline.onStop({ root: target, repoId, sessionId: SESSION, transcriptPath, cfg });
  return { dir: target, repoId, questions: r.questions || 0, files: r.files || 0 };
}

module.exports = { create };
