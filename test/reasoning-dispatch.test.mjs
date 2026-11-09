// Why this file exists: the Harness compaction summarizer calls the model with
// no reasoning effort. On a route whose profile declares `off`, pi-ai answers
// such a request with `thinking: { type: 'disabled' }`, and Claude 5.5-class
// models reject that with
//
//   400 invalid_request_error: "thinking.type.disabled" is not supported for
//   this model. Use "thinking.type.adaptive" and "output_config.effort"
//
// which made every /compact and every automatic condensation fail. The plugin
// therefore only advertises `off` for models whose endpoint reports support for
// disabled thinking. These tests pin the placeholder catalog that ships in
// logic.js, because it is served before the first model discovery succeeds.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PLACEHOLDER_MODELS } from '../logic.js'

test('the placeholder catalog ships a usable, non-empty model list', () => {
  assert.ok(PLACEHOLDER_MODELS.length >= 4)
  for (const model of PLACEHOLDER_MODELS) {
    assert.deepEqual(model.input, ['text', 'image'])
    assert.ok(model.contextWindow > 0)
    assert.ok(model.maxTokens > 0)
  }
})

test('no placeholder model advertises off, so an effort-less request omits thinking', () => {
  for (const model of PLACEHOLDER_MODELS) {
    assert.equal(model.reasoningEfforts.off, undefined, `${model.id} must not declare off`)
    assert.equal('off' in model.reasoningEfforts, false, `${model.id} must not carry an off key`)
  }
})

test('placeholder models still offer the effort ladder and adaptive thinking', () => {
  for (const model of PLACEHOLDER_MODELS) {
    assert.deepEqual(Object.keys(model.reasoningEfforts), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.deepEqual(model.compat, { forceAdaptiveThinking: true, supportsTemperature: false })
  }
})
