/**
 * In-app sign-in for the two subscription accounts.
 *
 * The plugin never talks OAuth itself: the vendor CLIs already own the
 * authorize/exchange/poll flows, and the account half of this bundle already
 * knows how to read their credential stores. This module turns one CLI run into
 * a small state machine a settings page can render: the authorize URL, the
 * one-time device code, and the error a failed attempt produced.
 *
 * Everything that can be decided without side effects — parsing the CLI output,
 * validating a pasted code, allowing a URL to be opened — lives in exported
 * pure functions and is unit-tested. The manager below takes an injected
 * `launch` adapter so the process half stays in `logic.js`, where the Host
 * subprocess service is available.
 *
 * @module dsh-anthropic-account/sign-in
 */

/** A sign-in attempt older than this is killed; both vendor codes expire around 15 minutes. */
export const FLOW_TIMEOUT_MS = 15 * 60 * 1000
/** How often the manager re-reads the child output. */
export const POLL_MS = 400
/** Bytes of child output retained for parsing and diagnostics. */
const MAX_OUTPUT = 64 * 1024
/** Hosts a "open the page" action may reach. */
const OPENABLE_HOSTS = new Set([
  'claude.com',
  'platform.claude.com',
  'api.anthropic.com',
  'auth.openai.com',
  'chatgpt.com',
  'chat.openai.com',
])

/** Strip ANSI SGR/CSI sequences so printed URLs and codes parse cleanly. */
export function stripAnsi(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
}

/** The Claude subscription authorize URL the CLI prints. */
export function parseClaudeAuthorizeUrl(text) {
  const match = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s"'<>]+/u.exec(stripAnsi(text))
  if (match === null) return undefined
  return match[0].replace(/[.,;)]+$/u, '')
}

/** The Codex device URL and one-time code the CLI prints. */
export function parseCodexDevice(text) {
  const clean = stripAnsi(text)
  const url = /https:\/\/auth\.openai\.com\/[^\s"'<>]+/u.exec(clean)?.[0]?.replace(/[.,;)]+$/u, '')
  const code =
    /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/u.exec(clean)?.[1] ??
    undefined
  return { url, code }
}

/**
 * Whether a pasted authorization code can be written to the CLI: printable
 * ASCII without surrounding whitespace, short enough to be one line.
 */
export function isValidCode(value) {
  if (typeof value !== 'string') return false
  const code = value.trim()
  return code.length >= 4 && code.length <= 4096 && /^[\x21-\x7e]+$/u.test(code)
}

/** The URL an "open the page" action may launch, or undefined when it is not allowlisted. */
export function openableUrl(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'https:') return undefined
    if (!OPENABLE_HOSTS.has(url.hostname.toLowerCase())) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Remove credential-shaped text from a diagnostic before it can reach a
 * response body or a log.
 */
export function redactDiagnostic(text, max = 400) {
  if (typeof text !== 'string') return ''
  const redacted = text
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/gu, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}\b/gu, '[redacted]')
    .replace(/\b(?:rt|oc|sk)-[A-Za-z0-9_-]{12,}/gu, '[redacted]')
    .replace(/https:\/\/\S+/gu, '[url]')
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted
}

/** Last meaningful lines of child output, for a failed attempt. */
function lastLines(text, count = 3) {
  const lines = stripAnsi(text)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith('>'))
  return lines.slice(-count).join(' ')
}

/** One fresh flow record. */
function blankFlow() {
  return {
    state: 'idle',
    url: undefined,
    code: undefined,
    error: undefined,
    startedAt: undefined,
    output: '',
    session: undefined,
    pollTimer: undefined,
    deadline: undefined,
    settled: false,
  }
}

