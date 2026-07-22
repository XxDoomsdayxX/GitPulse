'use strict'

const {
  app, BrowserWindow, ipcMain, Tray, Menu, Notification,
  nativeImage, safeStorage, screen, shell, dialog
} = require('electron')
const path = require('path')
const fs   = require('fs')

const { createStore, REFRESH_CHOICES } = require('./lib/settings')
const { createClient }                 = require('./lib/github')
const git                              = require('./lib/git')
const { trayIconBuffer }               = require('./lib/icon')

const W       = 200
const H_BAR   = 42
const MARGIN  = 20

let win   = null
let tray  = null
let store = null
let gh    = null
let refreshTimer = null

// Per-repo runtime status, keyed by full name. Settings owns what to watch;
// this owns what we currently know about it.
const live = new Map()

// ─── Single instance ────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) app.quit()
else app.on('second-instance', () => showWindow())

// ─── Token ──────────────────────────────────────────────────────────────────
const tokenPath = () => path.join(app.getPath('userData'), 'token.enc')

function readToken() {
  try {
    const raw = fs.readFileSync(tokenPath())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
  } catch { return null }
}

function writeToken(token) {
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, 'utf8')
  fs.writeFileSync(tokenPath(), data, { mode: 0o600 })
}

function clearToken() { try { fs.unlinkSync(tokenPath()) } catch {} }

// ─── State ──────────────────────────────────────────────────────────────────
function entryFor(repo) {
  if (!live.has(repo.fullName)) {
    live.set(repo.fullName, { status: 'idle', behindBy: null, commit: null, error: null, checkedAt: null, pulling: false })
  }
  return live.get(repo.fullName)
}

function snapshot() {
  const s = store.get()
  return {
    hasToken:        !!readToken(),
    username:        s.username,
    refreshInterval: s.refreshInterval,
    notifications:   s.notifications,
    launchAtLogin:   s.launchAtLogin,
    version:         app.getVersion(),
    repos: s.repos.map(r => ({ ...r, ...entryFor(r) }))
  }
}

function broadcast() {
  win?.webContents.send('widget:state', snapshot())
  updateTray()
}

/** Worst status across the watchlist — drives the tray icon and bar summary. */
function overallStatus() {
  const all = store.get().repos.map(r => entryFor(r).status)
  if (all.includes('behind'))  return 'behind'
  if (all.includes('error'))   return 'error'
  if (all.some(s => s === 'current')) return 'current'
  return 'idle'
}

// ─── Polling ────────────────────────────────────────────────────────────────
async function refreshRepo(fullName, { notify = true } = {}) {
  const repo = store.get().repos.find(r => r.fullName === fullName)
  if (!repo) return
  const entry = entryFor(repo)

  entry.status = entry.commit ? entry.status : 'loading'
  if (!entry.commit) broadcast()

  try {
    const branch = repo.branch || 'HEAD'
    const commit = await gh.commit(fullName, branch)
    const wasBehind = entry.status === 'behind'

    if (!repo.ackSha) {
      // First sighting: treat whatever is on the remote now as the baseline,
      // otherwise every newly added repo would open in a red "behind" state.
      store.update(s => {
        const r = s.repos.find(x => x.fullName === fullName)
        if (r) r.ackSha = commit.sha
        return s
      })
      Object.assign(entry, { status: 'current', behindBy: 0, commit, error: null, checkedAt: Date.now() })
    } else if (repo.ackSha === commit.sha) {
      Object.assign(entry, { status: 'current', behindBy: 0, commit, error: null, checkedAt: Date.now() })
    } else {
      const behindBy = await gh.aheadBy(fullName, repo.ackSha, branch)
      Object.assign(entry, { status: 'behind', behindBy, commit, error: null, checkedAt: Date.now() })
      if (notify && !wasBehind) notifyBehind(repo, behindBy, commit)
    }
  } catch (e) {
    Object.assign(entry, { status: 'error', error: e.message, checkedAt: Date.now() })
  }
  broadcast()
}

