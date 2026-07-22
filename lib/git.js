'use strict'

const { execFile } = require('child_process')

// Never let git block on an interactive prompt: the widget has no console, so
// a credential prompt would just hang until the timeout with no explanation.
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE:     'never',
  GIT_ASKPASS:         '',
  SSH_ASKPASS:         ''
}

/**
 * Runs git with an argv array (never a shell string) so paths containing
 * quotes, spaces or shell metacharacters cannot alter the command.
 */
function runGit(args, cwd, { timeout = 30000, exec = execFile } = {}) {
  return new Promise(resolve => {
    exec('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      env: { ...process.env, ...GIT_ENV }
    }, (err, stdout = '', stderr = '') => {
      if (err) {
        const msg = (stderr || err.message || 'git failed').trim()
        resolve({ ok: false, error: msg, stdout: stdout.trim(), stderr: stderr.trim() })
      } else {
        resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() })
      }
    })
  })
}

/** owner/name for any GitHub remote URL form (https, ssh, git://, with or without .git). */
function parseRemote(url) {
  if (typeof url !== 'string') return null
  const m = url.trim()
    .replace(/\.git$/, '')
    .match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i)
  return m ? `${m[1]}/${m[2]}` : null
}

function sameRepo(remoteUrl, fullName) {
  const parsed = parseRemote(remoteUrl)
  return !!parsed && parsed.toLowerCase() === String(fullName).toLowerCase()
}

/**
 * Confirms `dir` is a git clone of `fullName` before we ever run a pull there.
 * Without this check a mis-picked folder pulls some *other* repository and the
 * widget then reports the watched repo as up to date — a silent false green.
 */
async function verifyClone(dir, fullName, opts) {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], dir, opts)
  if (!inside.ok || inside.stdout !== 'true') return { ok: false, error: 'Not a git repository' }

  const remote = await runGit(['remote', 'get-url', 'origin'], dir, opts)
  if (!remote.ok) return { ok: false, error: 'No "origin" remote in that folder' }
  if (!sameRepo(remote.stdout, fullName)) {
    return { ok: false, error: `That folder is ${parseRemote(remote.stdout) || 'another repo'}, not ${fullName}` }
  }
  return { ok: true }
}

async function currentBranch(dir, opts) {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir, opts)
  return r.ok ? r.stdout : null
}

async function headSha(dir, opts) {
  const r = await runGit(['rev-parse', 'HEAD'], dir, opts)
  return r.ok ? r.stdout : null
}

/**
 * Verify → pull → report the SHA that actually landed. The caller acknowledges
 * *that* SHA rather than the one from the last poll, so a commit pushed during
 * the pull cannot leave the widget falsely green.
 */
async function pull(dir, fullName, opts) {
  const verified = await verifyClone(dir, fullName, opts)
  if (!verified.ok) return verified

  const res = await runGit(['-c', `safe.directory=${dir}`, 'pull', '--ff-only'], dir, opts)
  if (!res.ok) {
    let error = res.error
    if (/diverge|not possible to fast-forward|Need to specify/i.test(error)) error = 'Local branch has diverged — pull manually'
    else if (/local changes|would be overwritten/i.test(error))              error = 'Uncommitted local changes — commit or stash first'
    else if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(error)) error = 'Git credentials required — pull once in a terminal'
    else if (/Could not resolve host|unable to access/i.test(error))         error = 'Network unavailable'
    return { ok: false, error: error.split('\n')[0].slice(0, 120) }
  }

  return {
    ok:     true,
    sha:    await headSha(dir, opts),
    branch: await currentBranch(dir, opts),
    output: res.stdout.split('\n')[0].slice(0, 120)
  }
}

module.exports = { runGit, parseRemote, sameRepo, verifyClone, currentBranch, headSha, pull, GIT_ENV }
