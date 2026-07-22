'use strict'

const w = window.widget

// Main process owns repo state; this mirrors the last snapshot it sent.
let state = {
  hasToken: false, username: null, refreshInterval: 5,
  notifications: true, launchAtLogin: false, version: '', repos: []
}

// Purely local UI state — never round-trips through main.
const ui = {
  panelOpen:    false,
  settingsOpen: false,
  addOpen:      false,
  expanded:     null,   // fullName of the row showing details
  repoOptions:  [],     // repos available to add
  search:       '',
  branches:     new Map(),
  busy:         new Set()
}

const el = id => document.getElementById(id)

const widgetEl   = el('widget')
const barLeft    = el('barLeft')
const barDot     = el('barDot')
const barLabel   = el('barLabel')
const closeBtn   = el('closeBtn')
const panel      = el('panel')
const repoList   = el('repoList')
const addBtn     = el('addBtn')
const refreshBtn = el('refreshBtn')
const settingsBtn = el('settingsBtn')
const addPanel   = el('addPanel')
const repoSearch = el('repoSearch')
const repoOptions = el('repoOptions')
const settingsPanel = el('settingsPanel')
const tokenForm  = el('tokenForm')
const tokenConnected = el('tokenConnected')
const connectedUsername = el('connectedUsername')
const tokenInput = el('tokenInput')
const connectBtn = el('connectBtn')
const disconnectBtn = el('disconnectBtn')
const refreshSelect = el('refreshSelect')
const notifyToggle = el('notifyToggle')
const loginToggle  = el('loginToggle')
const tokenDocsBtn = el('tokenDocsBtn')
const quitBtn      = el('quitBtn')
const versionLabel = el('versionLabel')
const toast        = el('toast')

// ─── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function reltime(value) {
  if (!value) return ''
  const s = Math.floor((Date.now() - new Date(value)) / 1000)
  if (s < 60)    return 'just now'
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const shortName = fullName => fullName.split('/')[1] || fullName

const DOT = { current: 'green', behind: 'red', error: 'amber', loading: 'loading', idle: 'idle' }

function statusText(repo) {
  if (repo.pulling) return 'pulling…'
  switch (repo.status) {
    case 'behind':  return repo.behindBy ? `${repo.behindBy} behind` : 'behind'
    case 'current': return 'up to date'
    case 'loading': return 'checking…'
    case 'error':   return repo.error || 'error'
    default:        return 'not checked'
  }
}

let toastTimer = null
function showToast(message, kind = 'info') {
  toast.textContent = message
  toast.className = `toast ${kind}`
  toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.hidden = true; syncHeight() }, 4000)
  syncHeight()
}

// ─── Window height ──────────────────────────────────────────────────────────
// The window is sized from the rendered content, so no layout change can leave
// an invisible click-blocking region (or clip the panel) the way hardcoded
// height constants did.
let lastHeight = 0
function syncHeight() {
  const h = Math.ceil(widgetEl.getBoundingClientRect().height)
  if (h && h !== lastHeight) { lastHeight = h; w.setHeight(h) }
}
new ResizeObserver(syncHeight).observe(widgetEl)

// ─── Bar ────────────────────────────────────────────────────────────────────
function renderBar() {
  const repos  = state.repos
  const behind = repos.filter(r => r.status === 'behind')
  const errors = repos.filter(r => r.status === 'error')
  const busy   = repos.some(r => r.status === 'loading' || r.pulling)

  let dot = 'idle', label = 'GitPulse'

  if (!state.hasToken)      { dot = 'idle';  label = 'Connect GitHub' }
  else if (!repos.length)   { dot = 'idle';  label = 'No repos watched' }
  else if (behind.length)   { dot = 'red';   label = behind.length === 1 ? `${shortName(behind[0].fullName)} behind` : `${behind.length} repos behind` }
  else if (busy)            { dot = 'loading'; label = 'Checking…' }
  else if (errors.length)   { dot = 'amber'; label = errors.length === repos.length ? 'Check failed' : `${errors.length} failing` }
  else                      { dot = 'green'; label = repos.length === 1 ? `${shortName(repos[0].fullName)} up to date` : `${repos.length} repos up to date` }

  barDot.className = `status-dot ${dot}`
  barDot.setAttribute('aria-label', label)
  barLabel.textContent = label
  barLabel.classList.toggle('has-repo', dot !== 'idle')
}

