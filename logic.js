/**
 * Host half of the Anthropic-account bundle.
 *
 * Three jobs, all driven from credential stores and endpoints that already
 * exist on this machine rather than from a browser round trip:
 *
 * 1. Provision the `anthropic-account` route in the `llm-pi-ai` settings
 *    section. pi-ai serves any configured route whose profile names a wire
 *    protocol, and its Anthropic Messages implementation detects an
 *    `sk-ant-oat…` access token and switches to exactly the subscription wire
 *    shape a Claude Pro/Max grant requires (Bearer auth, Claude Code identity
 *    headers, `claude-code-20250219` + `oauth-2025-04-20` betas and the Claude
 *    Code system identity). So the route needs a token, not protocol code.
 *
 * 2. Keep the advertised model list equal to what the subscription can
 *    currently use. `GET /v1/models` with the grant returns each model's id,
 *    display name, context window, output cap and image capability, so the
 *    route follows the account instead of a list frozen at build time. The
 *    catalog rules themselves live in `./lib/model-catalog.mjs`.
 *
 * 3. Keep the token fresh and repair the Codex OAuth grant:
 *    - the Claude Code credential store (macOS Keychain, or
 *      `<configDir>/.credentials.json` everywhere else) holds the grant; the
 *      access token is mirrored into the `ANTHROPIC_ACCOUNT_OAUTH` credential
 *      reference and refreshed in place shortly before it expires;
 *    - `~/.codex/auth.json` holds the ChatGPT subscription tokens, which become
 *      the `llm-pi-ai/openai-codex` credential record the shipped
 *      `openai-codex` provider already reads.
 *
 * Nothing here reimplements a provider protocol, and no secret is written to
 * configuration: tokens live in the credential plane, exactly as the Models
 * page expects. Credential parsing and naming rules live in
 * `./lib/credentials.mjs`; the status document is redacted through
 * `./lib/status.mjs` before it is written.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  buildCodexGrant,
  claudeConfigDirs,
  grantFromTokenResponse,
  isHealthyCodexGrant,
  isSubscriptionToken,
  keychainServiceNames,
  needsRefresh,
  parseClaudeDocument,
} from './lib/credentials.mjs'
import { perFamilyCount, profileModelsFromListing, sameModels } from './lib/model-catalog.mjs'
import { redactCredentialMaterial } from './lib/status.mjs'

const execFileAsync = promisify(execFile)

/** The pi-ai settings namespace holding provider profiles. */
const PI_NS = 'llm-pi-ai'
/** Claude Code's public OAuth client id (also used by pi-ai's Anthropic flow). */
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_REFRESH_URL = 'https://claude.ai/v1/oauth/token'
const CLAUDE_API_BASE = 'https://api.anthropic.com'
const CLAUDE_MODELS_URL = `${CLAUDE_API_BASE}/v1/models`
/** Version and identity headers the subscription endpoints expect. */
const ANTHROPIC_VERSION = '2023-06-01'
const CLAUDE_CLI_USER_AGENT = 'claude-cli/2.1.280 (external, sdk-cli)'
const CLAUDE_BETAS = 'claude-code-20250219,oauth-2025-04-20'
/** How often the token mirror re-checks the canonical store. */
const TICK_MS = 60 * 1000
/** How often the model list is re-read from the endpoint. */
const MODEL_SYNC_MS = 6 * 60 * 60 * 1000
const HTTP_TIMEOUT_MS = 20 * 1000
/** Wait for this plugin's own activation transaction to settle before writing settings. */
const SETTLE_MS = 1500
const PROVISION_ATTEMPTS = 8
const PROVISION_RETRY_MS = 2500
const MODEL_PAGE_LIMIT = 1000
const MODEL_MAX_PAGES = 5

