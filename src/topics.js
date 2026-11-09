'use strict';
// Topic detector: maps local signals (file types, APIs and includes in the
// diff, build files, pinned topics) to pack topics, and keeps a per-repo
// topic profile that decays over time so quizzes follow current work.

const fs = require('fs');
const path = require('path');

// Topic id -> belt track. Longest matching prefix wins.
const TRACKS = [
  ['cpp/concurrency', 'concurrency'],
  ['python/concurrency', 'concurrency'],
  ['javascript/async', 'javascript'],
  ['concurrency', 'concurrency'],
  ['cpp', 'cpp'],
  ['c/', 'cpp'],
  ['networking', 'networking'],
  ['python', 'python'],
  ['javascript', 'javascript'],
  ['typescript', 'javascript'],
  ['dsa', 'dsa'],
  ['sql', 'databases'],
  ['databases', 'databases'],
];

const TRACK_NAMES = {
  cpp: 'C++', concurrency: 'Concurrency', networking: 'Networking', python: 'Python',
  javascript: 'JavaScript/TypeScript', dsa: 'Data structures & algorithms', databases: 'Databases', general: 'General',
};

function trackOf(topic) {
  if (!topic) return 'general';
  let best = null;
  for (const [prefix, track] of TRACKS) {
    if (topic === prefix || topic.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') || topic.startsWith(prefix)) {
      if (!best || prefix.length > best[0].length) best = [prefix, track];
    }
  }
  return best ? best[1] : 'general';
}