// ─── Repo list ──────────────────────────────────────────────────────────────
function renderList() {
  if (!state.hasToken) {
    repoList.innerHTML = `<div class="list-empty">Connect a GitHub token in settings to start watching repositories.</div>`
    return
  }
  if (!state.repos.length) {
    repoList.innerHTML = `<div class="list-empty">No repositories watched yet — add one below.</div>`
    return
  }

  repoList.innerHTML = state.repos.map(r => {
    const open = ui.expanded === r.fullName
    const dot  = r.pulling ? 'loading' : (DOT[r.status] || 'idle')
    return `
      <div class="repo-item${open ? ' is-open' : ''}" role="listitem">
        <button class="repo-row" data-repo="${esc(r.fullName)}" aria-expanded="${open}">
          <span class="status-dot ${dot}" role="img" aria-label="${esc(statusText(r))}"></span>
          <span class="repo-name">${esc(shortName(r.fullName))}</span>
          <span class="repo-status ${dot}">${esc(statusText(r))}</span>
        </button>
        ${open ? renderDetail(r) : ''}
      </div>`
  }).join('')

  repoList.querySelectorAll('.repo-row').forEach(btn => {
    btn.addEventListener('click', () => {
      ui.expanded = ui.expanded === btn.dataset.repo ? null : btn.dataset.repo
      renderList()
    })
  })
  wireDetail()
}

function renderDetail(r) {
  const c = r.commit
  const branches = ui.branches.get(r.fullName)
  const busy = ui.busy.has(r.fullName) || r.pulling

  const commitBlock = r.status === 'error' && !c
    ? `<div class="detail-error">${esc(r.error || 'Check failed')}</div>`
    : c
      ? `<div class="detail-meta">
           <span class="commit-author">${esc(c.author)}</span>
           <span class="meta-dot">·</span>
           <span class="commit-sha">${esc(c.shortSha)}</span>
           <span class="meta-dot">·</span>
           <span class="commit-date">${esc(reltime(c.date))}</span>
         </div>
         <div class="detail-message" title="${esc(c.message)}">${esc(c.message)}</div>`
      : `<div class="detail-meta"><span class="commit-date">Not checked yet</span></div>`

  const branchSelect = branches
    ? `<select class="select-input branch-select" data-repo="${esc(r.fullName)}" aria-label="Branch">
         ${branches.map(b => `<option value="${esc(b)}"${b === r.branch ? ' selected' : ''}>${esc(b)}</option>`).join('')}
       </select>`
    : `<button class="branch-btn" data-branch-load="${esc(r.fullName)}">${esc(r.branch || 'default branch')} ▾</button>`

  const pullLabel = r.pulling ? 'Pulling…'
    : r.status === 'behind' ? 'Pull'
    : r.localPath ? 'Up to date' : 'Set folder'

  return `
    <div class="repo-detail">
      ${commitBlock}
      <div class="detail-row">${branchSelect}</div>
      <div class="detail-actions">
        <button class="btn-pull${r.status === 'behind' ? '' : ' is-current'}" data-pull="${esc(r.fullName)}"
                ${busy || (r.status !== 'behind' && r.localPath) ? 'disabled' : ''}>${esc(pullLabel)}</button>
        ${r.status === 'behind' ? `<button class="btn-ghost" data-ack="${esc(r.fullName)}" title="Mark as seen without pulling">Seen</button>` : ''}
        <button class="icon-btn detail-icon" data-open="${esc(r.fullName)}" aria-label="Open on GitHub" title="Open on GitHub">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.49-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.28.83 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </button>
        <button class="icon-btn detail-icon danger" data-remove="${esc(r.fullName)}" aria-label="Stop watching" title="Stop watching">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6.5 1a.5.5 0 0 0-.5.5V2H3.5a.5.5 0 0 0 0 1H4v9.5A1.5 1.5 0 0 0 5.5 14h5a1.5 1.5 0 0 0 1.5-1.5V3h.5a.5.5 0 0 0 0-1H10v-.5a.5.5 0 0 0-.5-.5h-3zM5 3h6v9.5a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5V3z"/>
          </svg>
        </button>
      </div>
      ${r.localPath ? `<div class="detail-path" title="${esc(r.localPath)}">${esc(r.localPath)}</div>` : ''}
    </div>`
}