async function refreshAll(opts) {
  const names = store.get().repos.map(r => r.fullName)
  if (!names.length || !readToken()) { broadcast(); return }
  // Sequential: a watchlist is a handful of repos, and serialising keeps the
  // rate-limit footprint predictable.
  for (const n of names) await refreshRepo(n, opts)
}

function notifyBehind(repo, behindBy, commit) {
  if (!store.get().notifications || !Notification.isSupported()) return
  const count = behindBy ? `${behindBy} new commit${behindBy === 1 ? '' : 's'}` : 'New commits'
  new Notification({
    title: `${repo.fullName} · ${count}`,
    body:  commit ? `${commit.author}: ${commit.message}` : 'Remote has moved ahead',
    silent: false
  }).on('click', () => showWindow()).show()
}

function startTimer(minutes) {
  clearInterval(refreshTimer)
  const mins = REFRESH_CHOICES.includes(Number(minutes)) ? Number(minutes) : 5
  refreshTimer = setInterval(() => refreshAll(), mins * 60 * 1000)
}

// ─── Window ─────────────────────────────────────────────────────────────────
/**
 * Keeps the widget on a display that actually exists. A saved position from a
 * monitor that is now unplugged would otherwise put the window off-screen with
 * no way to drag it back.
 */
function clampPosition([x, y], height = H_BAR) {
  const display = screen.getDisplayNearestPoint({ x, y }) || screen.getPrimaryDisplay()
  const wa = display.workArea
  return [
    Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width  - W)),
    Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - height))
  ]
}

function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea
  return [wa.x + wa.width - W - MARGIN, wa.y + MARGIN]
}