/**
 * Models used only until the first successful discovery, so a brand-new install
 * still shows a usable route if the endpoint cannot be reached yet. The next
 * sync replaces them with the account's real list.
 *
 * The reasoning fields mirror what the endpoint reports for the current Claude
 * generation: adaptive thinking with effort levels. Without them DSH
 * materializes the model as non-reasoning and the composer offers no effort
 * setting.
 *
 * No `off` here: the generation these placeholders cover cannot disable
 * thinking, and declaring `off` makes every effort-less request — including the
 * compaction summarizer's — send `thinking: { type: 'disabled' }`, which those
 * models reject with a 400. Omitting it leaves the request on the model default.
 */
const FALLBACK_REASONING = {
  reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  compat: { forceAdaptiveThinking: true, supportsTemperature: false },
}
const FALLBACK_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], ...FALLBACK_REASONING },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], ...FALLBACK_REASONING },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], ...FALLBACK_REASONING },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], ...FALLBACK_REASONING },
]

/** Placeholder catalog, exported so the shipped shape stays under test. */
export const PLACEHOLDER_MODELS = FALLBACK_MODELS

export function apply(ctx, config = {}) {
  const providerId = nonEmpty(config.providerId) ?? 'anthropic-account'
  const refName = nonEmpty(config.credentialRef) ?? 'ANTHROPIC_ACCOUNT_OAUTH'
  const provision = config.provisionProvider !== false
  const repairCodex = config.repairCodex !== false
  const refreshClaudeCode = config.refreshClaudeCodeToken !== false
  const syncModels = config.syncModels !== false
  const modelSyncMs = hoursToMs(config.modelSyncHours, MODEL_SYNC_MS / 3_600_000)
  const modelsPerFamily = perFamilyCount(config.modelsPerFamily)

  ctx.inject(['settings', 'credentials'], (host) => {
    let stopped = false
    let lastMirrored = undefined
    let lastSyncAt = 0
    /** Latest observation, published for surfaces and diagnostics. */
    const status = {
      version: 1,
      checkedAt: undefined,
      provider: { id: providerId, ref: refName, provisioned: false, error: undefined },
      claude: { ok: false, store: undefined, source: undefined, expiresAt: undefined, refreshed: false, error: undefined },
      codex: { ok: false, imported: false, error: undefined },
      models: { ok: false, count: 0, ids: [], syncedAt: undefined, changed: false, error: undefined },
    }

    const log = (level, message) => {
      try {
        host.logger?.[level]?.(`anthropic-account: ${message}`)
      } catch {
        // logging must never break the flow
      }
    }
    const publish = () => {
      status.checkedAt = new Date().toISOString()
      void writeStatus(status).catch(() => {})
    }

    const mirror = async ({ force = false } = {}) => {
      try {
        const result = await mirrorClaudeToken(host, {
          refName,
          force,
          refreshClaudeCode,
          lastMirrored: () => lastMirrored,
          remember: (token) => {
            lastMirrored = token
          },
        })
        status.claude = {
          ok: result.ok === true,
          store: result.store,
          source: result.source,
          expiresAt: result.expiresAt,
          refreshed: result.refreshed === true,
          error: result.ok === true ? undefined : result.reason,
        }
        if (result.mirrored === true) log('info', `Claude access token mirrored (${result.source})`)
        if (result.ok !== true) log('warn', `Claude token unavailable: ${result.reason}`)
        return result
      } catch (error) {
        status.claude = { ok: false, error: messageOf(error) }
        log('warn', `Claude token mirror failed: ${messageOf(error)}`)
        return { ok: false, reason: messageOf(error) }
      } finally {
        publish()
      }
    }

    /** Read the account's model list and make the route serve it. */
    const refreshModels = async ({ force = false } = {}) => {
      if (syncModels !== true) return
      if (force !== true && Date.now() - lastSyncAt < modelSyncMs) return
      try {
        const discovered = await discoverModels(host, { perFamily: modelsPerFamily })
        lastSyncAt = Date.now()
        status.models = {
          ok: true,
          count: discovered.length,
          ids: discovered.map((model) => model.id),
          syncedAt: new Date(lastSyncAt).toISOString(),
          changed: false,
          error: undefined,
        }
        if (provision) {
          const outcome = await provisionProvider(host, { providerId, refName }, discovered)
          status.provider.provisioned = outcome.provisioned === true
          status.provider.error = outcome.error
          status.models.changed = outcome.modelsChanged === true
          if (outcome.modelsChanged === true) log('info', `model list updated with ${discovered.length} models`)
        }
        publish()
      } catch (error) {
        status.models = { ...status.models, ok: false, error: messageOf(error) }
        log('warn', `model discovery failed: ${messageOf(error)}`)
        publish()
      }
    }

    const bootstrap = async () => {
      // Activating this plugin is itself a Loader/HMR transaction, and a settings
      // write started inside one is refused ("HMR transactions cannot be
      // nested"). Let the activation settle first, then write.
      await sleep(SETTLE_MS)

      await mirror()
      if (repairCodex) {
        try {
          const repaired = await repairCodexGrant(host)
          status.codex = { ok: repaired.ok === true, imported: repaired.imported === true, error: repaired.reason }
          if (repaired.imported === true) log('info', 'Codex OAuth grant restored from the Codex CLI store')
          else if (repaired.ok !== true) log('warn', `Codex grant not repaired: ${repaired.reason}`)
        } catch (error) {
          status.codex = { ok: false, imported: false, error: messageOf(error) }
          log('warn', `Codex grant repair failed: ${messageOf(error)}`)
        }
      }
      publish()

      if (provision) {
        // First pass: keep the route addressable even if discovery is still to come.
        for (let attempt = 1; attempt <= PROVISION_ATTEMPTS && stopped !== true; attempt++) {
          let outcome
          try {
            outcome = await provisionProvider(host, { providerId, refName }, undefined)
          } catch (error) {
            outcome = { provisioned: false, error: messageOf(error) }
          }
          status.provider.provisioned = outcome.provisioned === true
          status.provider.error = outcome.error
          status.provider.attempts = attempt
          publish()
          if (outcome.provisioned === true) break
          if (/nested/i.test(outcome.error ?? '')) await sleep(PROVISION_RETRY_MS)
          else if (attempt >= 2) {
            log('warn', `provider profile not written: ${outcome.error}`)
            break
          } else await sleep(PROVISION_RETRY_MS)
        }
      }
      await refreshModels({ force: true })
    }

    void bootstrap()

    const tokenTimer = setInterval(() => {
      if (stopped) return
      void mirror()
    }, TICK_MS)
    if (typeof tokenTimer?.unref === 'function') tokenTimer.unref()

    const modelTimer = setInterval(() => {
      if (stopped) return
      void refreshModels()
    }, modelSyncMs)
    if (typeof modelTimer?.unref === 'function') modelTimer.unref()

    host.effect(() => () => {
      stopped = true
      clearInterval(tokenTimer)
      clearInterval(modelTimer)
    }, 'anthropic-account: token and model timers')
  })
}