function wireDetail() {
  repoList.querySelectorAll('[data-pull]').forEach(b => b.addEventListener('click', () => doPull(b.dataset.pull)))
  repoList.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', () => w.acknowledge(b.dataset.ack)))
  repoList.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', async () => {
    ui.expanded = null
    await w.removeRepo(b.dataset.remove)
  }))
  repoList.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
    w.openExternal(`https://github.com/${b.dataset.open}`)
  }))
  repoList.querySelectorAll('[data-branch-load]').forEach(b => b.addEventListener('click', async () => {
    const fullName = b.dataset.branchLoad
    b.textContent = 'loading…'
    const res = await w.listBranches(fullName)
    if (res.error) { showToast(res.error, 'error'); return }
    ui.branches.set(fullName, res.branches)
    renderList()
  }))
  repoList.querySelectorAll('.branch-select').forEach(sel => sel.addEventListener('change', async () => {
    await w.setBranch({ fullName: sel.dataset.repo, branch: sel.value })
  }))
}

async function doPull(fullName) {
  const repo = state.repos.find(r => r.fullName === fullName)
  if (!repo) return

  if (!repo.localPath) {
    const picked = await w.pickFolder(fullName)
    if (picked.canceled) return
    if (picked.error) { showToast(picked.error, 'error'); return }
    showToast('Local folder linked', 'ok')
    if (repo.status !== 'behind') return
  }

  ui.busy.add(fullName)
  const res = await w.pull(fullName)
  ui.busy.delete(fullName)

  if (res.error) showToast(res.error, 'error')
  else showToast(res.output || 'Pulled', 'ok')
}

// ─── Add repository ─────────────────────────────────────────────────────────
function renderOptions() {
  const watched = new Set(state.repos.map(r => r.fullName))
  const q = ui.search.trim().toLowerCase()
  const matches = ui.repoOptions
    .filter(r => !watched.has(r.fullName))
    .filter(r => !q || r.fullName.toLowerCase().includes(q))
    .slice(0, 50)

  if (!ui.repoOptions.length) {
    repoOptions.innerHTML = `<div class="option-empty">Loading repositories…</div>`
    return
  }
  if (!matches.length) {
    repoOptions.innerHTML = `<div class="option-empty">${q ? 'No matches' : 'All your repositories are watched'}</div>`
    return
  }

  repoOptions.innerHTML = matches.map(r => `
    <button class="option" role="option" data-add="${esc(r.fullName)}" data-branch="${esc(r.defaultBranch)}">
      ${r.private ? '<span class="repo-lock" aria-label="Private">&#x1F512;</span>' : ''}
      <span class="option-name">${esc(r.fullName)}</span>
    </button>`).join('')

  repoOptions.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true
    const res = await w.addRepo({ fullName: b.dataset.add, branch: b.dataset.branch })
    if (res.error) { showToast(res.error, 'error'); b.disabled = false; return }
    closeAdd()
  }))
}

async function openAdd() {
  if (!state.hasToken) { openSettings(); return }
  ui.addOpen = true
  ui.settingsOpen = false
  settingsPanel.hidden = true
  addPanel.hidden = false
  addBtn.classList.add('is-active')
  renderOptions()
  repoSearch.focus()

  if (!ui.repoOptions.length) {
    const res = await w.listRepos()
    if (res.error) { showToast(res.error, 'error'); return }
    ui.repoOptions = res.repos
    renderOptions()
  }
}