function createWindow() {
  const s = store.get()
  const [x, y] = clampPosition(s.position || defaultPosition())

  win = new BrowserWindow({
    width: W, height: H_BAR, x, y,
    frame: false, alwaysOnTop: true, resizable: false,
    skipTaskbar: true, transparent: true, hasShadow: true,
    maximizable: false, fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.setIcon(nativeImage.createFromBuffer(trayIconBuffer('idle')))
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  win.on('moved', () => {
    if (!win) return
    const [wx, wy] = win.getPosition()
    store.update(s => { s.position = [wx, wy]; return s })
  })
  win.on('closed', () => { win = null })

  // Renderer is a local file with a strict CSP; nothing should ever navigate
  // or spawn a window, so refuse both outright.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())

  screen.on('display-metrics-changed', repositionInsideWorkArea)
  screen.on('display-removed',         repositionInsideWorkArea)
}

function repositionInsideWorkArea() {
  if (!win) return
  const [x, y] = win.getPosition()
  const [, h]  = win.getSize()
  const [cx, cy] = clampPosition([x, y], h)
  if (cx !== x || cy !== y) win.setPosition(cx, cy)
}

function showWindow() {
  if (!win) createWindow()
  repositionInsideWorkArea()
  win.show()
  win.focus()
}

// ─── Tray ───────────────────────────────────────────────────────────────────
function trayImage(status) {
  return nativeImage.createFromBuffer(trayIconBuffer(status), { scaleFactor: 2.0 })
}

const STATUS_TEXT = {
  behind:  e => e.behindBy ? `${e.behindBy} behind` : 'behind',
  current: () => 'up to date',
  loading: () => 'checking…',
  error:   e => e.error || 'error',
  idle:    () => 'not checked'
}

function updateTray() {
  if (!tray) return
  const repos  = store.get().repos
  const status = overallStatus()
  tray.setImage(trayImage(status))

  const behind = repos.filter(r => entryFor(r).status === 'behind').length
  tray.setToolTip(behind ? `GitPulse — ${behind} repo${behind === 1 ? '' : 's'} behind` : 'GitPulse — all up to date')

  const repoItems = repos.length
    ? repos.map(r => {
        const e = entryFor(r)
        return { label: `${r.fullName} — ${STATUS_TEXT[e.status](e)}`, click: () => showWindow() }
      })
    : [{ label: 'No repositories watched', enabled: false }]

  tray.setContextMenu(Menu.buildFromTemplate([
    ...repoItems,
    { type: 'separator' },
    { label: 'Refresh now', click: () => refreshAll() },
    { label: 'Show widget', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Quit GitPulse', click: () => app.quit() }
  ]))
}

function createTray() {
  tray = new Tray(trayImage('idle'))
  tray.on('click', () => showWindow())
  updateTray()
}

// ─── Auto-update ────────────────────────────────────────────────────────────
function initAutoUpdate() {
  if (!app.isPackaged) return
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.on('update-downloaded', () => win?.webContents.send('widget:update-ready'))
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    // A widget can run for weeks; check daily rather than only at launch.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 24 * 60 * 60 * 1000)
  } catch {}
}

// ─── IPC ────────────────────────────────────────────────────────────────────
const ok = (extra = {}) => ({ ok: true, ...extra })

ipcMain.handle('widget:get-state', () => snapshot())

ipcMain.handle('widget:save-token', async (_, token) => {
  const trimmed = String(token || '').trim()
  if (!trimmed) return { error: 'Token is empty' }
  writeToken(trimmed)
  try {
    const user = await gh.user()
    store.update(s => { s.username = user.login; return s }, { immediate: true })
    refreshAll()
    return ok({ username: user.login })
  } catch (e) {
    clearToken()
    return { error: e.message }
  }
})

ipcMain.handle('widget:clear-token', () => {
  clearToken()
  live.clear()
  store.update(s => { s.username = null; return s }, { immediate: true })
  broadcast()
  return ok()
})

ipcMain.handle('widget:list-repos', async () => {
  try { return { repos: await gh.repos() } }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('widget:list-branches', async (_, fullName) => {
  try { return { branches: await gh.branches(fullName) } }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('widget:add-repo', async (_, { fullName, branch }) => {
  const existing = store.get().repos.find(r => r.fullName === fullName)
  if (existing) return { error: 'Already watching that repository' }
  store.update(s => {
    s.repos.push({ fullName, branch: branch || null, localPath: null, ackSha: null })
    return s
  }, { immediate: true })
  broadcast()
  await refreshRepo(fullName, { notify: false })
  return ok()
})

ipcMain.handle('widget:remove-repo', (_, fullName) => {
  store.update(s => { s.repos = s.repos.filter(r => r.fullName !== fullName); return s }, { immediate: true })
  live.delete(fullName)
  broadcast()
  return ok()
})

ipcMain.handle('widget:set-branch', async (_, { fullName, branch }) => {
  store.update(s => {
    const r = s.repos.find(x => x.fullName === fullName)
    // The acknowledged SHA belongs to the old branch; keeping it would report a
    // nonsense "behind" count against the new one.
    if (r) { r.branch = branch; r.ackSha = null }
    return s
  }, { immediate: true })
  await refreshRepo(fullName, { notify: false })
  return ok()
})

ipcMain.handle('widget:refresh', async (_, fullName) => {
  if (fullName) await refreshRepo(fullName)
  else await refreshAll()
  return ok()
})

ipcMain.handle('widget:acknowledge', (_, fullName) => {
  const entry = live.get(fullName)
  if (!entry?.commit) return { error: 'Nothing to acknowledge' }
  store.update(s => {
    const r = s.repos.find(x => x.fullName === fullName)
    if (r) r.ackSha = entry.commit.sha
    return s
  }, { immediate: true })
  Object.assign(entry, { status: 'current', behindBy: 0 })
  broadcast()
  return ok()
})

ipcMain.handle('widget:pick-folder', async (_, fullName) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: `Select your local clone of ${fullName}`,
    buttonLabel: 'Use this folder'
  })
  if (result.canceled) return { canceled: true }

  const dir = result.filePaths[0]
  const verified = await git.verifyClone(dir, fullName)
  if (!verified.ok) return { error: verified.error }

  store.update(s => {
    const r = s.repos.find(x => x.fullName === fullName)
    if (r) r.localPath = dir
    return s
  }, { immediate: true })
  broadcast()
  return ok({ localPath: dir })
})

ipcMain.handle('widget:pull', async (_, fullName) => {
  const repo = store.get().repos.find(r => r.fullName === fullName)
  if (!repo) return { error: 'Not watching that repository' }
  if (!repo.localPath) return { error: 'No local folder set', needsFolder: true }

  const entry = entryFor(repo)
  entry.pulling = true
  broadcast()

  const result = await git.pull(repo.localPath, fullName)
  entry.pulling = false

  if (!result.ok) {
    entry.error = result.error
    broadcast()
    return { error: result.error }
  }

  // Acknowledge the SHA that actually landed, not the one from the last poll.
  if (result.sha) {
    store.update(s => {
      const r = s.repos.find(x => x.fullName === fullName)
      if (r) r.ackSha = result.sha
      return s
    }, { immediate: true })
  }
  entry.error = null
  await refreshRepo(fullName, { notify: false })
  return ok({ output: result.output })
})

ipcMain.handle('widget:set-refresh', (_, minutes) => {
  store.update(s => { s.refreshInterval = Number(minutes); return s }, { immediate: true })
  startTimer(minutes)
  broadcast()
  return ok()
})

ipcMain.handle('widget:set-notifications', (_, enabled) => {
  store.update(s => { s.notifications = !!enabled; return s }, { immediate: true })
  broadcast()
  return ok()
})

ipcMain.handle('widget:set-launch-at-login', (_, enabled) => {
  store.update(s => { s.launchAtLogin = !!enabled; return s }, { immediate: true })
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] })
  broadcast()
  return ok()
})