// Signal rules: regex on added diff lines (and imports) -> topics with weight.
const RULES = [
  { re: /\bepoll_(?:wait|ctl|create1?)\b|\bEPOLL(?:IN|OUT|ET|ONESHOT)\b/, topics: ['networking/epoll', 'networking/linux'], w: 3 },
  { re: /\b(?:socket|bind|listen|accept4?|connect|recv|send|recvfrom|sendto|setsockopt|getaddrinfo)\s*\(/, topics: ['networking/sockets', 'networking/linux'], w: 2 },
  { re: /\bO_NONBLOCK\b|\bEAGAIN\b|\bEWOULDBLOCK\b|\bfcntl\s*\(/, topics: ['networking/nonblocking', 'networking/linux'], w: 2 },
  { re: /\bTCP_NODELAY\b|\bSO_REUSE(?:ADDR|PORT)\b|\bSOCK_STREAM\b|\btcp\b/i, topics: ['networking/tcp'], w: 1 },
  { re: /\bselect\s*\(|\bpoll\s*\(|\bio_uring\b|\bkqueue\b/, topics: ['networking/linux'], w: 1 },
  { re: /\bstd::(?:atomic|memory_order\w*)\b|\bmemory_order_\w+/, topics: ['cpp/concurrency/atomics', 'cpp/concurrency'], w: 3 },
  { re: /\bstd::(?:mutex|shared_mutex|lock_guard|unique_lock|scoped_lock|condition_variable|thread|jthread|async|future|promise|latch|barrier|counting_semaphore)\b|\bpthread_\w+/, topics: ['cpp/concurrency'], w: 3 },
  { re: /\bstd::(?:move|forward|unique_ptr|shared_ptr|weak_ptr|make_unique|make_shared)\b|&&\s*\w+\s*[,)]/, topics: ['cpp/core/memory', 'cpp/core'], w: 2 },
  { re: /\bstd::(?:vector|map|unordered_map|set|unordered_set|deque|list|array|string|optional|variant|span)\b/, topics: ['cpp/core'], w: 1 },
  { re: /\btemplate\s*<|\bconstexpr\b|\bconcept\b|\brequires\b/, topics: ['cpp/core/templates', 'cpp/core'], w: 2 },
  { re: /\bvirtual\b|\boverride\b|\bfinal\b/, topics: ['cpp/core'], w: 1 },
  { re: /\bimport asyncio\b|\basyncio\.\w+|\basync def\b|\bawait\b(?!.*[;{])/, topics: ['python/asyncio', 'python/core'], w: 2 },
  { re: /\bimport threading\b|\bthreading\.\w+|\bmultiprocessing\b|\bconcurrent\.futures\b/, topics: ['python/concurrency'], w: 3 },
  { re: /^\s*(?:def|class)\s|\bself\.\w+|\bimport \w+$/m, topics: ['python/core'], w: 1 },
  { re: /\b(?:yield|@\w+|__\w+__|with\s+\w+.*:$)/, topics: ['python/core'], w: 1 },
  { re: /\bPromise\b|\basync\s+function\b|\bawait\b|\.then\(/, topics: ['javascript/async', 'javascript/core'], w: 2 },
  { re: /\b(?:const|let)\s+\w+|=>\s*[{(]|\bmodule\.exports\b|\bexport\s+(?:default|const|function|class)\b/, topics: ['javascript/core'], w: 1 },
  { re: /\binterface\s+\w+|\btype\s+\w+\s*=|:\s*(?:string|number|boolean)\b/, topics: ['javascript/typescript', 'javascript/core'], w: 1 },
  { re: /\bheapq\b|\bpriority_queue\b|\bPriorityQueue\b|\bheap(?:push|pop|ify)\b/, topics: ['dsa/heaps', 'dsa/core'], w: 2 },
  { re: /\bbisect\b|\bbinary_search\b|\blower_bound\b|\bupper_bound\b|\bbinarySearch\b/, topics: ['dsa/search', 'dsa/core'], w: 2 },
  { re: /\b(?:dfs|bfs|dijkstra|topolog\w*|adjacen\w*|graph)\b/i, topics: ['dsa/graphs', 'dsa/core'], w: 2 },
  { re: /\b(?:sort|sorted|qsort|std::sort|stable_sort|merge_sort|quicksort)\b/i, topics: ['dsa/sorting', 'dsa/core'], w: 1 },
  { re: /\b(?:memo|cache|lru|dp\[|dynamic programming)\b/i, topics: ['dsa/core'], w: 1 },
  { re: /\b(?:unordered_map|HashMap|dict\(|new Map\(|hash)\b/, topics: ['dsa/hashing', 'dsa/core'], w: 1 },
  { re: /\bSELECT\b[\s\S]*\bFROM\b|\bINSERT INTO\b|\bUPDATE\s+\w+\s+SET\b|\bFOR UPDATE\b|\bBEGIN TRANSACTION\b/i, topics: ['sql/core'], w: 2 },
];

const LANG_SCOPE = { cpp: ['c', 'cpp'], python: ['python'], javascript: ['javascript', 'typescript'] };

const EXT_TOPICS = {
  cpp: ['cpp/core'], c: ['cpp/core'], python: ['python/core'], javascript: ['javascript/core'], typescript: ['javascript/core', 'javascript/typescript'],
};

const BUILD_FILES = [
  ['CMakeLists.txt', ['cpp/core']], ['Makefile', ['cpp/core']], ['meson.build', ['cpp/core']], ['conanfile.txt', ['cpp/core']],
  ['package.json', ['javascript/core']], ['tsconfig.json', ['javascript/typescript']],
  ['requirements.txt', ['python/core']], ['pyproject.toml', ['python/core']], ['setup.py', ['python/core']],
];

/**
 * Detect topics from diff files.
 * @param {Array<{file, lang, addedText}>} files
 * @returns {Map<topic, weight>}
 */
function detect(files, repoRoot) {
  const scores = new Map();
  const add = (t, w) => scores.set(t, (scores.get(t) || 0) + w);
  for (const f of files) {
    for (const t of EXT_TOPICS[f.lang] || []) add(t, 1);
    const text = f.addedText || '';
    for (const r of RULES) {
      if (!r.re.test(text)) continue;
      for (const t of r.topics) {
        // Language-specific topics only count for files in that language
        // (e.g. C++ `const std::vector` must not look like JavaScript `const x`).
        const scope = LANG_SCOPE[t.split('/')[0]];
        if (scope && !scope.includes(f.lang)) continue;
        add(t, r.w);
      }
    }
  }
  if (repoRoot) {
    for (const [file, topics] of BUILD_FILES) {
      if (fs.existsSync(path.join(repoRoot, file))) for (const t of topics) add(t, 0.5);
    }
  }
  return scores;
}

const HALF_LIFE_DAYS = 3;

function decayed(score, updatedAt, now = Date.now()) {
  const days = (now - Date.parse(updatedAt)) / 86400000;
  return score * Math.pow(0.5, Math.max(0, days) / HALF_LIFE_DAYS);
}

function updateProfile(db, repoId, scores) {
  const now = new Date().toISOString();
  for (const [topic, w] of scores) {
    const row = db.get('SELECT score, updated_at FROM topic_profile WHERE repo_id = ? AND topic = ?', repoId, topic);
    const prev = row ? decayed(row.score, row.updated_at) : 0;
    db.run(
      `INSERT INTO topic_profile(repo_id, topic, score, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(repo_id, topic) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
      repoId, topic, prev + w, now,
    );
  }
}

/** Current topics for a repo, highest first: [{topic, score, pinned}]. */
function profile(db, repoId, pinned = []) {
  const rows = repoId ? db.all('SELECT topic, score, updated_at FROM topic_profile WHERE repo_id = ?', repoId) : [];
  const out = rows.map((r) => ({ topic: r.topic, score: decayed(r.score, r.updated_at), pinned: false }));
  for (const p of pinned) {
    const ex = out.find((o) => o.topic === p);
    if (ex) {
      ex.pinned = true;
      ex.score += 5;
    } else out.push({ topic: p, score: 5, pinned: true });
  }
  return out.filter((o) => o.score > 0.05).sort((a, b) => b.score - a.score);
}

/** Does a question topic belong to a detected/pinned topic? (prefix match either way) */
function related(qTopic, topic) {
  if (!qTopic || !topic) return false;
  return qTopic === topic || qTopic.startsWith(topic + '/') || topic.startsWith(qTopic + '/');
}

module.exports = { detect, updateProfile, profile, related, trackOf, TRACK_NAMES, decayed };