/** Where the last run's observations are published. */
function statusPath() {
  const home = nonEmpty(process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(home, 'anthropic-account-status.json')
}

/**
 * Publish the last run's observations, with credential-shaped text redacted as a
 * second line of defence: the status document records no token by construction,
 * and this guarantees that a future field cannot start leaking one.
 * @param {object} status observations.
 */
async function writeStatus(status) {
  const path = statusPath()
  const safe = redactCredentialMaterial({ ...status, checkedAt: new Date().toISOString() })
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/* ── model discovery ─────────────────────────────────────────────────────── */

/**
 * Read the models the subscription can use, keeping only the latest generation
 * of each family.
 * @param {object} ctx injected Host context.
 * @param {{perFamily: number}} options how many generations to keep per family; 0 keeps all.
 * @returns {Promise<Array<object>>} model profiles in endpoint order.
 */
async function discoverModels(ctx, options = {}) {
  const token = await readAccessToken(ctx)
  if (token === undefined) throw new Error('no subscription access token')

  const rows = []
  let after
  for (let page = 0; page < MODEL_MAX_PAGES; page++) {
    const url = new URL(CLAUDE_MODELS_URL)
    url.searchParams.set('limit', String(MODEL_PAGE_LIMIT))
    if (after !== undefined) url.searchParams.set('after_id', after)
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': CLAUDE_BETAS,
        'user-agent': CLAUDE_CLI_USER_AGENT,
        'x-app': 'cli',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`GET /v1/models answered ${response.status}: ${text.slice(0, 200)}`)
    const body = JSON.parse(text)
    const data = Array.isArray(body?.data) ? body.data : []
    rows.push(...data)
    if (body?.has_more !== true || typeof body?.last_id !== 'string' || data.length === 0) break
    after = body.last_id
  }

  const models = profileModelsFromListing(rows, options?.perFamily ?? 1)
  if (models.length === 0) throw new Error('the endpoint returned no usable model')
  return models
}

/** The stored subscription access token, or undefined when nothing usable exists. */
async function readAccessToken(ctx) {
  try {
    const resolved = await ctx.get('credentials')?.resolve('ANTHROPIC_ACCOUNT_OAUTH')
    if (isSubscriptionToken(resolved?.value)) return resolved.value
  } catch {
    // fall through to the canonical store
  }
  const store = await readClaudeStore()
  return isSubscriptionToken(store?.oauth?.accessToken) ? store.oauth.accessToken : undefined
}

/* ── provider profile ─────────────────────────────────────────────────────── */

/**
 * Create the `anthropic-account` profile when the composition has none, or
 * replace its model list when discovery reports a different one.
 * @param {object} ctx injected Host context carrying `settings`.
 * @param {{providerId: string, refName: string}} names route and reference.
 * @param {Array<object>|undefined} models discovered models, or undefined to use the fallback.
 * @returns {Promise<{provisioned: boolean, modelsChanged?: boolean, error?: string}>}
 */
async function provisionProvider(ctx, names, models) {
  const wanted = Array.isArray(models) && models.length > 0 ? models : FALLBACK_MODELS
  const existing = findProfile(ctx, names.providerId)

  if (existing !== undefined) {
    const current = Array.isArray(existing.models) ? existing.models : []
    if (models === undefined) {
      return { provisioned: existing.apiKeyEnv === names.refName || existing.apiKeyEnv === undefined, modelsChanged: false }
    }
    const changed = !sameModels(current, wanted)
    if (changed) {
      const error = await writeProfile(ctx, [{ op: 'set', path: ['providers', names.providerId, 'models'], value: wanted }], names.providerId, undefined)
      return error === undefined ? { provisioned: true, modelsChanged: true } : { provisioned: true, modelsChanged: false, error }
    }
    if (existing.apiKeyEnv === undefined || existing.apiKeyEnv === '') {
      const error = await writeProfile(ctx, [{ op: 'set', path: ['providers', names.providerId, 'apiKeyEnv'], value: names.refName }], names.providerId, undefined)
      return { provisioned: error === undefined, modelsChanged: false, error }
    }
    if (existing.apiKeyEnv !== names.refName) {
      return { provisioned: true, modelsChanged: false, error: `the profile resolves its own reference "${existing.apiKeyEnv}"` }
    }
    return { provisioned: true, modelsChanged: false }
  }

  const profile = {
    displayName: 'Anthropic-account',
    api: 'anthropic-messages',
    baseURL: CLAUDE_API_BASE,
    apiKeyEnv: names.refName,
    models: wanted.map((model) => ({ ...model, input: [...model.input] })),
    defaultInput: ['text', 'image'],
  }
  const error = await writeProfile(ctx, [{ op: 'set', path: ['providers', names.providerId], value: profile }], names.providerId, profile)
  return error === undefined ? { provisioned: true, modelsChanged: true } : { provisioned: false, modelsChanged: false, error }
}

/** Read one provider profile out of the live settings form, or undefined. */
function findProfile(ctx, providerId) {
  try {
    const settings = ctx.get('settings')
    const form = settings?.describe?.().find((entry) => entry.ns === PI_NS)
    return form?.value?.providers?.[providerId]
  } catch {
    return undefined
  }
}

/**
 * Apply path edits to the pi-ai settings section. Falls back to the config
 * editor when the settings plane refuses the write, and reports the diagnostic
 * instead of throwing so the rest of the bootstrap still runs.
 * @returns {Promise<string | undefined>} the failure text, or undefined.
 */
async function writeProfile(ctx, ops, providerId, wholeProfile) {
  const settings = ctx.get('settings')
  if (settings !== undefined) {
    let failure
    const outcome = await outsideExecution(ctx, async () => {
      try {
        await settings.mutate(PI_NS, ops, undefined)
        return undefined
      } catch (error) {
        failure = messageOf(error)
        return 'failed'
      }
    })
    if (outcome !== 'failed') return undefined
    const editor = ctx.get('configEditor')
    if (editor === undefined || wholeProfile === undefined) return failure
    return await outsideExecution(ctx, () => editEntryConfig(editor, providerId, wholeProfile))
  }
  const editor = ctx.get('configEditor')
  if (editor === undefined || wholeProfile === undefined) return 'this composition mounts no settings service'
  return await outsideExecution(ctx, () => editEntryConfig(editor, providerId, wholeProfile))
}

/**
 * Run one configuration write outside the Loader/HMR transaction that is still
 * the ambient async context of this plugin's activation. HMR's exclusive queue
 * refuses a nested write ("HMR transactions cannot be nested"), and an
 * `AsyncLocalStorage` store follows every timer and promise created inside it,
 * so waiting is not enough — the call has to leave the store explicitly.
 * @template T
 * @param {object} ctx Host context, possibly carrying `hmr`.
 * @param {() => Promise<T>} operation the write to perform.
 * @returns {Promise<T>}
 */
function outsideExecution(ctx, operation) {
  try {
    const store = ctx.get('hmr')?.executing
    if (store !== undefined && typeof store.exit === 'function') return store.exit(operation)
  } catch {
    // A missing HMR service simply means no transaction to escape.
  }
  return operation()
}

/** Persist one provider profile through the config editor as a last resort. */
async function editEntryConfig(editor, providerId, profile) {
  try {
    const entry = editor.entries().find((row) => row.options.id === PI_NS)
    if (entry === undefined) return `no "${PI_NS}" configuration entry`
    await editor.edit(entry, (current) => ({
      ...current,
      providers: { ...(current.providers ?? {}), [providerId]: profile },
    }))
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/* ── Claude subscription token ────────────────────────────────────────────── */

/**
 * Mirror a Claude Code subscription access token into the credential reference
 * the provider profile resolves, refreshing the canonical store first when the
 * token is about to expire.
 * @param {object} ctx injected Host context carrying `credentials`.
 * @param {{refName: string, force: boolean, refreshClaudeCode: boolean, remember: Function, lastMirrored: Function}} options flow switches.
 * @returns {Promise<{ok: boolean, mirrored?: boolean, refreshed?: boolean, store?: string, source?: string, expiresAt?: number, reason?: string}>}
 */
async function mirrorClaudeToken(ctx, options) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return { ok: false, reason: 'no credentials service' }

  const store = await readClaudeStore()
  if (store === undefined) return { ok: false, reason: 'no Claude Code credential store found' }

  let oauth = store.oauth
  let source = store.describe
  let refreshed = false

  if ((needsRefresh(oauth, Date.now()) || options.force) && options.refreshClaudeCode && typeof oauth.refreshToken === 'string') {
    try {
      const next = await refreshClaudeToken(oauth.refreshToken)
      oauth = { ...oauth, ...next }
      await writeClaudeStore(store, oauth)
      source = `${store.describe} (refreshed)`
      refreshed = true
    } catch (error) {
      // A refresh failure is not fatal while the access token is still valid.
      if (needsRefresh(oauth, Date.now())) return { ok: false, reason: `refresh failed: ${messageOf(error)}` }
    }
  }

  if (!isSubscriptionToken(oauth.accessToken)) {
    return { ok: false, reason: 'the stored Claude token is not a subscription (sk-ant-oat) token' }
  }

  const alreadyMirrored = options.lastMirrored() === oauth.accessToken
  if (!alreadyMirrored) {
    await credentials.set(options.refName, oauth.accessToken)
    options.remember(oauth.accessToken)
  }
  return {
    ok: true,
    mirrored: !alreadyMirrored,
    refreshed,
    store: store.kind,
    source,
    expiresAt: Number(oauth.expiresAt) || undefined,
  }
}

/**
 * Locate and parse the canonical Claude Code credential store.
 *
 * macOS keeps the grant in the login Keychain; every other platform (and macOS
 * when the Keychain holds nothing usable) keeps it in
 * `<configDir>/.credentials.json`, where `configDir` is `$CLAUDE_CONFIG_DIR` or
 * `~/.claude`. Both shapes are the same JSON document, so the readers differ
 * only in how the bytes are obtained.
 * @returns {Promise<{kind: 'file'|'keychain', describe: string, path?: string, service?: string, account?: string, document: object, oauth: object} | undefined>}
 */
async function readClaudeStore() {
  const configDirs = claudeConfigDirs({ env: process.env, home: homedir() })
  if (process.platform === 'darwin') {
    for (const service of keychainServiceNames(configDirs)) {
      const blob = await readKeychainSecret(service)
      if (blob === undefined) continue
      const parsed = parseClaudeDocument(blob)
      if (parsed === undefined) continue
      return {
        kind: 'keychain',
        describe: `keychain:${service.replace('Claude Code-credentials', 'claude-code')}`,
        service,
        account: await keychainAccountName(service),
        document: parsed.document,
        oauth: parsed.oauth,
      }
    }
  }
  for (const directory of configDirs) {
    const path = join(directory, '.credentials.json')
    try {
      const parsed = parseClaudeDocument(await readFile(path, 'utf8'))
      if (parsed !== undefined) {
        return { kind: 'file', describe: 'claude-code', path, document: parsed.document, oauth: parsed.oauth }
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/**
 * Read one Keychain generic password with the `security` CLI.
 * @param {string} service service name.
 * @returns {Promise<string | undefined>} the secret, or undefined when absent or unreadable.
 */
async function readKeychainSecret(service) {
  try {
    // `execFile` (never a shell) keeps the service name an argument, not code.
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    })
    const value = stdout.trim()
    return value.length > 0 ? value : undefined
  } catch {
    // 44 = item not found, 36 = locked keychain, 128 = denied: all answer "nothing usable here".
    return undefined
  }
}

/**
 * The account name attached to a Keychain generic password, required to update
 * the item in place. `security find-generic-password -s <service>` reports it as
 * `"acct"<blob>="…"`.
 * @param {string} service service name.
 * @returns {Promise<string>} the account, falling back to the OS user.
 */
async function keychainAccountName(service) {
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service], {
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    })
    const match = /"acct"<blob>="([^"]*)"/u.exec(stdout)
    if (match !== null && match[1].length > 0) return match[1]
  } catch {
    // fall through to the OS user
  }
  return process.env.USER ?? process.env.LOGNAME ?? 'claude'
}

