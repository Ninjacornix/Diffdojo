'use strict';
// `diffdojo share`: the score card goes to a GitHub Gist through the gh CLI.
// A fake `gh` on PATH records what would be sent and answers like GitHub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isolate, makeRepo } = require('./helpers');

const home = isolate();
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-fake-gh-'));
const log = path.join(bin, 'calls.jsonl');
fs.writeFileSync(path.join(bin, 'gh.js'), `
const fs = require('fs');
const args = process.argv.slice(2);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
const method = args[args.indexOf('-X') + 1];
const target = args[args.indexOf('-X') + 2];
if (method === 'DELETE') process.exit(0);
const id = method === 'POST' ? 'abc123' : target.split('/')[1];
process.stdout.write(JSON.stringify({ id, html_url: 'https://gist.github.com/me/' + id, public: true, owner: { login: 'me' } }));
`);
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.js')}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'gh.cmd'), `@node "%~dp0gh.js" %*\r\n`);
const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };

const repo = makeRepo({ 'secret_project_name.py': 'API_TOKEN = "do-not-send"\n' });
function dd(...args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'diffdojo'), ...args], { cwd: repo, encoding: 'utf8', env });
  return r.stdout;
}
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('share without --yes only shows what would be published', () => {
  const out = dd('share');
  assert.match(out, /This is what would be published/);
  assert.match(out, /# DiffDojo score/);
  assert.match(out, /Re-run with --yes/);
  assert.strictEqual(calls().length, 0, 'nothing sent');
});

test('share --yes creates a public gist with numbers only, then updates the same gist', () => {
  const out = dd('share', '--yes');
  assert.match(out, /Shared: https:\/\/gist\.github\.com\/me\/abc123/);
  const [create, link] = calls();
  assert.deepStrictEqual(create.args.slice(0, 4), ['api', '-X', 'POST', 'gists']);
  const body = JSON.parse(create.input);
  assert.strictEqual(body.public, true);
  assert.deepStrictEqual(Object.keys(body.files).sort(), ['diffdojo-badge.svg', 'diffdojo-score.json', 'diffdojo-score.md']);
  const sent = create.input + link.input;
  assert.ok(!sent.includes('secret_project_name') && !sent.includes('do-not-send') && !sent.includes(repo), 'no project names, paths or code');
  const data = JSON.parse(body.files['diffdojo-score.json'].content);
  assert.strictEqual(data.selfReported, true);
  assert.strictEqual(typeof data.projects, 'number');
  // The card links the badge once the gist exists.
  assert.match(JSON.parse(link.input).files['diffdojo-score.md'].content, /gist\.githubusercontent\.com\/me\/abc123\/raw\/diffdojo-badge\.svg/);
  // Sharing again updates the same gist.
  fs.writeFileSync(log, '');
  assert.match(dd('share', '--yes'), /Updated: https:\/\/gist\.github\.com\/me\/abc123/);
  assert.deepStrictEqual(calls().map((c) => c.args.slice(0, 4).join(' ')), ['api -X PATCH gists/abc123']);
});

test('--projects adds project names; --remove deletes the gist', () => {
  fs.writeFileSync(log, '');
  dd('share', '--yes', '--projects');
  assert.ok(Array.isArray(JSON.parse(JSON.parse(calls()[0].input).files['diffdojo-score.json'].content).projects));
  fs.writeFileSync(log, '');
  assert.match(dd('share', '--remove'), /Deleted your shared score/);
  assert.deepStrictEqual(calls().map((c) => c.args.slice(0, 4).join(' ')), ['api -X DELETE gists/abc123']);
  assert.ok(!fs.existsSync(path.join(home, 'share.json')));
});

test('without the GitHub CLI, share says how to get it', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'diffdojo'), 'share', '--yes'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: path.dirname(process.execPath) } });
  assert.match(r.stdout, /install it from https:\/\/cli\.github\.com/);
});
