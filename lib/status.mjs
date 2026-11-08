/**
 * Pure status-document rules: what the plugin publishes for diagnostics, and the
 * guarantee that no credential material can reach it.
 *
 * The status file exists so a surface (or the user) can see what the last run
 * did without reading a log. It is written to the user's home directory, so a
 * token leaking into it would outlive the process. Every write therefore goes
 * through {@link redactCredentialMaterial}.
 *
 * @module dsh-anthropic-account/status
 */

/** Shapes that identify credential material rather than ordinary text. */
const SECRET_PATTERNS = [
  /sk-ant-(?:oat|ort)[A-Za-z0-9_-]+/u,
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
]

/** The replacement written in place of any matched run. */
export const REDACTED = '<redacted>'

/**
 * Whether a value carries anything that looks like credential material.
 * @param {unknown} value any JSON-shaped value.
 * @returns {boolean}
 */
export function containsCredentialMaterial(value) {
  if (typeof value === 'string') return SECRET_PATTERNS.some((pattern) => pattern.test(value))
  if (Array.isArray(value)) return value.some((entry) => containsCredentialMaterial(entry))
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((member) => containsCredentialMaterial(member))
  }
  return false
}

/**
 * Return a deep copy with every credential-shaped run replaced.
 * @template T
 * @param {T} value any JSON-shaped value.
 * @returns {T} the redacted copy.
 */
export function redactCredentialMaterial(value) {
  if (typeof value === 'string') {
    let result = value
    for (const pattern of SECRET_PATTERNS) result = result.replace(new RegExp(pattern.source, 'gu'), REDACTED)
    return result
  }
  if (Array.isArray(value)) return value.map((entry) => redactCredentialMaterial(entry))
  if (value !== null && typeof value === 'object') {
    const next = {}
    for (const [key, member] of Object.entries(value)) next[key] = redactCredentialMaterial(member)
    return next
  }
  return value
}
