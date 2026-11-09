/**
 * Pure model-catalog rules: how a `/v1/models` listing becomes the model list a
 * pi-ai route serves.
 *
 * Nothing here performs I/O, so every rule is deterministic and unit-testable
 * without a Harness, a network or a credential.
 *
 * @module dsh-anthropic-account/model-catalog
 */

/** Upper bound kept on one synchronous model list before it is trimmed. */
export const MODEL_MAX_ENTRIES = 60

/** Reasoning levels the harness can offer, in escalation order. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Translate a model's endpoint capabilities into the reasoning fields a pi-ai
 * profile carries.
 *
 * Without this the route's models are materialized as non-reasoning (a declared
 * route has no installed catalog entry to inherit from), so the composer offers
 * no effort setting at all. The endpoint reports both the effort levels the
 * model accepts and whether it thinks adaptively:
 *
 * - effort levels + adaptive thinking → `reasoningEfforts` plus
 *   `compat.forceAdaptiveThinking`, which is the only shape those models accept
 *   (`thinking: { type: 'adaptive', effort }` rather than a token budget);
 * - effort levels without adaptive thinking → budget-based thinking, no compat;
 * - thinking without any effort level → the three conventional levels.
 *
 * `off` is declared only when the endpoint says the model accepts disabled
 * thinking (`thinking.types.disabled`). Declaring it makes pi-ai send
 * `thinking: { type: 'disabled' }` for any request that names no effort — and
 * the newest Claude models reject that outright:
 *
 *   400 invalid_request_error: "thinking.type.disabled" is not supported for
 *   this model. Use "thinking.type.adaptive" and "output_config.effort"
 *
 * That matters beyond the picker: Harness compaction summarizes through a
 * `ctx.llm.stream()` call that selects no reasoning effort, so a wrongly
 * declared `off` made every `/compact` and every automatic condensation fail on
 * those models. Leaving `off` undeclared materializes `off: null` in the
 * thinking-level map, which pi-ai reads as unsupported and answers by omitting
 * the `thinking` field entirely — the accepted "model default" request.
 * @param {object} row one endpoint model object.
 * @returns {{reasoningEfforts?: object, compat?: object}} fields to merge into the profile.
 */
export function reasoningFieldsFromCapabilities(row) {
  const effort = row?.capabilities?.effort
  const thinking = row?.capabilities?.thinking
  const types = thinking?.types ?? {}

  let levels = effort?.supported === true ? EFFORT_LEVELS.filter((level) => effort[level]?.supported === true) : []
  if (levels.length === 0 && types.enabled?.supported === true) levels = ['low', 'medium', 'high']
  if (levels.length === 0) return {}

  /** Only a model that accepts disabled thinking may advertise "off". */
  const reasoningEfforts = types.disabled?.supported === true ? { off: null } : {}
  for (const level of levels) reasoningEfforts[level] = level
  const adaptive = types.adaptive?.supported === true && effort?.supported === true
  return {
    reasoningEfforts,
    ...(adaptive ? { compat: { forceAdaptiveThinking: true, supportsTemperature: false } } : {}),
  }
}

/**
 * Decide how many generations of each family to keep.
 * @param {unknown} value configured value.
 * @returns {number} 1 by default, clamped to 0..20 (`0` keeps every model).
 */
export function perFamilyCount(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) return 1
  return Math.min(number, 20)
}

/**
 * Map endpoint model objects to pi-ai model profiles.
 *
 * Deprecated and retired models are dropped, then the listing is reduced to the
 * newest `perFamily` generations of each `line`: the endpoint orders families by
 * numbering and also reports `created_at`, and a model offered under both an
 * undated alias and a dated snapshot is represented once, by the alias.
 * @param {ReadonlyArray<object>} rows endpoint model objects.
 * @param {number} perFamily generations kept per family; 0 keeps every usable model.
 * @returns {Array<object>} clean model profiles.
 */
