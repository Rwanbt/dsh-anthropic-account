// Credential rules: parsing Claude Code documents, naming Keychain services,
// normalizing token responses, and describing the Codex grant.
//
// Fixtures are assembled at runtime so the repository never contains a literal
// credential shape, which keeps secret scanners and GitHub push protection from
// flagging the test suite.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildCodexGrant,
  CLAUDE_KEYCHAIN_SERVICE,
  claudeConfigDirs,
  grantFromTokenResponse,
  isHealthyCodexGrant,
  isSubscriptionToken,
  jwtExpiry,
  keychainServiceNames,
  keychainSuffix,
  needsRefresh,
  parseClaudeDocument,
  REFRESH_MARGIN_MS,
} from '../lib/credentials.mjs'

const OAUTH = ['sk', 'ant', 'oat01', 'fixture-access'].join('-')
const OAUTH_ROTATED = ['sk', 'ant', 'oat01', 'fixture-rotated'].join('-')
const REFRESH = ['sk', 'ant', 'ort01', 'fixture-refresh'].join('-')
const API_KEY = ['sk', 'ant', 'api03', 'fixture'].join('-')
const NOW = 1_790_000_000_000

/** Build an unsigned compact JWT with the given payload. */
function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`
}

test('parses the wrapped Claude Code document', () => {
  const parsed = parseClaudeDocument(
    JSON.stringify({ claudeAiOauth: { accessToken: OAUTH, refreshToken: REFRESH, expiresAt: 1 }, mcpOAuth: { a: 1 } }),
  )
  assert.equal(parsed.oauth.accessToken, OAUTH)
  assert.deepEqual(parsed.document.mcpOAuth, { a: 1 })
})

test('parses the flat legacy document', () => {
  const parsed = parseClaudeDocument(JSON.stringify({ accessToken: OAUTH, refreshToken: REFRESH, expiresAt: 2 }))
  assert.equal(parsed.oauth.expiresAt, 2)
})

test('rejects documents that are not a Claude account', () => {
  assert.equal(parseClaudeDocument(JSON.stringify({ mcpOAuth: { a: 1 } })), undefined)
  assert.equal(parseClaudeDocument(JSON.stringify({ claudeAiOauth: { refreshToken: REFRESH } })), undefined)
  assert.equal(parseClaudeDocument(JSON.stringify({})), undefined)
  assert.equal(parseClaudeDocument('not json'), undefined)
  assert.equal(parseClaudeDocument('null'), undefined)
  assert.equal(parseClaudeDocument('[]'), undefined)
  assert.equal(parseClaudeDocument(''), undefined)
  assert.equal(parseClaudeDocument(undefined), undefined)
})

test('uses CLAUDE_CONFIG_DIR first, then the home default', () => {
  const dirs = claudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: '/custom/claude' }, home: '/Users/example' })
  assert.deepEqual(dirs, ['/custom/claude', join('/Users/example', '.claude')])
})

test('falls back to the home default without CLAUDE_CONFIG_DIR', () => {
  assert.deepEqual(claudeConfigDirs({ env: {}, home: '/Users/example' }), [join('/Users/example', '.claude')])
})

test('does not repeat a config dir that is already the home default', () => {
  const home = '/Users/example'
  const dirs = claudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: join(home, '.claude') }, home })
  assert.deepEqual(dirs, [join(home, '.claude')])
})

test('names the primary Keychain service first, then one per config dir', () => {
  const services = keychainServiceNames(['/Users/example/.claude', '/home/example/.claude'])
  assert.deepEqual(services, [
    CLAUDE_KEYCHAIN_SERVICE,
    `${CLAUDE_KEYCHAIN_SERVICE}-402b469b`,
    `${CLAUDE_KEYCHAIN_SERVICE}-3783d4ca`,
  ])
})

test('the Keychain suffix matches the CLI scheme', () => {
  assert.equal(keychainSuffix('/Users/example/.claude'), '402b469b')
  assert.equal(keychainSuffix('/home/example/.claude'), '3783d4ca')
  assert.match(keychainSuffix('x'), /^[0-9a-f]{8}$/u)
})

test('only subscription tokens are accepted as a Claude grant', () => {
  assert.equal(isSubscriptionToken(OAUTH), true)
  assert.equal(isSubscriptionToken(API_KEY), false)
  assert.equal(isSubscriptionToken(''), false)
  assert.equal(isSubscriptionToken(undefined), false)
  assert.equal(isSubscriptionToken(42), false)
})

test('needsRefresh honours the margin on both sides', () => {
  assert.equal(needsRefresh({ expiresAt: NOW + REFRESH_MARGIN_MS + 1_000 }, NOW), false)
  assert.equal(needsRefresh({ expiresAt: NOW + REFRESH_MARGIN_MS - 1_000 }, NOW), true)
  assert.equal(needsRefresh({ expiresAt: NOW - 1 }, NOW), true)
  assert.equal(needsRefresh({ expiresAt: 'nonsense' }, NOW), true)
})

test('normalizes a relative expires_in response', () => {
  const grant = grantFromTokenResponse(
    { access_token: OAUTH_ROTATED, refresh_token: REFRESH, expires_in: 3600, scope: 'user:inference user:profile' },
    REFRESH,
    NOW,
  )
  assert.equal(grant.accessToken, OAUTH_ROTATED)
  assert.equal(grant.refreshToken, REFRESH)
  assert.equal(grant.expiresAt, NOW + 3_600_000 - 60_000)
  assert.deepEqual(grant.scopes, ['user:inference', 'user:profile'])
})

test('keeps the previous refresh token when the response does not rotate it', () => {
  const grant = grantFromTokenResponse({ access_token: OAUTH_ROTATED, expires_in: 60 }, REFRESH, NOW)
  assert.equal(grant.refreshToken, REFRESH)
})

test('accepts an absolute expires_at in seconds or milliseconds', () => {
  const seconds = grantFromTokenResponse({ access_token: OAUTH, expires_at: 1_800_000_000 }, undefined, NOW)
  assert.equal(seconds.expiresAt, 1_800_000_000_000)
  const millis = grantFromTokenResponse({ access_token: OAUTH, expires_at: 1_800_000_000_000 }, undefined, NOW)
  assert.equal(millis.expiresAt, 1_800_000_000_000)
})

test('defaults to a ten-hour lifetime when the response carries no expiry', () => {
  const grant = grantFromTokenResponse({ access_token: OAUTH }, undefined, NOW)
  assert.equal(grant.expiresAt, NOW + 10 * 3_600_000 - 60_000)
})

test('carries refresh-token expiry and subscription type when present', () => {
  const grant = grantFromTokenResponse(
    { access_token: OAUTH, refresh_token_expires_in: 100, account: { subscription_type: 'max' } },
    undefined,
    NOW,
  )
  assert.equal(grant.refreshTokenExpiresAt, NOW + 100_000)
  assert.equal(grant.subscriptionType, 'max')
})

test('refuses a token response without an access token', () => {
  assert.throws(() => grantFromTokenResponse({}, undefined, NOW), /access_token/u)
  assert.throws(() => grantFromTokenResponse(null, undefined, NOW), /access_token/u)
})

test('reads a JWT expiry in milliseconds', () => {
  assert.equal(jwtExpiry(jwt({ exp: 1_800_000_000 })), 1_800_000_000_000)
  assert.equal(jwtExpiry(jwt({ exp: 'nope' })), undefined)
  assert.equal(jwtExpiry(jwt({})), undefined)
  assert.equal(jwtExpiry('not-a-jwt'), undefined)
  assert.equal(jwtExpiry(undefined), undefined)
})

test('builds a Codex grant with account id and JWT expiry', () => {
  const access = jwt({ exp: 1_800_000_000 })
  const built = buildCodexGrant({ tokens: { access_token: access, refresh_token: 'r', account_id: 'acct-1' } }, NOW)
  assert.deepEqual(built, {
    payload: { type: 'oauth', access, refresh: 'r', expires: 1_800_000_000_000, accountId: 'acct-1' },
  })
})

test('builds a Codex grant without optional fields', () => {
  const built = buildCodexGrant({ tokens: { access_token: 'opaque-token' } }, NOW)
  assert.deepEqual(built, {
    payload: { type: 'oauth', access: 'opaque-token', expires: NOW + 3_600_000 },
  })
})

test('refuses a Codex document without tokens', () => {
  assert.equal(buildCodexGrant({}, NOW), undefined)
  assert.equal(buildCodexGrant({ tokens: { refresh_token: 'r' } }, NOW), undefined)
  assert.equal(buildCodexGrant({ tokens: { access_token: '' } }, NOW), undefined)
  assert.equal(buildCodexGrant(null, NOW), undefined)
})

test('a stored Codex grant is healthy only while it still has runway', () => {
  assert.equal(isHealthyCodexGrant({ expires: NOW + 10 * 60_000 }, NOW), true)
  assert.equal(isHealthyCodexGrant({ expires: NOW + 60_000 }, NOW), false)
  assert.equal(isHealthyCodexGrant({ expires: NOW - 1 }, NOW), false)
  assert.equal(isHealthyCodexGrant(undefined, NOW), false)
  assert.equal(isHealthyCodexGrant(null, NOW), false)
})
