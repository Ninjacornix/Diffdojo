'use strict';
// Questionnaire packs: YAML files under packs/<name>/ (shipped) and
// ~/.diffdojo/packs/<name>/ (local). Each file holds one question mapping or
// a `questions:` list. An optional pack.yaml supplies defaults (topic, track).
// Every question is validated against the schema below at load time.

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');
const { home } = require('./util');
const { trackOf } = require('./topics');

const FORMATS = ['multiple_choice', 'multiple_select', 'true_false', 'short_answer', 'ordering', 'predict_output'];
const DIFFS = ['easy', 'medium', 'hard'];
const LANGS = ['cpp', 'c', 'python', 'javascript'];

function validate(q) {
  const errs = [];
  const isStr = (v) => typeof v === 'string' && v.trim() !== '';
  if (!isStr(q.id) || !/^[a-z0-9][a-z0-9-]*$/.test(q.id)) errs.push('id must be lowercase letters, digits and dashes');
  if (!isStr(q.topic) || !/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(q.topic)) errs.push('topic must look like "area/sub"');
  if (!DIFFS.includes(q.difficulty)) errs.push(`difficulty must be one of ${DIFFS.join(', ')}`);
  if (!FORMATS.includes(q.format)) errs.push(`format must be one of ${FORMATS.join(', ')}`);
  if (!isStr(q.question)) errs.push('question is required');
  if (!isStr(q.explanation)) errs.push('explanation is required');
  if (q.references != null && !(Array.isArray(q.references) && q.references.every(isStr))) errs.push('references must be a list of strings');
  if (q.code != null && typeof q.code !== 'string') errs.push('code must be a string');
  if (q.language != null && !LANGS.includes(q.language)) errs.push(`language must be one of ${LANGS.join(', ')}`);
  const keysOk = (m) => m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length >= 2 && Object.values(m).every((v) => v != null && String(v).trim() !== '');
  switch (q.format) {
    case 'multiple_choice':
      if (!keysOk(q.choices)) errs.push('choices must map at least two keys to text');
      else if (typeof q.answer !== 'string' || !(q.answer in q.choices)) errs.push('answer must be exactly one key of choices');
      if (q.choices && new Set(Object.values(q.choices).map((v) => String(v).trim().toLowerCase())).size !== Object.keys(q.choices).length) errs.push('choices must be distinct');
      break;
    case 'multiple_select':
      if (!keysOk(q.choices)) errs.push('choices must map at least two keys to text');
      else if (!Array.isArray(q.answer) || !q.answer.length || !q.answer.every((a) => a in q.choices) || new Set(q.answer).size !== q.answer.length) errs.push('answer must be a list of distinct choice keys');
      break;
    case 'true_false':
      if (typeof q.answer !== 'boolean') errs.push('answer must be true or false');
      break;
    case 'short_answer':
      if (q.answer == null || (typeof q.answer !== 'string' && typeof q.answer !== 'number')) errs.push('answer must be a string or number');
      if (q.accept != null && !(Array.isArray(q.accept) && q.accept.every((a) => a != null))) errs.push('accept must be a list');
      break;
    case 'ordering':
      if (!keysOk(q.items)) errs.push('items must map at least two keys to text');
      else if (!Array.isArray(q.answer) || q.answer.length !== Object.keys(q.items).length || !q.answer.every((a) => a in q.items) || new Set(q.answer).size !== q.answer.length) errs.push('answer must be a permutation of the item keys');
      break;
    case 'predict_output':
      if (!isStr(q.code)) errs.push('predict_output needs code');
      if (!LANGS.includes(q.language)) errs.push('predict_output needs language');
      if (typeof q.answer !== 'string' && typeof q.answer !== 'number') errs.push('answer must be the expected output');
      break;
    default:
  }
  return errs;
}

function loadDir(dir, origin) {
  const questions = [];
  const errors = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { questions, errors };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pdir = path.join(dir, ent.name);
    let meta = {};
    const metaFile = path.join(pdir, 'pack.yaml');
    if (fs.existsSync(metaFile)) {
      try {
        meta = yaml.parse(fs.readFileSync(metaFile, 'utf8')) || {};
      } catch (e) {
        errors.push({ file: metaFile, error: e.message });
      }
    }
    const files = fs.readdirSync(pdir).filter((f) => /\.ya?ml$/.test(f) && f !== 'pack.yaml').sort();
    for (const f of files) {
      const file = path.join(pdir, f);
      let docs;
      try {
        docs = yaml.parseAll(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        errors.push({ file, error: e.message });
        continue;
      }
      for (const doc of docs) {
        const list = doc && Array.isArray(doc.questions) ? doc.questions : doc ? [doc] : [];
        for (const raw of list) {
          const q = { topic: meta.topic, ...raw };
          const errs = validate(q);
          if (errs.length) {
            errors.push({ file, id: raw && raw.id, error: errs.join('; ') });
            continue;
          }
          q.pack = meta.name || ent.name;
          q.track = q.track || meta.track || trackOf(q.topic);
          q.origin = origin;
          q.file = file;
          questions.push(q);
        }
      }
    }
  }
  return { questions, errors };
}

let cache = null;

function shippedDir() {
  return path.join(__dirname, '..', 'packs');
}

function load({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  const a = loadDir(shippedDir(), 'shipped');
  const b = loadDir(path.join(home(), 'packs'), 'local');
  const byId = new Map();
  const errors = a.errors.concat(b.errors);
  for (const q of a.questions.concat(b.questions)) {
    if (byId.has(q.id)) {
      errors.push({ file: q.file, id: q.id, error: `duplicate id (also in ${byId.get(q.id).file})` });
      continue;
    }
    byId.set(q.id, q);
  }
  cache = { questions: [...byId.values()], byId, errors };
  return cache;
}

function normQuestion(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Pack CI checks beyond schema: duplicate text. Snippet execution lives in scripts/pack-ci.js. */
function duplicates(questions) {
  const seen = new Map();
  const dups = [];
  for (const q of questions) {
    const k = normQuestion(q.question) + '|' + (q.code ? normQuestion(q.code) : '');
    if (seen.has(k)) dups.push([seen.get(k).id, q.id]);
    else seen.set(k, q);
  }
  return dups;
}

/** Convert a pack question into a stored question row. */
function toQuestion(q, extra = {}) {
  const xp = { easy: 5, medium: 10, hard: 15 }[q.difficulty];
  let format = q.format;
  let choices = q.choices || null;
  if (q.format === 'ordering') choices = q.items;
  const answer = q.format === 'short_answer' ? { value: q.answer, accept: q.accept || [] } : q.answer;
  return {
    family: 'questionnaire',
    type: 'pack',
    format,
    topic: q.topic,
    track: q.track,
    difficulty: q.difficulty,
    grading: 'verified',
    xp,
    est_seconds: q.format === 'predict_output' ? 120 : q.difficulty === 'hard' ? 120 : 60,
    title: `Questionnaire · ${q.topic}`,
    prompt: q.question.trim(),
    code: q.code || null,
    code_lang: q.language || null,
    choices,
    answer,
    explanation: q.explanation.trim(),
    evidence: (q.references || []).join('; ') || null,
    meta: { pack: q.pack, references: q.references || [], origin: q.origin },
    source: `pack:${q.id}`,
    ...extra,
  };
}

module.exports = { load, validate, duplicates, toQuestion, FORMATS, shippedDir };