export function profileModelsFromListing(rows, perFamily) {
  const entries = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id : undefined
    if (id === undefined || id.length === 0 || seen.has(id)) continue
    if (row.lifecycle === 'deprecated' || row.lifecycle === 'retired') continue
    seen.add(id)

    const parsed = parseModelId(id)
    const input = ['text']
    if (row.capabilities?.image_input?.supported === true) input.push('image')
    const reasoning = reasoningFieldsFromCapabilities(row)
    entries.push({
      id,
      name: typeof row.display_name === 'string' && row.display_name.length > 0 ? row.display_name : id,
      ...capacity('contextWindow', row.max_input_tokens),
      ...capacity('maxTokens', row.max_tokens),
      input,
      ...reasoning,
      family: typeof row.line === 'string' && row.line.length > 0 ? row.line : parsed.family,
      version: parsed.version,
      dated: parsed.dated,
      createdAt: Date.parse(String(row.created_at ?? '')) || 0,
    })
  }

  const survivors = perFamily > 0 ? newestPerFamily(entries, perFamily) : entries
  return survivors.slice(0, MODEL_MAX_ENTRIES).map((entry) => ({
    id: entry.id,
    name: entry.name,
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
    input: entry.input,
    ...(entry.reasoningEfforts === undefined ? {} : { reasoningEfforts: { ...entry.reasoningEfforts } }),
    ...(entry.compat === undefined ? {} : { compat: { ...entry.compat } }),
  }))
}

/** Keep the newest `perFamily` generations of every model family, in endpoint order. */
function newestPerFamily(entries, perFamily) {
  const groups = new Map()
  for (const entry of entries) {
    const group = groups.get(entry.family)
    if (group === undefined) groups.set(entry.family, [entry])
    else group.push(entry)
  }
  const kept = new Set()
  for (const group of groups.values()) {
    group.sort(compareGenerations)
    for (const entry of group.slice(0, perFamily)) kept.add(entry.id)
  }
  return entries.filter((entry) => kept.has(entry.id))
}

/**
 * Order two models of the same family, newest first: higher generation number
 * wins, then the undated alias beats a pinned snapshot of that generation, then
 * the later `created_at` wins.
 */
export function compareGenerations(left, right) {
  const length = Math.max(left.version.length, right.version.length)
  for (let index = 0; index < length; index++) {
    const a = left.version[index] ?? 0
    const b = right.version[index] ?? 0
    if (a !== b) return b - a
  }
  if (left.dated !== right.dated) return left.dated ? 1 : -1
  return right.createdAt - left.createdAt
}

/** Split a model id into its family, its generation numbers, and a dated-snapshot flag. */
export function parseModelId(id) {
  const dated = /-\d{8}$/u.test(id)
  const tokens = id.replace(/-\d{8}$/u, '').split('-')
  if (tokens[0] === 'claude') tokens.shift()
  let index = 0
  while (index < tokens.length && !/^\d+$/u.test(tokens[index])) index++
  const family = tokens.slice(0, index).join('-') || 'claude'
  const version = []
  for (const token of tokens.slice(index)) {
    if (!/^\d+$/u.test(token)) break
    version.push(Number(token))
  }
  return { family, version, dated }
}

/** Whether two model lists describe the same route catalog. */
export function sameModels(current, wanted) {
  if (current.length !== wanted.length) return false
  for (let index = 0; index < wanted.length; index++) {
    const left = current[index] ?? {}
    const right = wanted[index]
    if (left.id !== right.id) return false
    if (left.name !== right.name) return false
    if (Number(left.contextWindow) !== Number(right.contextWindow)) return false
    if (Number(left.maxTokens) !== Number(right.maxTokens)) return false
    if (JSON.stringify(left.input ?? []) !== JSON.stringify(right.input ?? [])) return false
    if (JSON.stringify(left.reasoningEfforts ?? null) !== JSON.stringify(right.reasoningEfforts ?? null)) return false
    if (JSON.stringify(left.compat ?? null) !== JSON.stringify(right.compat ?? null)) return false
  }
  return true
}

function capacity(field, value) {
  return Number.isInteger(value) && value > 0 ? { [field]: value } : {}
}
