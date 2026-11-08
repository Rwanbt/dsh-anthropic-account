// Model-list selection rules, exercised against representative endpoint payloads.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { profileModelsFromListing } from '../logic.js'

/** One `/v1/models` row, with the defaults a current Claude model carries. */
function row(id, { line = 'opus', created = '2026-01-01T00:00:00Z', lifecycle = 'active', context = 1_000_000, max = 128_000, image = true } = {}) {
  return {
    type: 'model',
    id,
    display_name: id,
    line,
    created_at: created,
    lifecycle,
    max_input_tokens: context,
    max_tokens: max,
    capabilities: { image_input: { supported: image } },
  }
}

test('keeps one generation per family', () => {
  const models = profileModelsFromListing(
    [
      row('claude-opus-5-5', { created: '2026-09-21T00:00:00Z' }),
      row('claude-sonnet-5-5', { line: 'sonnet', created: '2026-09-28T00:00:00Z' }),
      row('claude-haiku-5-5', { line: 'haiku', created: '2026-10-07T00:00:00Z' }),
      row('claude-fable-5-1', { line: 'fable', created: '2026-08-28T00:00:00Z' }),
      row('claude-opus-5', { created: '2026-07-24T00:00:00Z' }),
      row('claude-sonnet-4-6', { line: 'sonnet', created: '2026-02-17T00:00:00Z' }),
      row('claude-opus-4-8', { created: '2026-05-28T00:00:00Z' }),
    ],
    1,
  )
  assert.deepEqual(models.map((model) => model.id), [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
  ])
})

test('orders generations numerically, not lexically', () => {
  const models = profileModelsFromListing(
    [
      row('claude-opus-4-10', { created: '2026-01-01T00:00:00Z' }),
      row('claude-opus-4-9', { created: '2025-12-01T00:00:00Z' }),
    ],
    1,
  )
  assert.deepEqual(models.map((model) => model.id), ['claude-opus-4-10'])
})

test('drops deprecated and retired models', () => {
  const models = profileModelsFromListing(
    [
      row('claude-opus-5', { lifecycle: 'deprecated' }),
      row('claude-sonnet-5', { line: 'sonnet', lifecycle: 'retired' }),
      row('claude-haiku-5-5', { line: 'haiku' }),
    ],
    0,
  )
  assert.deepEqual(models.map((model) => model.id), ['claude-haiku-5-5'])
})

test('prefers the undated alias over a pinned snapshot of the same generation', () => {
  const models = profileModelsFromListing(
    [
      row('claude-opus-5-5-20261001', { created: '2026-10-01T00:00:00Z' }),
      row('claude-opus-5-5', { created: '2026-09-21T00:00:00Z' }),
    ],
    1,
  )
  assert.deepEqual(models.map((model) => model.id), ['claude-opus-5-5'])
})

test('perFamily controls the depth kept per family', () => {
  const rows = [
    row('claude-opus-5-5', { created: '2026-09-21T00:00:00Z' }),
    row('claude-opus-5', { created: '2026-07-24T00:00:00Z' }),
    row('claude-opus-4-8', { created: '2026-05-28T00:00:00Z' }),
    row('claude-sonnet-5-5', { line: 'sonnet', created: '2026-09-28T00:00:00Z' }),
  ]
  assert.equal(profileModelsFromListing(rows, 1).length, 2)
  assert.equal(profileModelsFromListing(rows, 2).length, 3)
  assert.equal(profileModelsFromListing(rows, 0).length, 4)
})

test('carries the endpoint capabilities into the profile', () => {
  const [model] = profileModelsFromListing([row('claude-haiku-5-5', { line: 'haiku', context: 200_000, max: 64_000, image: false })], 0)
  assert.deepEqual(model, {
    id: 'claude-haiku-5-5',
    name: 'claude-haiku-5-5',
    contextWindow: 200_000,
    maxTokens: 64_000,
    input: ['text'],
  })
})

test('derives the family from the id when the endpoint omits `line`', () => {
  const rows = [
    { id: 'claude-sonnet-5-5', created_at: '2026-09-28T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000 },
    { id: 'claude-sonnet-4-6', created_at: '2026-02-17T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000 },
  ]
  assert.deepEqual(profileModelsFromListing(rows, 1).map((model) => model.id), ['claude-sonnet-5-5'])
})

test('ignores malformed rows instead of failing the batch', () => {
  const models = profileModelsFromListing([null, { id: '' }, { baseline: true }, row('claude-opus-5-5')], 1)
  assert.deepEqual(models.map((model) => model.id), ['claude-opus-5-5'])
})
