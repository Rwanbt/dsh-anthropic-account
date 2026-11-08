// Status-document rules: the diagnostics the plugin publishes must never carry
// credential material, even if a future field starts holding one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containsCredentialMaterial, REDACTED, redactCredentialMaterial } from '../lib/status.mjs'

// Assembled at runtime so this file holds no literal credential shape.
const OAUTH = ['sk', 'ant', 'oat01', 'fixture-access'].join('-')
const GITHUB = ['gh', 'p_', 'A'.repeat(36)].join('')
const JWT = ['eyJhbGciOiJub25lIn0', 'eyJleHAiOjF9', 'c2ln'].join('.')
const AWS = ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join('')

test('recognizes credential shapes', () => {
  assert.equal(containsCredentialMaterial(OAUTH), true)
  assert.equal(containsCredentialMaterial(GITHUB), true)
  assert.equal(containsCredentialMaterial(JWT), true)
  assert.equal(containsCredentialMaterial(AWS), true)
  assert.equal(containsCredentialMaterial(`prefix ${OAUTH} suffix`), true)
})

test('leaves ordinary diagnostics alone', () => {
  const status = {
    version: 1,
    provider: { id: 'anthropic-account', ref: 'ANTHROPIC_ACCOUNT_OAUTH', provisioned: true },
    claude: { ok: true, store: 'file', source: 'claude-code', expiresAt: 1_794_179_477_940 },
    codex: { ok: true, imported: false },
    models: { ok: true, count: 4, ids: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  }
  assert.equal(containsCredentialMaterial(status), false)
  assert.deepEqual(redactCredentialMaterial(status), status)
})

test('finds material nested in arrays and objects', () => {
  assert.equal(containsCredentialMaterial({ a: [{ b: ['fine', OAUTH] }] }), true)
  assert.equal(containsCredentialMaterial([{ deep: { deeper: GITHUB } }]), true)
})

test('redacts every occurrence while preserving the shape', () => {
  const input = { token: OAUTH, nested: { list: [`a ${JWT} b`, 'clean'] }, count: 4, flag: true }
  const output = redactCredentialMaterial(input)
  assert.equal(output.token, REDACTED)
  assert.equal(output.nested.list[0], `a ${REDACTED} b`)
  assert.equal(output.nested.list[1], 'clean')
  assert.equal(output.count, 4)
  assert.equal(output.flag, true)
  assert.equal(containsCredentialMaterial(output), false)
})

test('redaction is idempotent and does not mutate its input', () => {
  const input = { token: OAUTH }
  const once = redactCredentialMaterial(input)
  const twice = redactCredentialMaterial(once)
  assert.deepEqual(twice, once)
  assert.equal(input.token, OAUTH)
})

test('a status document built by the plugin passes the guard', () => {
  // The shape logic.js writes: identifiers, booleans, epoch numbers, model ids.
  const status = {
    version: 1,
    checkedAt: '2026-11-08T17:05:03.000Z',
    provider: { id: 'anthropic-account', ref: 'ANTHROPIC_ACCOUNT_OAUTH', provisioned: true, attempts: 1 },
    claude: { ok: true, store: 'keychain', source: 'claude-code (refreshed)', expiresAt: 1_794_179_477_940, refreshed: true },
    codex: { ok: true, imported: true },
    models: { ok: true, count: 4, ids: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'], changed: true },
  }
  assert.equal(containsCredentialMaterial(status), false)
})
