'use strict'

/**
 * End-to-end smoke test. Loads the real main process in Electron against a
 * throwaway userData dir and drives the real renderer, asserting the things
 * that only break once everything is wired together — window sizing above all,
 * since a window taller than its content silently blocks desktop clicks.
 *
 * Run with:  npm run test:app
 */

const { app, BrowserWindow } = require('electron')
const path = require('path')
const os   = require('os')
const fs   = require('fs')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpulse-smoke-'))
app.setPath('userData', userData)

require('../main.js')

const wait = ms => new Promise(r => setTimeout(r, ms))
const failures = []
const consoleErrors = []

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else { console.log(`  FAIL ${name} ${detail}`); failures.push(name) }
}

async function settle(win, ms = 400) {
  await wait(ms)
  return win.getSize()[1]
}

app.whenReady().then(async () => {
  await wait(1200)
  const win = BrowserWindow.getAllWindows()[0]
  check('window exists', !!win)
  if (!win) return finish()

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })

  const js = code => win.webContents.executeJavaScript(code, true)

  // The renderer opens settings automatically when no token is stored.
  const openedHeight = await settle(win, 600)
  check('starts taller than the bar when disconnected (settings auto-open)', openedHeight > 42, `height=${openedHeight}`)

  // Collapse: Escape closes settings, then the panel. The collapsed window must
  // be exactly the bar (42px) plus the widget's 1px top/bottom border — any
  // extra is an invisible region that eats desktop clicks.
  const BAR_HEIGHT = 44
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await wait(200)
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  const collapsed = await settle(win)
  check('collapses to the bar with no invisible click-blocking region', collapsed === BAR_HEIGHT, `height=${collapsed}`)

  // Expand again by clicking the bar.
  await js(`document.getElementById('barLeft').click()`)
  const expanded = await settle(win)
  check('expands when the bar is clicked', expanded > 42, `height=${expanded}`)

  // Window height must track content height exactly.
  const contentHeight = await js(`Math.ceil(document.getElementById('widget').getBoundingClientRect().height)`)
  check('window height matches rendered content', Math.abs(contentHeight - expanded) <= 1, `content=${contentHeight} window=${expanded}`)

  // Collapse once more via the bar.
  await js(`document.getElementById('barLeft').click()`)
  const recollapsed = await settle(win)
  check('collapses again after re-expanding', recollapsed === BAR_HEIGHT, `height=${recollapsed}`)

  // State snapshot shape.
  const state = await js(`window.widget.getState()`)
  check('state exposes v2 watchlist shape', Array.isArray(state.repos) && 'hasToken' in state && 'version' in state,
    JSON.stringify(state).slice(0, 120))
  check('starts disconnected with an empty watchlist', state.hasToken === false && state.repos.length === 0)

  // Settings must be persisted atomically to the temp userData dir.
  await js(`window.widget.setRefresh(10)`)
  await wait(200)
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
  check('settings persist to disk in v2 format', saved.version === 2 && saved.refreshInterval === 10, JSON.stringify(saved))

  // Renderer security posture.
  const prefs = win.webContents.getLastWebPreferences()
  check('renderer is sandboxed with context isolation', prefs.sandbox === true && prefs.contextIsolation === true)
  check('node integration is off', prefs.nodeIntegration !== true)

  // External links: only GitHub is allowed through.
  const blocked = await js(`window.widget.openExternal('https://evil.example.com/pwn')`)
  check('non-GitHub external links are blocked', blocked && blocked.error === 'Blocked', JSON.stringify(blocked))

  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200))

  finish()
})

function finish() {
  console.log(failures.length ? `\n${failures.length} check(s) failed\n` : '\nAll smoke checks passed\n')
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  app.exit(failures.length ? 1 : 0)
}

setTimeout(() => { console.log('smoke test timed out'); app.exit(1) }, 60_000)
