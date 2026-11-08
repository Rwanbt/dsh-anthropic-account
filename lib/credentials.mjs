/**
 * Pure credential rules: how a Claude Code / Codex credential document is
 * parsed, named, refreshed and turned into a pi-ai grant.
 *
 * Everything here is deterministic: no file access, no process spawn, no
 * network. The orchestration that reads a Keychain entry or a file lives in
 * `logic.js`, which passes the resulting text or objects through these
 * functions.
 *
 * @module dsh-anthropic-account/credentials
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** The Keychain service the Claude Code CLI writes on macOS. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'
/** Token prefix of a Claude subscription access token. */
export const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat'
/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000

/**
 * Parse one stored credential document, accepting both the Claude Code wrapper
 * (`{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }`) and the flat
 * legacy shape some installations carry.
 *
 * An `mcpOAuth`-only blob is an MCP grant rather than a Claude account, and a
 * document without an access token is not a grant at all, so both answer
 * `undefined` instead of a half-usable credential.
 * @param {string} text raw stored bytes.
 * @returns {{document: object, oauth: object} | undefined} undefined when the blob is not a grant.
 */
export function parseClaudeDocument(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  const wrapped = document.claudeAiOauth
  const oauth = wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped) ? wrapped : document
  if (typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return undefined
  return { document, oauth }
}

/**
 * Config directories Claude Code may use, most specific first.
 * @param {{env?: Record<string, string | undefined>, home?: string}} [options] injected environment for tests.
 * @returns {string[]} candidate directories.
 */
export function claudeConfigDirs(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? undefined
  const dirs = []
  const configured = env.CLAUDE_CONFIG_DIR
  if (typeof configured === 'string' && configured.length > 0) dirs.push(configured)
  if (typeof home === 'string' && home.length > 0) {
    const fallback = join(home, '.claude')
    if (!dirs.includes(fallback)) dirs.push(fallback)
  }
  return dirs
}

/**
 * Keychain services Claude Code may have written: the primary one, then the
 * per-config-directory ones, whose suffix is `sha256(configDir)` truncated to
 * eight hex characters — the CLI's own naming scheme.
 * @param {string[]} configDirs config directories to cover.
 * @returns {string[]} service names in preference order.
 */
export function keychainServiceNames(configDirs) {
  const services = [CLAUDE_KEYCHAIN_SERVICE]
  for (const directory of configDirs) {
    services.push(`${CLAUDE_KEYCHAIN_SERVICE}-${keychainSuffix(directory)}`)
  }
  return services
}

/**
 * The CLI's per-config-directory Keychain suffix for one directory.
 *
 * Callers pass the absolute config directory (`$CLAUDE_CONFIG_DIR` or
 * `~/.claude`), which is what the CLI hashes; the value is used verbatim so the
 * rule stays deterministic across platforms and testable against a known vector.
 */
export function keychainSuffix(directory) {
  return createHash('sha256').update(directory).digest('hex').slice(0, 8)
}

/**
 * Whether an access token is a Claude subscription grant. Only those may be used
 * as a subscription credential; an API key belongs to the API-key route.
 * @param {unknown} value candidate token.
 * @returns {boolean}
 */
export function isSubscriptionToken(value) {
  return typeof value === 'string' && value.startsWith(SUBSCRIPTION_TOKEN_PREFIX)
}

/**
 * Whether a grant is close enough to expiry to be refreshed.
 * @param {{expiresAt: unknown}} oauth grant fields.
 * @param {number} now current epoch milliseconds.
 * @param {number} [marginMs] refresh margin.
 * @returns {boolean} true when a refresh should be attempted.
 */
export function needsRefresh(oauth, now, marginMs = REFRESH_MARGIN_MS) {
  const expiresAt = Number(oauth?.expiresAt) || 0
  return expiresAt - now < marginMs
}

/**
 * Normalize a token-endpoint response into the fields the Claude Code store
 * keeps. Both endpoints have been observed to answer, and one of them reports
 * `expires_at` as an absolute epoch (seconds or milliseconds) while the other
 * reports a relative `expires_in`; a response that carries neither gets the
 * provider's ten-hour default.
 * @param {object} data parsed token response.
 * @param {string | undefined} previousRefreshToken refresh token to keep when the response rotates none.
 * @param {number} now current epoch milliseconds.
 * @returns {object} rotated grant fields.
 */
export function grantFromTokenResponse(data, previousRefreshToken, now) {
  if (data === null || typeof data !== 'object' || typeof data.access_token !== 'string') {
    throw new Error('token response carries no access_token')
  }
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : undefined
  const absolute = Number(data.expires_at) > 0 ? Number(data.expires_at) : undefined
  const expiresAt = absolute !== undefined
    ? absolute > 1e12 ? absolute : absolute * 1000
    : now + (expiresIn ?? 10 * 3600) * 1000 - 60_000
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : { refreshToken: previousRefreshToken }),
    expiresAt,
    ...(Number(data.refresh_token_expires_in) > 0
      ? { refreshTokenExpiresAt: now + Number(data.refresh_token_expires_in) * 1000 }
      : {}),
    ...(typeof data.scope === 'string' && data.scope.length > 0 ? { scopes: data.scope.split(' ') } : {}),
    ...(typeof data.account?.subscription_type === 'string'
      ? { subscriptionType: data.account.subscription_type }
      : {}),
  }
}

/**
 * Absolute expiry of a JWT access token, in milliseconds.
 * @param {string} token compact JWT.
 * @returns {number | undefined} expiry, or undefined for an unreadable token.
 */
export function jwtExpiry(token) {
  if (typeof token !== 'string') return undefined
  try {
    const payload = token.split('.')[1]
    if (payload === undefined) return undefined
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const exp = Number(json?.exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the `llm-pi-ai/openai-codex` grant from a Codex CLI `auth.json`
 * document.
 *
 * A healthy stored grant must never be replaced by an older file, so the caller
 * keeps that decision; this function only answers what the file alone describes.
 * @param {object} document parsed `auth.json`.
 * @param {number} now current epoch milliseconds.
 * @returns {{payload: object} | undefined} the grant to store, or undefined when the file holds no tokens.
 */
export function buildCodexGrant(document, now) {
  const tokens = document?.tokens
  if (tokens === null || typeof tokens !== 'object') return undefined
  const access = typeof tokens.access_token === 'string' && tokens.access_token.length > 0 ? tokens.access_token : undefined
  if (access === undefined) return undefined
  return {
    payload: {
      type: 'oauth',
      access,
      ...(typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0 ? { refresh: tokens.refresh_token } : {}),
      expires: jwtExpiry(access) ?? now + 60 * 60 * 1000,
      ...(typeof tokens.account_id === 'string' && tokens.account_id.length > 0 ? { accountId: tokens.account_id } : {}),
    },
  }
}

/** Whether a stored Codex grant is healthy enough to keep. */
export function isHealthyCodexGrant(payload, now, marginMs = 5 * 60 * 1000) {
  return payload !== null && typeof payload === 'object' && Number(payload.expires) > now + marginMs
}
