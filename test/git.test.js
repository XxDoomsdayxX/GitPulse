'use strict'

const { test } = require('node:test')
const assert   = require('node:assert')

const { parseRemote, sameRepo, verifyClone, pull } = require('../lib/git')

/** Stub execFile: maps a git argv to canned stdout/err. */
function fakeGit(responses) {
  const calls = []
  const exec = (file, args, opts, cb) => {
    calls.push({ file, args, opts })
    const key = args.join(' ')
    const hit = Object.keys(responses).find(k => key.includes(k))
    const res = hit ? responses[hit] : { err: new Error('unexpected git call: ' + key) }
    process.nextTick(() => cb(res.err || null, res.stdout || '', res.stderr || ''))
  }
  return { exec, calls }
}

test('parseRemote: handles every GitHub remote form', () => {
  const cases = {
    'https://github.com/octocat/hello.git': 'octocat/hello',
    'https://github.com/octocat/hello':     'octocat/hello',
    'git@github.com:octocat/hello.git':     'octocat/hello',
    'ssh://git@github.com/octocat/hello':   'octocat/hello',
    'https://user@github.com/octocat/hello.git': 'octocat/hello'
  }
  for (const [url, expected] of Object.entries(cases)) assert.strictEqual(parseRemote(url), expected, url)

  for (const bad of ['https://gitlab.com/a/b.git', '', null, 'not a url', undefined]) {
    assert.strictEqual(parseRemote(bad), null)
  }
})

test('sameRepo: case-insensitive, rejects a different repo', () => {
  assert.ok(sameRepo('https://github.com/OctoCat/Hello.git', 'octocat/hello'))
  assert.ok(!sameRepo('https://github.com/octocat/other.git', 'octocat/hello'))
  assert.ok(!sameRepo('https://gitlab.com/octocat/hello.git', 'octocat/hello'))
})

test('verifyClone: rejects a folder that is not a git repo', async () => {
  const { exec } = fakeGit({ 'rev-parse --is-inside-work-tree': { err: new Error('not a repo'), stderr: 'fatal: not a git repository' } })
  const res = await verifyClone('C:/tmp', 'octocat/hello', { exec })
  assert.strictEqual(res.ok, false)
  assert.match(res.error, /Not a git repository/)
})

test('verifyClone: rejects a clone of a different repository', async () => {
  const { exec } = fakeGit({
    'rev-parse --is-inside-work-tree': { stdout: 'true' },
    'remote get-url origin':           { stdout: 'https://github.com/someone/else.git' }
  })
  const res = await verifyClone('C:/tmp', 'octocat/hello', { exec })
  assert.strictEqual(res.ok, false)
  assert.match(res.error, /someone\/else/)
})

test('verifyClone: accepts the matching clone', async () => {
  const { exec } = fakeGit({
    'rev-parse --is-inside-work-tree': { stdout: 'true' },
    'remote get-url origin':           { stdout: 'git@github.com:octocat/hello.git' }
  })
  assert.deepStrictEqual(await verifyClone('C:/tmp', 'octocat/hello', { exec }), { ok: true })
})

test('pull: refuses to run in a folder belonging to another repo', async () => {
  const { exec, calls } = fakeGit({
    'rev-parse --is-inside-work-tree': { stdout: 'true' },
    'remote get-url origin':           { stdout: 'https://github.com/someone/else.git' }
  })
  const res = await pull('C:/tmp', 'octocat/hello', { exec })
  assert.strictEqual(res.ok, false)
  assert.ok(!calls.some(c => c.args.includes('pull')), 'must not reach git pull')
})

test('pull: reports the SHA that actually landed, not the polled one', async () => {
  const { exec } = fakeGit({
    'rev-parse --is-inside-work-tree': { stdout: 'true' },
    'remote get-url origin':           { stdout: 'https://github.com/octocat/hello.git' },
    'pull':                            { stdout: 'Updating abc..def\nFast-forward' },
    'rev-parse HEAD':                  { stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    'rev-parse --abbrev-ref HEAD':     { stdout: 'main' }
  })
  const res = await pull('C:/tmp', 'octocat/hello', { exec })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.sha, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  assert.strictEqual(res.branch, 'main')
})

test('pull: passes paths as argv and disables interactive prompts', async () => {
  const nasty = 'C:/tmp/repo"; rm -rf /'
  const { exec, calls } = fakeGit({
    'rev-parse --is-inside-work-tree': { stdout: 'true' },
    'remote get-url origin':           { stdout: 'https://github.com/octocat/hello.git' },
    'pull':                            { stdout: 'Already up to date.' },
    'rev-parse HEAD':                  { stdout: 'abc' },
    'rev-parse --abbrev-ref HEAD':     { stdout: 'main' }
  })
  await pull(nasty, 'octocat/hello', { exec })

  const pullCall = calls.find(c => c.args.includes('pull'))
  assert.deepStrictEqual(pullCall.args, ['-c', `safe.directory=${nasty}`, 'pull', '--ff-only'])
  assert.strictEqual(pullCall.opts.env.GIT_TERMINAL_PROMPT, '0')
  assert.strictEqual(pullCall.opts.cwd, nasty)
})

test('pull: git failures become actionable messages', async () => {
  const scenarios = [
    ['error: Your local changes to the following files would be overwritten by merge', /Uncommitted local changes/],
    ['fatal: Not possible to fast-forward, aborting.',                                 /diverged/],
    ['fatal: could not read Username for https://github.com',                          /credentials/],
    ['fatal: unable to access: Could not resolve host: github.com',                    /Network/]
  ]
  for (const [stderr, expected] of scenarios) {
    const { exec } = fakeGit({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin':           { stdout: 'https://github.com/octocat/hello.git' },
      'pull':                            { err: new Error('exit 1'), stderr }
    })
    const res = await pull('C:/tmp', 'octocat/hello', { exec })
    assert.strictEqual(res.ok, false)
    assert.match(res.error, expected)
  }
})
