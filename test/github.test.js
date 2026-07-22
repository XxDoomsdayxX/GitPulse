'use strict'

const { test } = require('node:test')
const assert   = require('node:assert')
const { EventEmitter } = require('node:events')

const { createClient, describeError, rateLimitResetAt } = require('../lib/github')

/** Stub https.request returning queued responses and recording sent headers. */
function fakeHttp(queue) {
  const sent = []
  const request = (opts, cb) => {
    sent.push(opts)
    const res = new EventEmitter()
    const next = queue.shift() || { status: 200, body: '{}' }
    res.statusCode = next.status
    res.headers    = next.headers || {}
    process.nextTick(() => {
      cb(res)
      if (next.body) res.emit('data', next.body)
      res.emit('end')
    })
    const req = new EventEmitter()
    req.setTimeout = () => {}
    req.end = () => {}
    req.destroy = () => {}
    return req
  }
  return { request, sent }
}

const client = (queue, opts = {}) =>
  createClient({ getToken: () => 'tok', request: fakeHttp(queue).request, ...opts })

test('describeError: distinguishes the failures a user must act on differently', () => {
  assert.match(describeError(401, {}), /invalid or expired/)
  assert.match(describeError(403, {}, { 'x-ratelimit-remaining': '0' }), /rate limit/i)
  assert.match(describeError(403, { message: 'SAML enforcement' }), /SSO/)
  assert.match(describeError(404, {}), /not found/i)
  assert.match(describeError(409, {}), /empty/i)
  assert.match(describeError(503, {}), /unavailable/i)
})

test('rateLimitResetAt: only when the remaining quota is actually zero', () => {
  assert.strictEqual(rateLimitResetAt(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' }), 1700000000000)
  assert.strictEqual(rateLimitResetAt(403, { 'x-ratelimit-remaining': '12' }), null)
  assert.strictEqual(rateLimitResetAt(404, {}), null)
})

test('missing token fails fast with a NO_TOKEN code', async () => {
  const gh = createClient({ getToken: () => null, request: fakeHttp([]).request })
  await assert.rejects(() => gh.user(), e => e.code === 'NO_TOKEN')
})

test('commit: parses the fields the widget displays', async () => {
  const gh = client([{ status: 200, body: JSON.stringify({
    sha: 'abcdef1234567890',
    html_url: 'https://github.com/o/r/commit/abcdef1',
    commit: { message: 'fix: thing\n\nlong body', author: { name: 'Ada', date: '2026-01-01T00:00:00Z' } }
  }) }])

  const c = await gh.commit('o/r', 'main')
  assert.strictEqual(c.shortSha, 'abcdef1')
  assert.strictEqual(c.message, 'fix: thing', 'only the subject line')
  assert.strictEqual(c.author, 'Ada')
})

test('commit: sends If-None-Match and serves 304s from cache', async () => {
  const { request, sent } = fakeHttp([
    { status: 200, headers: { etag: 'W/"v1"' }, body: JSON.stringify({ sha: 'aaa', commit: { message: 'one', author: { name: 'Ada' } } }) },
    { status: 304, headers: { etag: 'W/"v1"' } }
  ])
  const gh = createClient({ getToken: () => 'tok', request })

  const first  = await gh.commit('o/r', 'main')
  const second = await gh.commit('o/r', 'main')

  assert.strictEqual(sent[1].headers['If-None-Match'], 'W/"v1"')
  assert.deepStrictEqual(second, first, '304 returns the cached commit')
})

test('rate limiting blocks further calls until the reset time', async () => {
  let now = 1_000_000
  const { request } = fakeHttp([
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 300_000) / 1000) }, body: '{"message":"rate limit"}' }
  ])
  const gh = createClient({ getToken: () => 'tok', request, now: () => now })

  await assert.rejects(() => gh.commit('o/r', 'main'), e => e.code === 'RATE_LIMIT')
  // Second call short-circuits without hitting the network (queue is empty, so
  // a real request would throw "unexpected").
  await assert.rejects(() => gh.commit('o/r', 'main'), e => /retry in \d+m/.test(e.message))
})

test('repos: paginates and includes organization repositories', async () => {
  const page = n => JSON.stringify(Array.from({ length: n }, (_, i) => ({
    full_name: `org/repo${i}`, name: `repo${i}`, default_branch: 'main', private: false
  })))
  const { request, sent } = fakeHttp([
    { status: 200, body: page(100) },
    { status: 200, body: page(3) }
  ])
  const gh = createClient({ getToken: () => 'tok', request })

  const repos = await gh.repos()
  assert.strictEqual(repos.length, 103)
  assert.match(sent[0].path, /affiliation=owner,collaborator,organization_member/)
  assert.match(sent[1].path, /page=2/)
})

test('aheadBy: returns the commit count, and null when the base SHA is gone', async () => {
  const ok = client([{ status: 200, body: JSON.stringify({ ahead_by: 4 }) }])
  assert.strictEqual(await ok.aheadBy('o/r', 'base', 'main'), 4)

  const gone = client([{ status: 404, body: '{"message":"Not Found"}' }])
  assert.strictEqual(await gone.aheadBy('o/r', 'base', 'main'), null)
})

test('branch names with slashes are URL-encoded', async () => {
  const { request, sent } = fakeHttp([
    { status: 200, body: JSON.stringify({ sha: 'a', commit: { message: 'm', author: { name: 'A' } } }) }
  ])
  const gh = createClient({ getToken: () => 'tok', request })
  await gh.commit('o/r', 'feature/new-thing')
  assert.match(sent[0].path, /commits\/feature%2Fnew-thing/)
})
