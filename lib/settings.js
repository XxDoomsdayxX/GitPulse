'use strict'

const fs   = require('fs')
const path = require('path')

const SCHEMA_VERSION = 2

const REFRESH_CHOICES = [1, 5, 10, 30]

function defaults() {
  return {
    version:         SCHEMA_VERSION,
    repos:           [],     // { fullName, branch, localPath, ackSha }
    refreshInterval: 5,
    position:        null,
    username:        null,
    notifications:   true,
    launchAtLogin:   false
  }
}

function normalizeRepo(r) {
  if (!r || typeof r.fullName !== 'string' || !r.fullName.includes('/')) return null
  return {
    fullName:  r.fullName,
    branch:    typeof r.branch === 'string' && r.branch ? r.branch : null,
    localPath: typeof r.localPath === 'string' && r.localPath ? r.localPath : null,
    ackSha:    typeof r.ackSha === 'string' && r.ackSha ? r.ackSha : null
  }
}

/**
 * Accepts anything previously written to settings.json — v1 (single-repo) or
 * v2 (watchlist) — and returns a valid, fully-populated v2 object. Unknown or
 * malformed fields fall back to defaults rather than throwing, so a corrupt
 * file degrades to "fresh install" instead of a broken widget.
 */
function migrate(raw) {
  const s = defaults()
  if (!raw || typeof raw !== 'object') return s

  if (Number(raw.version) === SCHEMA_VERSION && Array.isArray(raw.repos)) {
    s.repos = raw.repos.map(normalizeRepo).filter(Boolean)
  } else {
    // v1: one selected repo, with sha/path lookup tables keyed by full name.
    const acked = (raw.acknowledgedShas && typeof raw.acknowledgedShas === 'object') ? raw.acknowledgedShas : {}
    const paths = (raw.localPaths       && typeof raw.localPaths       === 'object') ? raw.localPaths       : {}
    const names = new Set([
      ...(typeof raw.selectedRepo === 'string' ? [raw.selectedRepo] : []),
      ...Object.keys(acked),
      ...Object.keys(paths)
    ].filter(n => typeof n === 'string' && n.includes('/')))

    s.repos = [...names].map(fullName => normalizeRepo({
      fullName,
      branch:    fullName === raw.selectedRepo ? raw.selectedBranch : null,
      localPath: paths[fullName],
      ackSha:    acked[fullName]
    })).filter(Boolean)
  }

  // De-dupe by full name, keeping the first occurrence.
  const seen = new Set()
  s.repos = s.repos.filter(r => !seen.has(r.fullName) && seen.add(r.fullName))

  if (REFRESH_CHOICES.includes(Number(raw.refreshInterval))) s.refreshInterval = Number(raw.refreshInterval)
  if (Array.isArray(raw.position) && raw.position.length === 2 && raw.position.every(Number.isFinite)) {
    s.position = [raw.position[0], raw.position[1]]
  }
  if (typeof raw.username      === 'string')  s.username      = raw.username
  if (typeof raw.notifications === 'boolean') s.notifications = raw.notifications
  if (typeof raw.launchAtLogin === 'boolean') s.launchAtLogin = raw.launchAtLogin

  return s
}

/**
 * Settings store with debounced, atomic writes.
 *
 * Atomic: written to a temp file and renamed, so a crash mid-write can never
 * leave a half-serialized settings.json (which would silently reset the user's
 * entire watchlist on next launch).
 *
 * Debounced: window drags emit a 'moved' event per mouse tick; without this
 * every drag would issue hundreds of synchronous disk writes.
 */
function createStore(filePath, { debounceMs = 400 } = {}) {
  let data  = null
  let timer = null

  const load = () => {
    if (data) return data
    try { data = migrate(JSON.parse(fs.readFileSync(filePath, 'utf8'))) }
    catch { data = defaults() }
    return data
  }

  const writeNow = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!data) return
    const tmp = `${filePath}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
    } catch {
      try { fs.unlinkSync(tmp) } catch {}
    }
  }

  return {
    get: () => load(),

    /** Mutate settings via `fn`, then persist (debounced unless immediate). */
    update(fn, { immediate = false } = {}) {
      const next = fn(load())
      if (next && typeof next === 'object') data = next
      if (immediate) writeNow()
      else if (!timer) timer = setTimeout(writeNow, debounceMs)
      return data
    },

    flush: writeNow
  }
}

module.exports = { SCHEMA_VERSION, REFRESH_CHOICES, defaults, migrate, normalizeRepo, createStore }
