const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('widget', {
  // Reads
  getState:     ()   => ipcRenderer.invoke('widget:get-state'),
  listRepos:    ()   => ipcRenderer.invoke('widget:list-repos'),
  listBranches: (fn) => ipcRenderer.invoke('widget:list-branches', fn),

  // Watchlist
  addRepo:     (p)  => ipcRenderer.invoke('widget:add-repo', p),
  removeRepo:  (fn) => ipcRenderer.invoke('widget:remove-repo', fn),
  setBranch:   (p)  => ipcRenderer.invoke('widget:set-branch', p),
  refresh:     (fn) => ipcRenderer.invoke('widget:refresh', fn),
  acknowledge: (fn) => ipcRenderer.invoke('widget:acknowledge', fn),
  pickFolder:  (fn) => ipcRenderer.invoke('widget:pick-folder', fn),
  pull:        (fn) => ipcRenderer.invoke('widget:pull', fn),

  // Account + preferences
  saveToken:        (t) => ipcRenderer.invoke('widget:save-token', t),
  clearToken:       ()  => ipcRenderer.invoke('widget:clear-token'),
  setRefresh:       (m) => ipcRenderer.invoke('widget:set-refresh', m),
  setNotifications: (b) => ipcRenderer.invoke('widget:set-notifications', b),
  setLaunchAtLogin: (b) => ipcRenderer.invoke('widget:set-launch-at-login', b),

  // Shell
  setHeight:    (h)   => ipcRenderer.invoke('widget:set-height', h),
  openExternal: (url) => ipcRenderer.invoke('widget:open-external', url),
  hide:         ()    => ipcRenderer.invoke('widget:hide'),
  quit:         ()    => ipcRenderer.invoke('widget:quit'),

  // Main → renderer
  onState:       (fn) => ipcRenderer.on('widget:state', (_, state) => fn(state)),
  onUpdateReady: (fn) => ipcRenderer.on('widget:update-ready', () => fn())
})