function closeAdd() {
  ui.addOpen = false
  ui.search  = ''
  repoSearch.value = ''
  addPanel.hidden = true
  addBtn.classList.remove('is-active')
}

// ─── Panel / settings ───────────────────────────────────────────────────────
function openPanel() {
  ui.panelOpen = true
  panel.hidden = false
  barLeft.setAttribute('aria-expanded', 'true')
}

function closePanel() {
  ui.panelOpen = false
  closeAdd()
  closeSettings()
  ui.expanded = null
  panel.hidden = true
  barLeft.setAttribute('aria-expanded', 'false')
  renderList()
}

function togglePanel() { ui.panelOpen ? closePanel() : openPanel() }

function openSettings() {
  if (!ui.panelOpen) openPanel()
  ui.settingsOpen = true
  closeAdd()
  settingsPanel.hidden = false
  settingsBtn.classList.add('is-active')
}

function closeSettings() {
  ui.settingsOpen = false
  settingsPanel.hidden = true
  settingsBtn.classList.remove('is-active')
}

function toggleSettings() { ui.settingsOpen ? closeSettings() : openSettings() }

// ─── State sync ─────────────────────────────────────────────────────────────
function render() {
  renderBar()
  if (ui.panelOpen) renderList()
  if (ui.addOpen)   renderOptions()

  tokenForm.hidden      = state.hasToken
  tokenConnected.hidden = !state.hasToken
  connectedUsername.textContent = state.username || 'Connected'

  const opt = refreshSelect.querySelector(`option[value="${state.refreshInterval}"]`)
  if (opt) opt.selected = true
  notifyToggle.checked = state.notifications
  loginToggle.checked  = state.launchAtLogin
  versionLabel.textContent = `GitPulse ${state.version}`

  syncHeight()
}

w.onState(next => { state = next; render() })
w.onUpdateReady(() => showToast('Update ready — restart to apply', 'ok'))

// ─── Events ─────────────────────────────────────────────────────────────────
barLeft.addEventListener('click', togglePanel)
barLeft.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel() }
})
closeBtn.addEventListener('click', e => { e.stopPropagation(); w.hide() })

addBtn.addEventListener('click', () => ui.addOpen ? closeAdd() : openAdd())
settingsBtn.addEventListener('click', toggleSettings)
refreshBtn.addEventListener('click', () => {
  refreshBtn.classList.add('spinning')
  setTimeout(() => refreshBtn.classList.remove('spinning'), 700)
  w.refresh()
})

repoSearch.addEventListener('input', () => { ui.search = repoSearch.value; renderOptions() })

connectBtn.addEventListener('click', connect)
tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect() })

async function connect() {
  const token = tokenInput.value.trim()
  if (!token) { tokenInput.focus(); return }
  connectBtn.disabled = true
  connectBtn.textContent = 'Connecting…'
  const res = await w.saveToken(token)
  connectBtn.disabled = false
  connectBtn.textContent = 'Connect'
  if (res.error) { showToast(res.error, 'error'); return }
  tokenInput.value = ''
  showToast(`Connected as ${res.username}`, 'ok')
  openAdd()
}

disconnectBtn.addEventListener('click', async () => {
  await w.clearToken()
  ui.repoOptions = []
  ui.branches.clear()
})

refreshSelect.addEventListener('change', e => w.setRefresh(parseInt(e.target.value, 10)))
notifyToggle.addEventListener('change', e => w.setNotifications(e.target.checked))
loginToggle.addEventListener('change', e => w.setLaunchAtLogin(e.target.checked))
tokenDocsBtn.addEventListener('click', () => w.openExternal('https://github.com/settings/personal-access-tokens/new'))
quitBtn.addEventListener('click', () => w.quit())

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (ui.addOpen)      { closeAdd(); return }
  if (ui.settingsOpen) { closeSettings(); return }
  if (ui.panelOpen)    closePanel()
})

// ─── Init ───────────────────────────────────────────────────────────────────
w.getState().then(s => {
  state = s
  render()
  if (!s.hasToken) { openPanel(); openSettings() }
})
