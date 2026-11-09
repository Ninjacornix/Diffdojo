'use strict';
// `diffdojo serve`: local web UI on 127.0.0.1 with a random port and a
// one-time token in the URL. Every request must carry the token and a
// localhost Host header (DNS-rebinding guard). Answer keys never leave the
// server before an answer is graded.

const http = require('http');
const crypto = require('crypto');
const queue = require('./queue');
const grader = require('./grader');
const stats = require('./stats');
const config = require('./config');
const { numbered } = require('./generators/code');
const { HINT, TYPE, FAMILY, GRADING, relativeNumbering } = require('./quiz');

function publicQuestion(q) {
  if (!q) return null;
  return {
    id: q.id, family: FAMILY[q.family] || q.family, type: TYPE[q.type] || q.type, grading: GRADING[q.grading] || q.grading,
    topic: q.topic, difficulty: q.difficulty, xp: q.xp, est: Math.max(1, Math.round((q.est_seconds || 60) / 60)),
    prompt: q.prompt, code: q.code ? numbered(q.code, relativeNumbering(q) ? 1 : q.code_start) : null,
    location: q.code_file ? `${q.code_file}${q.code_start ? ':' + q.code_start + (q.code_end && q.code_end !== q.code_start ? '-' + q.code_end : '') : ''}` : null,
    choices: q.choices, format: q.format, hint: HINT[q.format] || 'Answer', exam: !!q.exam_id,
    selectedBy: q.meta && q.meta.selectedBy,
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DiffDojo</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e4e2da;--acc:#2f6f4f;--bad:#b3261e;--good:#1e7a3d;--code:#f3f2ec}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--mut:#9a9890;--card:#1f1f1c;--line:#34332e;--acc:#7cc39c;--bad:#f2867e;--good:#7fd69a;--code:#262622}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}header{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline}
h1{font-size:20px;margin:0}.mut{color:var(--mut);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:16px}
.label{font-weight:600;color:var(--acc);font-size:13px;letter-spacing:.02em}pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
.choice{display:block;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:6px 0;cursor:pointer}.choice:hover{border-color:var(--acc)}
input[type=text],textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:var(--bg)}.ok{color:var(--good);font-weight:600}.no{color:var(--bad);font-weight:600}
.explain{white-space:pre-wrap;margin-top:8px}.empty{color:var(--mut);text-align:center;padding:40px 0}
</style></head><body><main>
<header><h1>DiffDojo</h1><span class="mut" id="hdr"></span></header>
<div id="app"></div>
<p class="mut">Local only · nothing leaves this machine · <a href="#" id="statsLink">stats</a></p>
</main>
<script>
const TOKEN = new URLSearchParams(location.search).get('token');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(path, body) {
  const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN, body ? { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) } : {});
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
let current = null, t0 = 0;
async function load() {
  const d = await api('/api/next');
  $('#hdr').textContent = d.header;
  current = d.question; t0 = Date.now();
  const app = $('#app');
  if (!current) { app.innerHTML = '<div class="card empty">No questions queued. They appear after Claude finishes a turn in an enabled repo.<div class="row" style="justify-content:center"><input type="text" id="topic" placeholder="topic, e.g. cpp/core" style="max-width:240px"><button id="go">Quiz me on a topic</button></div></div>';
    $('#go').onclick = async () => { await api('/api/topic', { topic: $('#topic').value || 'cpp/core' }); load(); }; return; }
  const q = current;
  let input;
  if (q.choices && (q.format === 'choice' || q.format === 'multiple_choice')) input = Object.entries(q.choices).map(([k,v]) => '<label class="choice"><input type="radio" name="c" value="'+k+'"> <b>'+k+')</b> '+esc(v)+'</label>').join('');
  else if (q.choices && (q.format === 'multi' || q.format === 'multiple_select')) input = Object.entries(q.choices).map(([k,v]) => '<label class="choice"><input type="checkbox" name="c" value="'+k+'"> <b>'+k+')</b> '+esc(v)+'</label>').join('');
  else if (q.choices) input = Object.entries(q.choices).map(([k,v]) => '<div class="choice"><b>'+k+')</b> '+esc(v)+'</div>').join('') + '<input type="text" id="ans" placeholder="'+esc(q.hint)+'">';
  else if (q.format === 'text') input = '<textarea id="ans" rows="4" placeholder="'+esc(q.hint)+'"></textarea>';
  else input = '<input type="text" id="ans" placeholder="'+esc(q.hint)+'">';
  app.innerHTML = '<div class="card"><div class="label">['+esc(q.family)+' · '+esc(q.type)+' · '+esc(q.grading)+']</div>' +
    '<div class="mut">'+esc(q.topic||'general')+' · '+q.difficulty+' · ~'+q.est+' min'+(q.xp?' · '+q.xp+' XP':'')+(q.location?' · '+esc(q.location):'')+'</div>' +
    (q.selectedBy ? '<div class="mut">selected by '+esc(q.selectedBy)+'</div>' : '') + (q.exam ? '<div class="label">Belt exam question</div>' : '') +
    '<p>'+esc(q.prompt)+'</p>' + (q.code ? '<pre>'+esc(q.code)+'</pre>' : '') + '<form id="f">'+input+
    '<div class="row"><button class="primary" type="submit">Answer</button><button type="button" data-a="skip">Skip</button><button type="button" data-a="snooze">Snooze</button><button type="button" data-a="bad">Bad question</button></div></form><div id="res"></div></div>';
  const ans = $('#ans'); if (ans) ans.focus();
  $('#f').onsubmit = async (e) => { e.preventDefault();
    let response;
    const checked = [...document.querySelectorAll('input[name=c]:checked')].map((x) => x.value);
    response = checked.length ? checked.join(',') : (ans ? ans.value : '');
    const r = await api('/api/answer', { id: q.id, response, timeMs: Date.now() - t0 });
    $('#res').innerHTML = '<hr>' + (r.correct === true ? '<span class="ok">✓ Correct'+(r.xp?' +'+r.xp+' XP':'')+'</span>' : r.correct === false ? '<span class="no">✗ Not quite</span>' : '<span class="mut">Saved.</span>') +
      (r.answerText ? '<div>Answer: <b>'+esc(r.answerText)+'</b></div>' : '') + (r.detail ? '<pre>'+esc(r.detail)+'</pre>' : '') +
      '<div class="explain">'+esc(r.explanation||'')+'</div>' + (r.evidence ? '<div class="mut explain">Evidence: '+esc(r.evidence)+'</div>' : '') +
      (r.feedback ? '<div class="explain">Feedback (no XP): '+esc(r.feedback)+'</div>' : '') +
      (r.trophies||[]).map((t) => '<div class="label">🏆 '+esc(t.name)+'</div>').join('') +
      '<div class="row"><button class="primary" id="next">Next</button></div>';
    $('#f').querySelectorAll('button').forEach((b) => b.disabled = true);
    $('#next').onclick = load; $('#next').focus();
  };
  document.querySelectorAll('button[data-a]').forEach((b) => b.onclick = async () => { await api('/api/' + b.dataset.a, { id: q.id }); load(); });
}
$('#statsLink').onclick = async (e) => { e.preventDefault(); const s = await api('/api/stats'); $('#app').innerHTML = '<div class="card"><pre>'+esc(s.text)+'</pre><div class="row"><button class="primary" id="back">Back</button></div></div>'; $('#back').onclick = load; };
load().catch((e) => { $('#app').innerHTML = '<div class="card no">'+esc(e.message)+'</div>'; });
</script></body></html>`;

function answerText(q, r) {
  if (r.correct !== false || q.answer == null) return null;
  if (typeof q.answer === 'string' || typeof q.answer === 'boolean') return String(q.answer);
  if (Array.isArray(q.answer)) return q.answer.join(', ');
  if (q.answer.lines) return q.answer.lines.length ? `line ${q.answer.lines.join(', ')}` : 'none (no bug seeded)';
  if (q.answer.output !== undefined) return q.answer.output;
  if (q.answer.value !== undefined) return String(q.answer.value);
  return null;
}

function start({ db, repoId, root, port = 0 }) {
  const token = crypto.randomBytes(16).toString('hex');
  let actualPort = port;
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      const host = (req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) return send(403, { error: 'bad host' });
      const tok = url.searchParams.get('token') || '';
      if (tok.length !== token.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(token))) return send(403, { error: 'bad token' });
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const ch of req) {
          size += ch.length;
          if (size > 64 * 1024) return send(413, { error: 'too large' });
          chunks.push(ch);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      }
      const p = url.pathname;
      if (p === '/' && req.method === 'GET') return send(200, PAGE, 'text/html; charset=utf-8');
      if (p === '/api/next') return send(200, { header: stats.header(db, {}), question: publicQuestion(queue.next(db, { repoId })) });
      if (p === '/api/stats') return send(200, { text: stats.format(stats.compute(db, {})), data: stats.compute(db, {}) });
      if (p === '/api/topic' && req.method === 'POST') return send(200, { ids: queue.topicQuiz(db, { topic: String(body.topic || 'cpp/core'), count: 5 }) });
      const q = body.id ? queue.get(db, Number(body.id)) : null;
      if (!q) return send(404, { error: 'no such question' });
      const cfg = config.load(q.repo_id || repoId);
      if (p === '/api/answer' && req.method === 'POST') {
        if (q.status === 'answered') return send(409, { error: 'already answered' });
        const qroot = (q.repo_id && queue.repoPath(db, q.repo_id)) || root;
        const r = await grader.answer(db, q, String(body.response || ''), { mode: q.exam_id ? 'exam' : 'normal', root: qroot, cfg, timeMs: Number(body.timeMs) || null });
        return send(200, { ...r, answerText: answerText(q, r) });
      }
      if (p === '/api/skip') return grader.skip(db, q), send(200, { ok: true });
      if (p === '/api/snooze') return grader.snooze(db, q, cfg.snoozeMinutes), send(200, { ok: true });
      if (p === '/api/bad') return grader.bad(db, q), send(200, { ok: true });
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: e.message });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      resolve({ server, port: actualPort, token, url: `http://127.0.0.1:${actualPort}/?token=${token}` });
    });
  });
}

module.exports = { start, publicQuestion, answerText };
