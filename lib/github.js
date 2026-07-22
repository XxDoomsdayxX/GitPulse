'use strict'

const https = require('https')

const API_HOST   = 'api.github.com'
const USER_AGENT = 'GitPulse'

/**
 * Turns a GitHub API failure into something a 200px-wide widget can show and a
 * user can act on. Without this every problem — expired token, SAML-protected
 * org, renamed repo, exhausted rate limit — looks identical.
 */
function describeError(status, body, headers = {}) {
  const remaining = Number(headers['x-ratelimit-remaining'])
  if (status === 401) return 'Token invalid or expired'
  if (status === 403 && remaining === 0) return 'GitHub rate limit reached'
  if (status === 403) return body?.message?.includes('SAML') ? 'SSO authorization required' : 'Access forbidden'
  if (status === 404) return 'Repo or branch not found'
  if (status === 409) return 'Repository is empty'
  if (status >= 500)  return 'GitHub is unavailable'
  return body?.message || `HTTP ${status}`
}

/** Epoch ms when the rate limit resets, or null when not rate limited. */
function rateLimitResetAt(status, headers = {}) {
  if (status !== 403 && status !== 429) return null
  if (Number(headers['x-ratelimit-remaining']) !== 0) return null
  const reset = Number(headers['x-ratelimit-reset'])
  return Number.isFinite(reset) ? reset * 1000 : null
}

function createClient({ getToken, request = https.request, now = Date.now }) {
  // Cached ETags make unchanged polls return 304, which GitHub does not count
  // against the rate limit — the difference between comfortable and marginal
  // when polling several repos every minute.
  const etags   = new Map()
  const cached  = new Map()
  let blockedUntil = 0

  function raw(endpoint, { etag } = {}) {
    return new Promise((resolve, reject) => {
      const token = getToken()
      if (!token) return reject(Object.assign(new Error('No token configured'), { code: 'NO_TOKEN' }))

      const headers = {
        Authorization: `Bearer ${token}`,
        'User-Agent':  USER_AGENT,
        Accept:        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
      if (etag) headers['If-None-Match'] = etag

      const req = request({ hostname: API_HOST, path: endpoint, headers }, res => {
        let body = ''
        res.on('data', c => body += c)
        res.on('end', () => {
          let json = null
          try { json = body ? JSON.parse(body) : null } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json })
        })
      })
      req.on('error', () => reject(Object.assign(new Error('Network unavailable'), { code: 'NETWORK' })))
      req.setTimeout(12000, () => req.destroy(Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' })))
      req.end()
    })
  }

  async function get(endpoint, { cache = false } = {}) {
    if (blockedUntil > now()) {
      const mins = Math.max(1, Math.ceil((blockedUntil - now()) / 60000))
      throw Object.assign(new Error(`Rate limited — retry in ${mins}m`), { code: 'RATE_LIMIT' })
    }

    const sendEtag = cache ? etags.get(endpoint) : null
    let res = await raw(endpoint, { etag: sendEtag })

    if (res.status === 304) {
      if (cached.has(endpoint)) return cached.get(endpoint)
      // Told "unchanged" with nothing cached to return — drop the stale ETag
      // and ask again for the full body rather than returning null.
      etags.delete(endpoint)
      res = await raw(endpoint)
    }

    if (res.status >= 400) {
      const resetAt = rateLimitResetAt(res.status, res.headers)
      if (resetAt) blockedUntil = resetAt
      throw Object.assign(new Error(describeError(res.status, res.json, res.headers)), {
        code: resetAt ? 'RATE_LIMIT' : `HTTP_${res.status}`, status: res.status
      })
    }

    if (cache && res.headers.etag) {
      etags.set(endpoint, res.headers.etag)
      cached.set(endpoint, res.json)
    }
    return res.json
  }

  return {
    get,

    async user() {
      const d = await get('/user')
      return { login: d.login, name: d.name || d.login }
    },

    /** Every repo the user can see, including org repos they're a member of. */
    async repos() {
      const out = []
      for (let page = 1; page <= 10; page++) {
        const batch = await get(
          `/user/repos?sort=pushed&per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`
        )
        if (!Array.isArray(batch) || !batch.length) break
        for (const r of batch) {
          out.push({
            fullName:      r.full_name,
            name:          r.name,
            defaultBranch: r.default_branch,
            private:       r.private
          })
        }
        if (batch.length < 100) break
      }
      return out
    },

    async branches(fullName) {
      const list = await get(`/repos/${fullName}/branches?per_page=100`)
      return Array.isArray(list) ? list.map(b => b.name) : []
    },

    async commit(fullName, branch) {
      const d = await get(`/repos/${fullName}/commits/${encodeURIComponent(branch)}`, { cache: true })
      return {
        sha:      d.sha,
        shortSha: d.sha.slice(0, 7),
        message:  d.commit.message.split('\n')[0].slice(0, 120),
        author:   (d.commit.author?.name || d.commit.committer?.name || 'Unknown').slice(0, 28),
        date:     d.commit.author?.date || d.commit.committer?.date,
        url:      d.html_url
      }
    },

    /**
     * How many commits `branch` is ahead of `baseSha`. Returns null when the
     * comparison is impossible (e.g. the acknowledged SHA was force-pushed
     * away) — callers should treat null as "behind by an unknown amount".
     */
    async aheadBy(fullName, baseSha, branch) {
      try {
        const d = await get(`/repos/${fullName}/compare/${baseSha}...${encodeURIComponent(branch)}`)
        return Number.isFinite(d.ahead_by) ? d.ahead_by : null
      } catch { return null }
    }
  }
}

module.exports = { createClient, describeError, rateLimitResetAt }
