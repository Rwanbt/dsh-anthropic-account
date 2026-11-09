// Model-catalog rules: which models a route serves, and in what order.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareGenerations,
  parseModelId,
  perFamilyCount,
  profileModelsFromListing,
  reasoningFieldsFromCapabilities,
  sameModels,
} from '../lib/model-catalog.mjs'

/** One `/v1/models` row, with the defaults a current Claude model carries. */
function row(id, { line = 'opus', created = '2026-01-01T00:00:00Z', lifecycle = 'active', context = 1_000_000, max = 128_000, image = true, effort, adaptive = false, budget = false } = {}) {
  const effortCapability = effort === undefined
    ? undefined
    : {
        supported: true,
        ...Object.fromEntries(effort.map((level) => [level, { supported: true }])),
      }
  return {
    type: 'model',
    id,
    display_name: id,
    line,
    created_at: created,
    lifecycle,
    max_input_tokens: context,
    max_tokens: max,
    capabilities: {
      image_input: { supported: image },
      ...(effortCapability === undefined ? {} : { effort: effortCapability }),
      thinking: {
        supported: adaptive || budget,
        types: {
          adaptive: { supported: adaptive },
          enabled: { supported: budget },
          disabled: { supported: true },
        },
      },
    },
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
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  )
})

test('orders generations numerically, not lexically', () => {
  const models = profileModelsFromListing(
    [
      row('claude-opus-4-10', { created: '2026-01-01T00:00:00Z' }),
      row('claude-opus-4-9', { created: '2025-12-01T00:00:00Z' }),
    ],
    1,
  )
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-opus-4-10'],
  )
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
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-haiku-5-5'],
  )
})

test('prefers the undated alias over a pinned snapshot of the same generation', () => {
  const models = profileModelsFromListing(
    [
      row('claude-opus-5-5-20261001', { created: '2026-10-01T00:00:00Z' }),
      row('claude-opus-5-5', { created: '2026-09-21T00:00:00Z' }),
    ],
    1,
  )
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-opus-5-5'],
  )
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
  const [model] = profileModelsFromListing(
    [row('claude-haiku-5-5', { line: 'haiku', context: 200_000, max: 64_000, image: false })],
    0,
  )
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
  assert.deepEqual(
    profileModelsFromListing(rows, 1).map((model) => model.id),
    ['claude-sonnet-5-5'],
  )
})

test('ignores malformed rows instead of failing the batch', () => {
  const models = profileModelsFromListing([null, { id: '' }, { baseline: true }, row('claude-opus-5-5')], 1)
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-opus-5-5'],
  )
})

test('deduplicates repeated ids', () => {
  const models = profileModelsFromListing([row('claude-opus-5-5'), row('claude-opus-5-5')], 0)
  assert.equal(models.length, 1)
})

test('parseModelId separates family, generation and snapshot', () => {
  assert.deepEqual(parseModelId('claude-opus-4-5-20251101'), { family: 'opus', version: [4, 5], dated: true })
  assert.deepEqual(parseModelId('claude-sonnet-5-5'), { family: 'sonnet', version: [5, 5], dated: false })
  assert.deepEqual(parseModelId('weird-model'), { family: 'weird-model', version: [], dated: false })
})

test('compareGenerations is a total order within a family', () => {
  const newer = { version: [5, 5], dated: false, createdAt: 1 }
  const older = { version: [5], dated: false, createdAt: 2 }
  assert.ok(compareGenerations(newer, older) < 0)
  assert.ok(compareGenerations(older, newer) > 0)
  const alias = { version: [5, 5], dated: false, createdAt: 1 }
  const snapshot = { version: [5, 5], dated: true, createdAt: 9 }
  assert.equal(compareGenerations(alias, snapshot), -1)
  assert.equal(compareGenerations(alias, alias), 0)
})

test('perFamilyCount defaults to 1 and clamps the range', () => {
  assert.equal(perFamilyCount(undefined), 1)
  assert.equal(perFamilyCount('2'), 2)
  assert.equal(perFamilyCount(0), 0)
  assert.equal(perFamilyCount(-3), 1)
  assert.equal(perFamilyCount(1.5), 1)
  assert.equal(perFamilyCount(99), 20)
})

test('sameModels detects any catalog change', () => {
  const base = [{ id: 'a', name: 'A', contextWindow: 1, maxTokens: 2, input: ['text'] }]
  assert.equal(sameModels(base, [{ ...base[0], input: ['text'] }]), true)
  assert.equal(sameModels(base, [{ ...base[0], id: 'b' }]), false)
  assert.equal(sameModels(base, [{ ...base[0], name: 'B' }]), false)
  assert.equal(sameModels(base, [{ ...base[0], contextWindow: 9 }]), false)
  assert.equal(sameModels(base, [{ ...base[0], input: ['text', 'image'] }]), false)
  assert.equal(sameModels(base, []), false)
  assert.equal(sameModels([], []), true)
  // Order is part of the catalog: a reorder is a change to write.
  assert.equal(sameModels([...base, { ...base[0], id: 'b' }], [{ ...base[0], id: 'b' }, ...base]), false)
})

/* ── reasoning / effort mapping ─────────────────────────────────────────── */

test('adaptive models get effort levels and the adaptive compat gate', () => {
  const fields = reasoningFieldsFromCapabilities(row('claude-opus-5-5', { effort: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true }))
  assert.deepEqual(fields.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
  assert.deepEqual(fields.compat, { forceAdaptiveThinking: true, supportsTemperature: false })
})

test('effort without adaptive thinking stays on the budget path (no compat)', () => {
  const fields = reasoningFieldsFromCapabilities(row('claude-opus-4-5-20251101', { effort: ['low', 'medium', 'high'], budget: true }))
  assert.deepEqual(fields.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' })
  assert.equal(fields.compat, undefined)
})

test('thinking without effort levels offers the conventional three', () => {
  const fields = reasoningFieldsFromCapabilities(row('legacy-model', { budget: true }))
  assert.deepEqual(fields.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' })
  assert.equal(fields.compat, undefined)
})

test('a model without thinking capabilities declares no reasoning', () => {
  assert.deepEqual(reasoningFieldsFromCapabilities(row('plain-model')), {})
  assert.deepEqual(reasoningFieldsFromCapabilities(null), {})
})

test('only the effort levels the endpoint reports are declared', () => {
  const fields = reasoningFieldsFromCapabilities(row('subset', { effort: ['low', 'high'], adaptive: true }))
  assert.deepEqual(Object.keys(fields.reasoningEfforts), ['off', 'low', 'high'])
})

test('the profile carries reasoning fields through the reduction', () => {
  const [model] = profileModelsFromListing(
    [row('claude-opus-5-5', { effort: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true })],
    1,
  )
  assert.equal(model.reasoningEfforts.max, 'max')
  assert.equal(model.reasoningEfforts.off, null)
  assert.equal(model.compat.forceAdaptiveThinking, true)
})

test('sameModels detects a reasoning-capability change', () => {
  const adaptive = profileModelsFromListing([row('claude-opus-5-5', { effort: ['low', 'high'], adaptive: true })], 1)
  const budget = profileModelsFromListing([row('claude-opus-5-5', { effort: ['low', 'high'], budget: true })], 1)
  assert.equal(sameModels(adaptive, adaptive), true)
  assert.equal(sameModels(adaptive, budget), false)
})