ipcMain.handle('widget:set-height', (_, h) => {
  if (!win) return { ok: false }
  const wa  = screen.getDisplayNearestPoint({ x: win.getPosition()[0], y: win.getPosition()[1] }).workArea
  const max = Math.max(H_BAR, wa.height - 2 * MARGIN)
  const height = Math.max(H_BAR, Math.min(Math.round(h), max))

  // Windows pins the min/max size to the current size while `resizable: false`,
  // so setSize() can grow the window but never shrink it back — leaving an
  // invisible, click-blocking region below the collapsed bar. Toggle resizable
  // around the call so the size constraints follow the new height.
  win.setResizable(true)
  win.setSize(W, height)
  win.setResizable(false)
  repositionInsideWorkArea()
  return ok({ height })
})

ipcMain.handle('widget:open-external', (_, url) => {
  // Only ever hand GitHub URLs to the OS browser.
  if (!/^https:\/\/([a-z0-9-]+\.)?github\.com\//i.test(String(url))) return { error: 'Blocked' }
  shell.openExternal(url)
  return ok()
})

ipcMain.handle('widget:hide', () => { win?.hide(); return ok() })
ipcMain.handle('widget:quit', () => { app.quit(); return ok() })

// ─── Lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide()
  if (process.platform === 'win32')  app.setAppUserModelId('com.gitpulse.widget')

  store = createStore(path.join(app.getPath('userData'), 'settings.json'))
  gh    = createClient({ getToken: readToken })

  // Keep the OS login-item in sync with the stored preference in case it was
  // changed outside the app (or the app was reinstalled).
  app.setLoginItemSettings({ openAtLogin: store.get().launchAtLogin, args: ['--hidden'] })

  createWindow()
  createTray()
  startTimer(store.get().refreshInterval)
  initAutoUpdate()

  win.webContents.once('did-finish-load', () => {
    broadcast()
    if (process.argv.includes('--hidden')) win.hide()
    refreshAll({ notify: false })
  })

  // Coming back from sleep, the poll timer may have missed hours of commits.
  require('electron').powerMonitor.on('resume', () => refreshAll())
})

app.on('window-all-closed', e => e.preventDefault?.())
app.on('before-quit', () => {
  clearInterval(refreshTimer)
  store?.flush()
})
