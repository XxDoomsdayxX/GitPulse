'use strict'

const { test } = require('node:test')
const assert   = require('node:assert')
const fs       = require('node:fs')
const os       = require('node:os')
const path     = require('node:path')

const { migrate, createStore, defaults } = require('../lib/settings')

const tmpFile = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gitpulse-')), name)

test('migrate: v1 single-repo settings become a one-entry watchlist', () => {
  const s = migrate({
    selectedRepo: 'octocat/hello',
    selectedBranch: 'main',
    refreshInterval: 10,
    acknowledgedShas: { 'octocat/hello': 'abc123' },
    localPaths: { 'octocat/hello': 'C:/code/hello' },
    position: [10, 20]
  })

  assert.strictEqual(s.version, 2)
  assert.deepStrictEqual(s.repos, [
    { fullName: 'octocat/hello', branch: 'main', localPath: 'C:/code/hello', ackSha: 'abc123' }
  ])
  assert.strictEqual(s.refreshInterval, 10)
  assert.deepStrictEqual(s.position, [10, 20])
})

test('migrate: v1 repos known only from lookup tables are kept', () => {
  const s = migrate({
    selectedRepo: 'a/one',
    acknowledgedShas: { 'a/one': 'sha1', 'b/two': 'sha2' },
    localPaths: { 'c/three': 'C:/three' }
  })
  assert.deepStrictEqual(s.repos.map(r => r.fullName).sort(), ['a/one', 'b/two', 'c/three'])
  assert.strictEqual(s.repos.find(r => r.fullName === 'b/two').branch, null)
})

test('migrate: garbage in, defaults out', () => {
  for (const bad of [null, undefined, 42, 'nope', [], { version: 2, repos: 'not-an-array' }]) {
    const s = migrate(bad)
    assert.strictEqual(s.version, 2)
    assert.deepStrictEqual(s.repos, [])
    assert.strictEqual(s.refreshInterval, 5)
  }
})

test('migrate: malformed repo entries and duplicates are dropped', () => {
  const s = migrate({
    version: 2,
    repos: [
      { fullName: 'a/one', branch: 'main' },
      { fullName: 'a/one', branch: 'dev' },   // duplicate
      { fullName: 'no-slash' },               // not owner/name
      { branch: 'main' },                     // no name
      null
    ]
  })
  assert.deepStrictEqual(s.repos.map(r => r.fullName), ['a/one'])
  assert.strictEqual(s.repos[0].branch, 'main')
})

test('migrate: out-of-range refresh interval falls back to the default', () => {
  assert.strictEqual(migrate({ refreshInterval: 999 }).refreshInterval, 5)
  assert.strictEqual(migrate({ refreshInterval: 1 }).refreshInterval, 1)
})

test('migrate: a v2 round-trip is stable', () => {
  const original = defaults()
  original.repos.push({ fullName: 'a/one', branch: 'main', localPath: null, ackSha: 'sha' })
  assert.deepStrictEqual(migrate(JSON.parse(JSON.stringify(original))), original)
})

test('store: writes are atomic and leave no temp files behind', async () => {
  const file  = tmpFile('settings.json')
  const store = createStore(file, { debounceMs: 5 })

  store.update(s => { s.repos.push({ fullName: 'a/one', branch: 'main', localPath: null, ackSha: null }); return s },
    { immediate: true })

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).repos.length, 1)
  const strays = fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp'))
  assert.deepStrictEqual(strays, [])
})

test('store: debounced updates collapse into a single write', async () => {
  const file  = tmpFile('settings.json')
  const store = createStore(file, { debounceMs: 20 })

  for (let i = 0; i < 50; i++) store.update(s => { s.position = [i, i]; return s })
  assert.strictEqual(fs.existsSync(file), false, 'nothing written yet while debouncing')

  await new Promise(r => setTimeout(r, 60))
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).position, [49, 49])
})

test('store: flush persists pending changes immediately', () => {
  const file  = tmpFile('settings.json')
  const store = createStore(file, { debounceMs: 10_000 })
  store.update(s => { s.notifications = false; return s })
  store.flush()
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notifications, false)
})

test('store: a corrupt settings file degrades to defaults instead of throwing', () => {
  const file = tmpFile('settings.json')
  fs.writeFileSync(file, '{ "repos": [ truncated…')
  const store = createStore(file)
  assert.deepStrictEqual(store.get().repos, [])
})
