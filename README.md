# GitPulse

> A 200-pixel desktop widget that tells you when your GitHub repos have moved ahead of your local clone — and pulls them with one click.

![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)
![Electron](https://img.shields.io/badge/electron-28-47848F?style=flat-square&logo=electron)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
[![winget](https://img.shields.io/winget/v/XxDoomsdayxX.GitPulse?style=flat-square&label=winget&color=blue)](https://github.com/XxDoomsdayxX/GitPulse/releases)

---

## What it does

GitPulse sits in a corner of your screen watching a list of GitHub repositories. When new commits land on any of them, its dot turns **red** and tells you how many commits you're behind. Click **Pull** and it fast-forwards your local clone. When everything's in sync it stays **green** and silent.

No browser tab. No polling a terminal. One glance.

```
● 2 repos behind                    ⠿  ×
──────────────────────────────────────────
● gitpulse                      3 behind
● byron-dashboard              up to date
● api-server                     checking…
──────────────────────────────────────────
   + Add repository            ↻      ⚙
```

Expand any row for the latest commit, its author and age, a branch picker, and per-repo actions.

---

## Features

| Feature | Details |
|---|---|
| **Watch many repos at once** | A stacked list, each with its own status, branch and local clone |
| **Commits-behind count** | "3 behind", not just "behind" |
| **One-click pull** | Fast-forward pull into your local clone, straight from the widget |
| **Folder verification** | GitPulse checks the folder you pick is really a clone of that repo before it ever pulls |
| **Desktop notifications** | Optional toast when a watched repo moves ahead |
| **Branch picker** | Watch any branch, not just the default one |
| **Auto-update** | New versions install themselves in the background |
| **Start with Windows** | Optional login-item, launched hidden to the tray |
| **System tray** | Icon colour-coded to the worst status; right-click for a per-repo summary |
| **Secure token storage** | Your PAT is encrypted with the OS keychain (Windows DPAPI) and never reaches the renderer |
| **Cheap polling** | ETag-conditional requests, so unchanged repos cost nothing against your rate limit |
| **Draggable** | Put it anywhere; position survives restarts and unplugged monitors |
| **No admin required** | Installs entirely in your user profile |

---

## Installation

### Option 1 — winget (recommended)

```cmd
winget install gitpulse
```

To update later — though GitPulse updates itself:

```cmd
winget upgrade gitpulse
```

> Requires Windows 10 1709 or later. winget ships with Windows 11 and is available for Windows 10 via the [App Installer](https://apps.microsoft.com/detail/9nblggh4nns1).

### Option 2 — Installer

Download `GitPulse Setup x.y.z.exe` from [Releases](https://github.com/XxDoomsdayxX/GitPulse/releases) and run it. No admin password needed; installs to `%LOCALAPPDATA%\Programs\gitpulse\`.

### Option 3 — From source

```bash
git clone https://github.com/XxDoomsdayxX/GitPulse.git
cd GitPulse
npm install
npm start
```

---

## First-time setup

### 1. Create a GitHub token

GitPulse only ever reads. A **fine-grained** token is recommended:

1. Go to [Settings → Developer settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)
2. Grant access to the repositories you want to watch
3. Under **Repository permissions**, set **Contents: Read-only** (and **Metadata: Read-only**, which is implied)
4. Generate and copy the token

A classic token with the `repo` scope also works, but it grants read *and write* to everything you can access — more than this widget needs.

> Your token is encrypted at rest via the OS keychain and is only ever sent to `api.github.com`.

### 2. Connect and add repositories

Click **⚙**, paste the token, hit **Connect**. The repository picker opens — search, then click any repo to start watching it. Add as many as you like.

---

## Using the widget

| Control | Action |
|---|---|
| Click the bar | Expand / collapse the watchlist |
| Click a repo row | Show commit details, branch picker and actions |
| **Pull** | Fast-forward your local clone (asks for the folder the first time) |
| **Seen** | Mark the current remote commit as acknowledged without pulling |
| **⤢ GitHub icon** | Open the repo in your browser |
| **🗑** | Stop watching the repo |
| **+ Add repository** | Search and add another repo |
| **↻** | Refresh everything now |
| **⚙** | Settings — account, refresh interval, notifications, start with Windows |
| Grab the `⠿` grip | Drag the widget anywhere |
| **×** | Hide to the system tray |
| `Esc` | Close picker → close settings → collapse |

### Status colours

| Colour | Meaning |
|---|---|
| 🟢 Green | Every watched repo is up to date |
| 🔴 Red | At least one repo has commits you haven't pulled |
| 🟡 Amber | A check failed — expired token, network, rate limit (the row says which) |
| ⬜ Pulsing | Checking right now |

---

## How sync detection works

GitPulse uses the **GitHub REST API** — it never reads your local `.git` folder except when you pull.

1. When you add a repo, its current remote HEAD becomes the "acknowledged" commit
2. Each poll compares the remote HEAD to that acknowledged SHA
3. Different → red, with a commits-behind count from the compare API
4. After a successful pull, the SHA that **actually landed locally** is acknowledged → green

So the status answers "have I pulled what's on the remote?" — not "is my working tree clean?".

**Pull safety:** before running anything, GitPulse verifies the folder is a git work tree whose `origin` points at that exact repository, then runs `git pull --ff-only` with interactive prompts disabled. A mis-picked folder is rejected rather than silently pulling some other project.

---

## Development

```bash
npm start        # run the widget
npm test         # unit tests (settings migration, git handling, GitHub client)
npm run test:app # end-to-end smoke test in a real Electron window
npm run build    # build dist/GitPulse Setup x.y.z.exe
```

### Project structure

```
main.js              # Main process — window, tray, polling, IPC, notifications
preload.js           # contextBridge — the window.widget API
lib/
  settings.js        # Schema + migration + atomic, debounced persistence
  github.js          # GitHub client — ETags, rate-limit backoff, error mapping
  git.js             # Safe git execution (argv, no shell) and clone verification
  icon.js            # Dependency-free PNG/tray icon generation
renderer/
  index.html         # Markup + CSP
  style.css          # OKLCH design system
  app.js             # Watchlist UI, driven by state pushed from main
test/                # Unit tests (node --test)
scripts/             # Icon generation + Electron smoke test
.github/workflows/   # CI on every push; release + winget submission on a tag
```

### Releasing

Bump `version` in `package.json`, then:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

CI runs the tests, builds the installer, publishes the GitHub release, and — when a `WINGET_TOKEN` secret is configured — opens the winget-pkgs PR.

---

## Roadmap

- **v1.2** — expanded dashboard window: full repo overview, open PRs and issues, recent activity
- Pull requests welcome.

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">Built with Claude Code</p>
