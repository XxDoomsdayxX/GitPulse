const {
  app, BrowserWindow, ipcMain, Tray, Menu,
  nativeImage, safeStorage, screen, shell, dialog
} = require('electron')
const path  = require('path')
const fs    = require('fs')
const https = require('https')
const { exec } = require('child_process')
const { deflateSync } = require('zlib')

const W              = 200
const H_BAR          = 42
const H_EXPANDED     = 280
const H_WITH_SETTINGS = 450

let win          = null
let tray         = null
let refreshTimer = null

// ─── Single instance ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit() }
else { app.on('second-instance', () => win?.show()) }

// ─── Paths ─────────────────────────────────────────────────────────────────
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
const tokenPath    = () => path.join(app.getPath('userData'), 'token.enc')

// ─── Settings ──────────────────────────────────────────────────────────────
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }
  catch { return { selectedRepo: null, selectedBranch: null, refreshInterval: 5, acknowledgedShas: {}, position: null } }
}

function writeSettings(s) {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
}

// ─── Token ─────────────────────────────────────────────────────────────────
function readToken() {
  try {
    const raw = fs.readFileSync(tokenPath())
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
  } catch { return null }
}

function writeToken(token) {
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, 'utf8')
  fs.writeFileSync(tokenPath(), data)
}

function clearToken() {
  try { fs.unlinkSync(tokenPath()) } catch {}
}

// ─── GitHub API ─────────────────────────────────────────────────────────────
function ghRequest(endpoint, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'GitPulse-Widget/1.0',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          if (res.statusCode >= 400) reject(new Error(json.message || `HTTP ${res.statusCode}`))
          else resolve(json)
        } catch { reject(new Error('Invalid response from GitHub')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(12000, () => req.destroy(new Error('Request timed out')))
    req.end()
  })
}

async function listRepos(token) {
  const repos = []
  let page = 1
  while (true) {
    const batch = await ghRequest(
      `/user/repos?sort=pushed&per_page=100&page=${page}&affiliation=owner,collaborator`,
      token
    )
    if (!Array.isArray(batch) || !batch.length) break
    for (const r of batch) {
      repos.push({ name: r.name, full_name: r.full_name, default_branch: r.default_branch, private: r.private })
    }
    if (batch.length < 100 || ++page > 10) break
  }
  return repos
}

async function getLatestCommit(fullName, branch, token) {
  const data = await ghRequest(`/repos/${fullName}/commits/${branch}`, token)
  return {
    sha:      data.sha,
    shortSha: data.sha.slice(0, 7),
    message:  data.commit.message.split('\n')[0].slice(0, 80),
    author:   (data.commit.author?.name || data.commit.committer?.name || 'Unknown').slice(0, 28),
    date:     data.commit.author?.date || data.commit.committer?.date
  }
}

// ─── PNG icon generator (no external deps) ─────────────────────────────────
function buildPng(width, height, pixels) {
  const tbl = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    tbl[n] = c
  }
  const crc = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = tbl[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
  const chunk = (type, data) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([l, t, data, cr])
  }
  const rows = []
  for (let y = 0; y < height; y++) {
    rows.push(0)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      rows.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3])
    }
  }
  const hdr = Buffer.alloc(13)
  hdr.writeUInt32BE(width, 0); hdr.writeUInt32BE(height, 4)
  hdr[8] = 8; hdr[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', hdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ─── Tray ──────────────────────────────────────────────────────────────────
function makeTrayIcon(status) {
  const [sr, sg, sb] = status === 'current' ? [34, 197, 94]
                      : status === 'behind'  ? [239, 68, 68]
                      :                       [148, 163, 184]
  const S = 32, rad = 6
  const px = new Uint8Array(S * S * 4)

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= S || y < 0 || y >= S) return
    const i = (y * S + x) * 4; px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = a
  }

  // Dark rounded-rect background
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let inside = true
      if      (x < rad    && y < rad)    inside = (x-rad)**2       + (y-rad)**2       < rad*rad
      else if (x >= S-rad && y < rad)    inside = (x-(S-rad-1))**2 + (y-rad)**2       < rad*rad
      else if (x < rad    && y >= S-rad) inside = (x-rad)**2       + (y-(S-rad-1))**2 < rad*rad
      else if (x >= S-rad && y >= S-rad) inside = (x-(S-rad-1))**2 + (y-(S-rad-1))**2 < rad*rad
      if (inside) set(x, y, 15, 23, 42)
      else        set(x, y, 0, 0, 0, 0)
    }
  }

  // Git-branch icon — nodes + lines in status color
  const dot = (cx, cy, r) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (dx*dx + dy*dy <= r*r) set(cx+dx, cy+dy, sr, sg, sb)
  }
  const line = (x1, y1, x2, y2) => {
    const dx = x2-x1, dy = y2-y1
    const steps = Math.max(Math.abs(dx), Math.abs(dy))
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x1 + dx*i/steps)
      const y = Math.round(y1 + dy*i/steps)
      set(x, y, sr, sg, sb); set(x+1, y, sr, sg, sb)
    }
  }

  // Nodes:  A=top-left (10,9)  B=bottom-left (10,23)  C=top-right (22,9)
  line(10, 13, 10, 20)   // trunk  A→B
  line(10, 18, 22, 10)   // branch A→C
  dot(10,  9, 3)         // node A
  dot(10, 23, 3)         // node B
  dot(22,  9, 3)         // node C

  return nativeImage.createFromBuffer(buildPng(S, S, px), { scaleFactor: 2.0 })
}

