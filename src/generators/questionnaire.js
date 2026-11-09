'use strict';
// Family B: questionnaire questions from curated packs, chosen by topic
// profile and adaptive per-topic difficulty. A pack question isn't repeated
// until the rest of its topic has been seen (except in review mode).

const packs = require('../packs');
const { related } = require('../topics');
const { unlocked } = require('../rewards');
const { shuffle } = require('../util');

const LEVEL = { easy: 1, medium: 2, hard: 3 };

function topicLevel(db, topic) {
  const r = db.get('SELECT level FROM topic_state WHERE topic = ?', topic);
  return r ? r.level : 1;
}

/** Adaptive difficulty: two right in a row raise the level, two wrong lower it. */
function recordResult(db, topic, correct) {
  if (!topic) return;
  const r = db.get('SELECT * FROM topic_state WHERE topic = ?', topic) || { level: 1, right_run: 0, wrong_run: 0 };
  let { level, right_run: right, wrong_run: wrong } = r;
  if (correct) {
    right++;
    wrong = 0;
    if (right >= 2) {
      level = Math.min(3, level + 1);
      right = 0;
    }
  } else {
    wrong++;
    right = 0;
    if (wrong >= 2) {
      level = Math.max(1, level - 1);
      wrong = 0;
    }
  }
  db.run(
    `INSERT INTO topic_state(topic, level, right_run, wrong_run) VALUES (?,?,?,?)
     ON CONFLICT(topic) DO UPDATE SET level = excluded.level, right_run = excluded.right_run, wrong_run = excluded.wrong_run`,
    topic, level, right, wrong,
  );
}

function seenSources(db) {
  const rows = db.all("SELECT DISTINCT source FROM questions WHERE source LIKE 'pack:%' AND status IN ('answered','queued','snoozed','exam','skipped')");
  return new Set(rows.map((r) => r.source.slice(5)));
}

/**
 * Pick pack questions.
 * @param {object} o {topics:[{topic,score}], count, track?, difficulty?, exclude?:Set, allowHard?:bool}
 */
function pickPack(db, o) {
  const { questions } = packs.load();
  let pool = questions;
  if (o.track) pool = pool.filter((q) => q.track === o.track);
  if (o.topicFilter) pool = pool.filter((q) => related(q.topic, o.topicFilter) || q.topic.startsWith(o.topicFilter));
  if (o.difficulty) pool = pool.filter((q) => q.difficulty === o.difficulty);
  if (o.exclude) pool = pool.filter((q) => !o.exclude.has(q.id));
  // Hard questions unlock at Orange in their track.
  if (!o.difficulty) pool = pool.filter((q) => q.difficulty !== 'hard' || o.allowHard || unlocked(db, q.track, 'hard'));
  if (!pool.length) return [];

  const seen = seenSources(db);
  const picked = [];
  const topics = (o.topics || []).length ? o.topics : [{ topic: null, score: 1 }];
  const weights = topics.map((t) => t.score);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const rnd = o.rnd || Math.random;

  for (let i = 0; i < o.count * 4 && picked.length < o.count; i++) {
    // weighted topic choice
    let r = rnd() * total;
    let t = topics[0];
    for (let k = 0; k < topics.length; k++) {
      r -= weights[k];
      if (r <= 0) {
        t = topics[k];
        break;
      }
    }
    let cand = t.topic ? pool.filter((q) => related(q.topic, t.topic)) : pool;
    if (!cand.length) cand = pool;
    // unseen first within the topic area; reset when exhausted
    const unseen = cand.filter((q) => !seen.has(q.id) && !picked.includes(q));
    if (unseen.length) cand = unseen;
    else cand = cand.filter((q) => !picked.includes(q));
    if (!cand.length) continue;
    if (!o.difficulty) {
      const level = topicLevel(db, t.topic || cand[0].topic);
      const near = cand.filter((q) => LEVEL[q.difficulty] === level);
      if (near.length) cand = near;
    }
    picked.push(shuffle(cand, rnd)[0]);
  }
  return picked.map((q) => {
    const why = topics.find((t) => t.topic && related(q.topic, t.topic));
    return packs.toQuestion(q, { meta: { pack: q.pack, references: q.references || [], selectedBy: why ? `${why.pinned ? 'pinned' : 'detected'} topic ${why.topic}` : 'general practice' } });
  });
}

module.exports = { pickPack, recordResult, topicLevel };
