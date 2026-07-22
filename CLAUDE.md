# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Run the widget (Electron)
npm test         # Unit tests — node:test, no electron needed
npm run test:app # Electron smoke test (real window, real IPC, temp userData)
npm run build    # Icon generation + NSIS installer into dist/
```

## Architecture

Electron desktop widget. No framework, no bundler. Four layers:

**Main process** (`main.js`): owns everything privileged and *all repo state*. Window, tray, polling loop, notifications, IPC handlers. Pushes a full state snapshot to the renderer via `widget:state` after every change.

**lib/** — electron-free, unit-tested modules:
- `settings.js` — schema v2, migration from v1, atomic + debounced writes
- `github.js` — API client with ETag caching, rate-limit backoff, error mapping
- `git.js` — argv-only git execution, clone verification, error translation
- `icon.js` — PNG/tray icon generation using only `zlib`

**Preload** (`preload.js`): `contextBridge` exposing `window.widget`. Renderer is sandboxed with `contextIsolation`.

**Renderer** (`renderer/`): vanilla JS. Stateless with respect to repo data — it renders whatever snapshot main last sent, and holds only UI state (which row is expanded, which sub-panel is open).

## Key design decisions

- **Main owns state, renderer renders it.** The renderer never derives repo status; it can't drift from the tray or notifications.
- **API-only sync detection.** "Behind" means the remote HEAD differs from the acknowledged SHA for that repo. `.git/` is only touched on pull.
- **Pull is verified before it runs.** `git.verifyClone` requires a work tree whose `origin` matches the watched repo; then `git pull --ff-only` with prompts disabled; then the *post-pull* HEAD is acknowledged.
- **Window height follows content.** A `ResizeObserver` in the renderer reports content height to `widget:set-height`. Never hardcode heights — that's what caused the invisible click-blocking region fixed in 1.0.2.
- **`resizable: false` clamps shrinking on Windows.** `set-height` toggles `setResizable` around `setSize`, or the window can only ever grow.
- **Token never reaches the renderer.** Encrypted via `safeStorage`; the renderer only learns `hasToken`.
- **Colors**: OKLCH throughout. Green/red/amber are reserved for status only.

## Settings (`userData/settings.json`, schema v2)

```json
{
  "version": 2,
  "repos": [{ "fullName": "owner/repo", "branch": "main", "localPath": "C:/…", "ackSha": "abc…" }],
  "refreshInterval": 5,
  "position": [x, y],
  "username": "octocat",
  "notifications": true,
  "launchAtLogin": false
}
```

v1 files (`selectedRepo` / `acknowledgedShas` / `localPaths`) are migrated on load by `lib/settings.js`. Token lives separately in `userData/token.enc`.

## IPC channels

`ipcMain.handle` request/response, plus two main→renderer events.

| Channel | Purpose |
|---|---|
| `widget:get-state` | Full snapshot (repos + status + prefs) |
| `widget:save-token` / `widget:clear-token` | PAT management |
| `widget:list-repos` / `widget:list-branches` | GitHub lookups for the pickers |
| `widget:add-repo` / `widget:remove-repo` / `widget:set-branch` | Watchlist edits |
| `widget:refresh` | Poll one repo or all of them |
| `widget:acknowledge` | Mark current remote SHA as seen |
| `widget:pick-folder` | Folder dialog + clone verification |
| `widget:pull` | Verified `git pull --ff-only` |
| `widget:set-refresh` / `set-notifications` / `set-launch-at-login` | Preferences |
| `widget:set-height` | Resize window to content |
| `widget:open-external` | GitHub URLs only |
| `widget:hide` / `widget:quit` | Window lifecycle |
| `widget:state` *(main→renderer)* | State snapshot broadcast |
| `widget:update-ready` *(main→renderer)* | Auto-update downloaded |

## Releasing

Bump `package.json`, push a `v*` tag. `.github/workflows/release.yml` tests, builds, publishes the GitHub release, and submits to winget when `WINGET_TOKEN` is set.