/**
 * Write rotated tokens back to the store the grant came from, preserving every
 * sibling key. The file path renames atomically; the Keychain path updates the
 * existing item in place (`-U`) so Claude Code keeps reading the same entry.
 * @param {object} store the store `readClaudeStore()` returned.
 * @param {object} oauth the rotated grant fields.
 */
async function writeClaudeStore(store, oauth) {
  const next = { ...store.document, claudeAiOauth: { ...store.document.claudeAiOauth, ...oauth } }
  const text = `${JSON.stringify(next, null, 2)}\n`
  if (store.kind === 'keychain') {
    await execFileAsync(
      'security',
      ['add-generic-password', '-U', '-s', store.service, '-a', store.account ?? 'claude', '-w', text],
      { timeout: 6_000, maxBuffer: 1024 * 1024 },
    )
    return
  }
  const path = store.path
  if (typeof path !== 'string') throw new Error('credential store has no path')
  const temporary = `${path}.anthropic-account.tmp`
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Exchange a Claude Code refresh token for a fresh grant.
 *
 * Two token endpoints exist for the same grant. The `claude.ai` one answers a
 * form-encoded `refresh_token` request and is the endpoint the Claude Code
 * account integration itself uses; `platform.claude.com` expects JSON. Probing
 * both with an invalid token distinguishes them cleanly (`invalid_grant` versus
 * a rate-limit or route error), so the proven one is tried first and the other
 * stays as a fallback.
 * @param {string} refreshToken the stored refresh token.
 * @returns {Promise<object>} the rotated token fields.
 */
async function refreshClaudeToken(refreshToken) {
  const attempts = [
    {
      url: CLAUDE_REFRESH_URL,
      request: () => ({
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLAUDE_CLIENT_ID,
          refresh_token: refreshToken,
        }).toString(),
      }),
    },
    {
      url: CLAUDE_TOKEN_URL,
      request: () => ({
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: CLAUDE_CLIENT_ID,
          refresh_token: refreshToken,
        }),
      }),
    },
  ]

  let lastFailure
  for (const attempt of attempts) {
    const request = attempt.request()
    let response
    try {
      response = await fetch(attempt.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
    } catch (error) {
      lastFailure = `${attempt.url}: ${messageOf(error)}`
      continue
    }
    const text = await response.text()
    if (!response.ok) {
      // A refused grant is terminal: another endpoint cannot revive it.
      if (response.status === 400 && /invalid_grant/u.test(text)) {
        throw new Error(`invalid_grant: ${text.slice(0, 200)}`)
      }
      lastFailure = `${attempt.url}: HTTP ${response.status} ${text.slice(0, 160)}`
      continue
    }
    let data
    try {
      data = JSON.parse(text)
    } catch (error) {
      lastFailure = `${attempt.url}: invalid JSON (${messageOf(error)})`
      continue
    }
    return grantFromTokenResponse(data, refreshToken, Date.now())
  }
  throw new Error(lastFailure ?? 'no token endpoint answered')
}