/**
 * Build the sign-in manager.
 *
 * @param {object} options
 * @param {(kind: 'claude'|'codex') => {write: (text: string) => void, read: () => string, done: Promise<{exitCode: number|null, signal?: string|null}>, terminate: () => void}} options.launch starts one CLI run.
 * @param {() => Promise<void>} [options.onClaudeConnected] runs after a successful Claude login.
 * @param {() => Promise<void>} [options.onCodexConnected] runs after a successful Codex login.
 * @param {() => void} [options.onChanged] called whenever a flow state changes.
 * @param {number} [options.timeoutMs] attempt deadline.
 * @param {(startedAt: number) => number} [options.now] clock, for tests.
 * @param {Function} [options.setIntervalFn] timer injection, for tests.
 * @param {Function} [options.clearIntervalFn] timer injection, for tests.
 * @param {Function} [options.setTimeoutFn] timer injection, for tests.
 * @param {Function} [options.clearTimeoutFn] timer injection, for tests.
 * @returns {object} status, start, submitClaudeCode, cancel, dispose.
 */
export function createSignInManager(options) {
  const launch = options?.launch
  if (typeof launch !== 'function') throw new Error('sign-in: a launch adapter is required')
  const onClaudeConnected = options?.onClaudeConnected ?? (async () => {})
  const onCodexConnected = options?.onCodexConnected ?? (async () => {})
  const onChanged = options?.onChanged ?? (() => {})
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : FLOW_TIMEOUT_MS
  const now = options?.now ?? Date.now
  const setIntervalFn = options?.setIntervalFn ?? setInterval
  const clearIntervalFn = options?.clearIntervalFn ?? clearInterval
  const setTimeoutFn = options?.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options?.clearTimeoutFn ?? clearTimeout

  /** @type {{claude: ReturnType<typeof blankFlow>, codex: ReturnType<typeof blankFlow>}} */
  const flows = { claude: blankFlow(), codex: blankFlow() }

  const notify = () => {
    try {
      onChanged()
    } catch {
      // a listener must never break a flow
    }
  }

  function snapshot(kind) {
    const flow = flows[kind]
    return {
      state: flow.state,
      url: flow.url,
      code: flow.code,
      error: flow.error,
      startedAt: flow.startedAt,
    }
  }

  function status() {
    return { claude: snapshot('claude'), codex: snapshot('codex') }
  }

  function clearTimers(flow) {
    if (flow.pollTimer !== undefined) clearIntervalFn(flow.pollTimer)
    if (flow.deadline !== undefined) clearTimeoutFn(flow.deadline)
    flow.pollTimer = undefined
    flow.deadline = undefined
  }

  function observe(kind) {
    const flow = flows[kind]
    const text = flow.output
    if (text === '') return
    if (kind === 'claude') {
      if (flow.url === undefined) {
        const url = parseClaudeAuthorizeUrl(text)
        if (url !== undefined) {
          flow.url = url
          if (flow.state === 'starting') flow.state = 'awaiting-code'
          notify()
        }
      }
      if (/invalid code/i.test(text)) {
        flow.state = 'awaiting-code'
        flow.error = 'Code invalide : copiez le code entier affiché par la page.'
        notify()
      }
      return
    }
    const device = parseCodexDevice(text)
    if (device.url !== undefined && flow.url !== device.url) {
      flow.url = device.url
      notify()
    }
    if (device.code !== undefined && flow.code !== device.code) {
      flow.code = device.code
      if (flow.state === 'starting') flow.state = 'awaiting-approval'
      notify()
    }
  }

  function poll(kind) {
    const flow = flows[kind]
    if (flow.session === undefined || flow.settled) return
    try {
      const chunk = flow.session.read()
      if (typeof chunk === 'string' && chunk.length > 0) {
        flow.output = `${flow.output}${chunk}`.slice(-MAX_OUTPUT)
        observe(kind)
      }
    } catch (error) {
      flow.error = redactDiagnostic(messageOf(error))
      notify()
    }
  }

  /** Friendly text for a process that never started. */
  function spawnFailure(flow, outcome) {
    const raw = outcome instanceof Error
      ? outcome
      : outcome !== undefined && outcome !== null && typeof outcome === 'object'
        ? outcome.error
        : outcome
    const detail = raw === undefined || raw === null ? '' : messageOf(raw)
    const text = `${detail} ${flow.output}`
    if (/not recognized|not found|ENOENT|SUBPROCESS_SPAWN_NOT_FOUND/iu.test(text)) return 'commande introuvable'
    const tail = lastLines(flow.output) || lastLines(detail)
    if (tail !== '') return redactDiagnostic(tail)
    if (typeof outcome?.exitCode === 'number') return `La commande a échoué (code ${outcome.exitCode}).`
    return detail === '' ? '' : redactDiagnostic(detail)
  }

  async function settle(kind, outcome) {
    const flow = flows[kind]
    if (flow.settled) return
    flow.settled = true
    clearTimers(flow)
    // The exit can beat the poll loop; read the retained tail before judging it.
    try {
      const tail = flow.session?.read()
      if (typeof tail === 'string' && tail.length > 0) flow.output = `${flow.output}${tail}`.slice(-MAX_OUTPUT)
    } catch {
      // the output reader is best-effort after exit
    }
    flow.session = undefined
    const failed = outcome?.failed === true || (outcome?.exitCode !== 0 && outcome?.exitCode !== null)
    if (failed) {
      flow.state = 'error'
      flow.error = flow.error ?? (spawnFailure(flow, outcome) || 'La connexion a échoué ; réessayez.')
      notify()
      return
    }
    flow.state = 'finishing'
    notify()
    try {
      if (kind === 'claude') await onClaudeConnected()
      else await onCodexConnected()
      flow.state = 'connected'
      flow.error = undefined
      flow.code = undefined
      flow.url = undefined
    } catch (error) {
      flow.state = 'error'
      flow.error = redactDiagnostic(messageOf(error))
    }
    notify()
  }

  async function start(kind) {
    if (kind !== 'claude' && kind !== 'codex') throw new Error(`sign-in: unknown provider ${String(kind)}`)
    cancel(kind)
    const flow = flows[kind]
    flow.state = 'starting'
    flow.url = undefined
    flow.code = undefined
    flow.error = undefined
    flow.output = ''
    flow.settled = false
    flow.startedAt = now()
    try {
      flow.session = await launch(kind)
    } catch (error) {
      flow.state = 'error'
      flow.error = spawnFailure(flow, error)
      notify()
      return status()
    }
    const session = flow.session
    flow.pollTimer = setIntervalFn(() => poll(kind), POLL_MS)
    flow.deadline = setTimeoutFn(() => {
      if (flows[kind].settled) return
      try {
        session.terminate()
      } catch {
        // already gone
      }
      flows[kind].settled = true
      clearTimers(flows[kind])
      flow.session = undefined
      flow.state = 'error'
      flow.error = 'Délai dépassé : relancez la connexion.'
      notify()
    }, timeoutMs)
    void session.done
      .then((outcome) => settle(kind, outcome))
      .catch((error) => settle(kind, { failed: true, error }))
    notify()
    return status()
  }

  /** Write a pasted Claude authorization code to the waiting CLI. */
  function submitClaudeCode(value) {
    const flow = flows.claude
    if (flow.session === undefined) return { ok: false, error: 'Aucune connexion Claude en cours.' }
    if (!isValidCode(value)) return { ok: false, error: 'Code invalide.' }
    const code = value.trim()
    try {
      flow.session.write(`${code}\n`)
    } catch (error) {
      return { ok: false, error: redactDiagnostic(messageOf(error)) }
    }
    flow.error = undefined
    flow.state = 'finishing'
    notify()
    return { ok: true }
  }

  function cancel(kind) {
    const flow = flows[kind]
    if (flow === undefined) return
    const session = flow.session
    flow.settled = true
    clearTimers(flow)
    flow.session = undefined
    flow.state = 'idle'
    flow.url = undefined
    flow.code = undefined
    flow.error = undefined
    flow.output = ''
    if (session !== undefined) {
      try {
        session.terminate()
      } catch {
        // already gone
      }
    }
    notify()
  }

  function dispose() {
    cancel('claude')
    cancel('codex')
  }

  return { status, start, submitClaudeCode, cancel, dispose }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
