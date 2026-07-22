'use strict'

const { test } = require('node:test')
const assert   = require('node:assert')
const { EventEmitter } = require('node:events')

const { createClient } = require('../lib/github')

function fakeHttp(queue) {
  const sent = []
  const request = (opts, cb) => {
    sent.push(opts)
    const res = new EventEmitter()
    const next = queue.shift() || { status: 500, body: '{"message":"queue empty"}' }
    res.statusCode = next.status
    res.headers    = next.headers || {}
    process.nextTick(() => { cb(res); if (next.body) res.emit('data', next.body); res.emit('end') })
    const req = new EventEmitter()
    req.setTimeout = () => {}; req.end = () => {}; req.destroy = () => {}
    return req
  }
  return { request, sent }
}

test('a 304 with nothing cached refetches instead of returning null', async () => {
  const body = JSON.stringify({ sha: 'abc1234567', commit: { message: 'msg', author: { name: 'Ada' } } })
  // First response primes the ETag; the cache is then dropped out from under
  // the client (simulated by replying 304 to a request we never cached).
  const { request, sent } = fakeHttp([
    { status: 304, headers: { etag: 'W/"stale"' } },
    { status: 200, headers: { etag: 'W/"fresh"' }, body }
  ])
  const gh = createClient({ getToken: () => 'tok', request })

  const commit = await gh.commit('o/r', 'main')
  assert.strictEqual(commit.shortSha, 'abc1234')
  assert.strictEqual(sent.length, 2, 'retried without the conditional header')
  assert.strictEqual(sent[1].headers['If-None-Match'], undefined)
})