/* ── Codex grant repair ───────────────────────────────────────────────────── */

/**
 * Turn `~/.codex/auth.json` into the `llm-pi-ai/openai-codex` credential record
 * the shipped provider reads. A healthy stored grant always wins: the Codex CLI
 * rotates refresh tokens, so replaying an older file over a newer grant would
 * break the connection this repair is meant to restore.
 * @param {object} ctx injected Host context carrying `credentials`.
 * @returns {Promise<{ok: boolean, imported?: boolean, reason?: string}>}
 */
async function repairCodexGrant(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return { ok: false, reason: 'no credentials service' }

  let document
  try {
    document = JSON.parse(await readFile(join(homedir(), '.codex', 'auth.json'), 'utf8'))
  } catch {
    return { ok: false, reason: 'no ~/.codex/auth.json' }
  }
  const built = buildCodexGrant(document, Date.now())
  if (built === undefined) return { ok: false, reason: 'no access token in ~/.codex/auth.json' }

  const key = 'llm-pi-ai/openai-codex'
  const current = await readRecord(credentials, key)
  const payload = current?.kind === 'grant' ? current.payload : undefined
  if (payload?.access === built.payload.access) return { ok: true, imported: false }
  if (isHealthyCodexGrant(payload, Date.now())) {
    return { ok: true, imported: false, reason: 'a newer stored Codex grant is already valid' }
  }

  await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: built.payload }))
  return { ok: true, imported: true }
}

/** Read one credential record without letting an absent service throw. */
async function readRecord(credentials, key) {
  try {
    return await credentials.readRecord(key)
  } catch {
    return undefined
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Await while keeping the Host free to settle its own transactions. */
function sleep(ms) {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms)
    if (typeof handle?.unref === 'function') handle.unref()
  })
}

/** Config hours to milliseconds, clamped to a sane interval. */
function hoursToMs(hours, fallbackHours) {
  const value = Number(hours)
  const effective = Number.isFinite(value) && value > 0 ? value : fallbackHours
  return Math.min(Math.max(effective * 3_600_000, 60_000), 7 * 24 * 3_600_000)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