function setTrayStatus(status) {
  tray?.setImage(makeTrayIcon(status))
}

// ─── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  const s = readSettings()
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const [x, y] = s.position || [sw - W - 20, 20]

  win = new BrowserWindow({
    width: W, height: H_BAR, x, y,
    frame: false, alwaysOnTop: true, resizable: false,
    skipTaskbar: true, transparent: true, hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })

  win.setIcon(makeTrayIcon('idle'))
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  win.on('moved', () => {
    const [wx, wy] = win.getPosition()
    const cfg = readSettings(); cfg.position = [wx, wy]; writeSettings(cfg)
  })
  win.on('closed', () => { win = null })
}

function createTray() {
  tray = new Tray(makeTrayIcon('idle'))
  tray.setToolTip('GitPulse')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show',            click: () => win?.show() },
    { type: 'separator' },
    { label: 'Quit GitPulse',   click: () => app.quit() }
  ]))
  tray.on('click', () => win?.show())
}

function startTimer(minutes = 5) {
  clearInterval(refreshTimer)
  refreshTimer = setInterval(() => win?.webContents.send('widget:tick'), minutes * 60 * 1000)
}

// ─── IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('widget:get-settings', () => {
  const s = readSettings()
  return { ...s, hasToken: !!readToken() }
})

ipcMain.handle('widget:save-token', (_, token) => { writeToken(token.trim()); return { ok: true } })
ipcMain.handle('widget:clear-token', () => { clearToken(); return { ok: true } })

ipcMain.handle('widget:get-user', async () => {
  const token = readToken()
  if (!token) return { error: 'No token' }
  try {
    const data = await ghRequest('/user', token)
    const s = readSettings()
    s.username = data.login
    writeSettings(s)
    return { login: data.login, name: data.name || data.login }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('widget:fetch-repos', async () => {
  const token = readToken()
  if (!token) return { error: 'No token configured' }
  try { return { repos: await listRepos(token) } }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('widget:fetch-status', async (_, { fullName, branch }) => {
  const token = readToken()
  if (!token) return { error: 'No token configured' }
  try {
    const commit = await getLatestCommit(fullName, branch, token)
    const s      = readSettings()
    const acked  = s.acknowledgedShas?.[fullName]
    if (!acked) {
      if (!s.acknowledgedShas) s.acknowledgedShas = {}
      s.acknowledgedShas[fullName] = commit.sha
      writeSettings(s)
      setTrayStatus('current')
      return { commit, behind: false }
    }
    const behind = acked !== commit.sha
    setTrayStatus(behind ? 'behind' : 'current')
    return { commit, behind }
  } catch (e) {
    setTrayStatus('idle')
    return { error: e.message }
  }
})

ipcMain.handle('widget:acknowledge', (_, { fullName, sha }) => {
  const s = readSettings()
  if (!s.acknowledgedShas) s.acknowledgedShas = {}
  s.acknowledgedShas[fullName] = sha
  writeSettings(s)
  setTrayStatus('current')
  return { ok: true }
})

ipcMain.handle('widget:select-repo', (_, repo) => {
  const s = readSettings()
  s.selectedRepo   = repo.full_name
  s.selectedBranch = repo.default_branch
  writeSettings(s)
  return { ok: true }
})

ipcMain.handle('widget:set-refresh', (_, minutes) => {
  const s = readSettings(); s.refreshInterval = minutes; writeSettings(s)
  startTimer(minutes); return { ok: true }
})

ipcMain.handle('widget:set-height', (_, h) => {
  if (!win) return { ok: false }
  // Windows pins the min/max size to the current size while `resizable: false`,
  // so setSize() can grow the window but never shrink it back — leaving an
  // invisible, click-blocking region below the collapsed bar. Toggle resizable
  // around the call so the constraints follow the new height.
  win.setResizable(true)
  win.setSize(W, Math.round(h))
  win.setResizable(false)
  return { ok: true }
})

ipcMain.handle('widget:open-external', (_, url) => shell.openExternal(url))

ipcMain.handle('widget:pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select local repository folder',
    buttonLabel: 'Use this folder'
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('widget:get-local-path', (_, fullName) => {
  const s = readSettings()
  return s.localPaths?.[fullName] ?? null
})

ipcMain.handle('widget:set-local-path', (_, { fullName, localPath }) => {
  const s = readSettings()
  if (!s.localPaths) s.localPaths = {}
  s.localPaths[fullName] = localPath
  writeSettings(s)
  return { ok: true }
})

ipcMain.handle('widget:run-pull', (_, { localPath }) => {
  return new Promise(resolve => {
    const safePath = localPath.replace(/\\/g, '/')
    exec(`git -c safe.directory="${safePath}" pull`, { cwd: localPath, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) resolve({ error: (stderr || err.message).trim().slice(0, 120) })
      else     resolve({ ok: true, output: stdout.trim().slice(0, 120) })
    })
  })
})

ipcMain.handle('widget:hide', () => win?.hide())
ipcMain.handle('widget:quit', () => app.quit())

// ─── Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide()
  if (process.platform === 'win32') app.setAppUserModelId('com.gitpulse.widget')

  createWindow()
  createTray()
  startTimer(readSettings().refreshInterval || 5)
})

app.on('window-all-closed', e => e.preventDefault())
app.on('before-quit', () => clearInterval(refreshTimer))
