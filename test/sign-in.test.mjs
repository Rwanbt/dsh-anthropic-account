// Sign-in contract: the CLI output parsers, the pasted-code rules, the openable
// URL allowlist, and the state machine the settings page renders.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FLOW_TIMEOUT_MS,
  createSignInManager,
  isValidCode,
  openableUrl,
  parseClaudeAuthorizeUrl,
  parseCodexDevice,
  redactDiagnostic,
  stripAnsi,
} from '../lib/sign-in.mjs'

const CLAUDE_OUT = [
  'Opening browser to sign in…',
  'If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz',
  'Paste code here if prompted > ',
].join('\n')

const CODEX_OUT = [
  'Welcome to Codex [v0.144.1]',
  '1. Open this link in your browser and sign in to your account',
  '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
  '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
  '   \u001b[94mE4JM-MVTCB\u001b[0m',
].join('\n')

function fakeSession() {
  let pending = ''
  let resolveDone
  const writes = []
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  return {
    writes,
    write: (text) => writes.push(text),
    read: () => {
      const text = pending
      pending = ''
      return text
    },
    feed: (text) => {
      pending += text
    },
    done,
    terminate: () => {},
    finish: (exitCode) => resolveDone({ exitCode, signal: null }),
    fail: (error) => resolveDone(Promise.reject(error)),
  }
}

function fakeTimers() {
  const handles = {}
  return {
    handles,
    setIntervalFn: (fn) => {
      handles.poll = fn
      return 1
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (fn) => {
      handles.deadline = fn
      return 2
    },
    clearTimeoutFn: () => {},
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('stripAnsi removes the color codes the CLIs print', () => {
  assert.equal(stripAnsi('\u001b[94mhttps://x.test\u001b[0m'), 'https://x.test')
  assert.equal(stripAnsi('plain'), 'plain')
  assert.equal(stripAnsi(null), '')
})

test('parseClaudeAuthorizeUrl finds the subscription authorize page', () => {
  assert.equal(
    parseClaudeAuthorizeUrl(CLAUDE_OUT),
    'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz',
  )
  assert.equal(parseClaudeAuthorizeUrl('nothing here'), undefined)
})

test('parseCodexDevice finds the device URL and its one-time code', () => {
  assert.deepEqual(parseCodexDevice(CODEX_OUT), {
    url: 'https://auth.openai.com/codex/device',
    code: 'E4JM-MVTCB',
  })
  assert.deepEqual(parseCodexDevice('nothing here'), { url: undefined, code: undefined })
})

test('isValidCode accepts printable single-line codes only', () => {
  assert.equal(isValidCode('abcdefgh'), true)
  assert.equal(isValidCode('  abcdefgh  '), true)
  assert.equal(isValidCode('abc'), false)
  assert.equal(isValidCode('bad code'), false)
  assert.equal(isValidCode('bad\ncode'), false)
  assert.equal(isValidCode(undefined), false)
  assert.equal(isValidCode('x'.repeat(4097)), false)
})

test('openableUrl only allows the vendor sign-in hosts over https', () => {
  assert.equal(openableUrl('https://claude.com/cai/oauth/authorize?x=1'), 'https://claude.com/cai/oauth/authorize?x=1')
  assert.equal(openableUrl('https://auth.openai.com/codex/device'), 'https://auth.openai.com/codex/device')
  assert.equal(openableUrl('http://claude.com/x'), undefined)
  assert.equal(openableUrl('https://evil.example/x'), undefined)
  assert.equal(openableUrl('file:///etc/passwd'), undefined)
  assert.equal(openableUrl('javascript:alert(1)'), undefined)
  assert.equal(openableUrl(undefined), undefined)
})

test('redactDiagnostic removes tokens and URLs from a failure message', () => {
  const token = ['sk-ant', 'oat01', 'abcdefghijk'].join('-')
  const text = redactDiagnostic(`failed with ${token} and https://claude.com/x?y=1`)
  assert.doesNotMatch(text, /sk-ant-oat/u)
  assert.doesNotMatch(text, /claude\.com/u)
  assert.match(text, /\[redacted\]/u)
})

test('the manager exposes the authorize URL and accepts the pasted code', async () => {
  const session = fakeSession()
  const timers = fakeTimers()
  let connected = 0
  const manager = createSignInManager({
    launch: () => session,
    onClaudeConnected: async () => {
      connected += 1
    },
    ...timers,
  })

  await manager.start('claude')
  assert.equal(manager.status().claude.state, 'starting')
  assert.equal(manager.status().claude.error, undefined)

  session.feed(CLAUDE_OUT)
  timers.handles.poll()
  assert.equal(manager.status().claude.state, 'awaiting-code')
  assert.equal(
    manager.status().claude.url,
    'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz',
  )

  assert.equal(manager.submitClaudeCode('bad code').ok, false)
  assert.equal(manager.submitClaudeCode('abcdefgh-1234').ok, true)
  assert.deepEqual(session.writes, ['abcdefgh-1234\n'])
  assert.equal(manager.status().claude.state, 'finishing')

  session.finish(0)
  await flush()
  assert.equal(manager.status().claude.state, 'connected')
  assert.equal(connected, 1)
})

test('a failed attempt reports a friendly, redacted error', async () => {
  const session = fakeSession()
  const timers = fakeTimers()
  const manager = createSignInManager({ launch: () => session, ...timers })

  await manager.start('codex')
  session.feed(CODEX_OUT)
  timers.handles.poll()
  assert.equal(manager.status().codex.state, 'awaiting-approval')
  assert.equal(manager.status().codex.code, 'E4JM-MVTCB')

  session.feed("'codex' is not recognized as an internal or external command")
  timers.handles.poll()
  session.finish(1)
  await flush()
  assert.equal(manager.status().codex.state, 'error')
  assert.match(manager.status().codex.error, /introuvable/u)
})

test('a pasted wrong Claude code returns the flow to the code step', async () => {
  const session = fakeSession()
  const timers = fakeTimers()
  const manager = createSignInManager({ launch: () => session, ...timers })

  await manager.start('claude')
  session.feed(CLAUDE_OUT)
  timers.handles.poll()
  manager.submitClaudeCode('wrongcode-123')
  session.feed('Invalid code. Please make sure the full code was copied.\nPaste code here if prompted > ')
  timers.handles.poll()
  assert.equal(manager.status().claude.state, 'awaiting-code')
  assert.match(manager.status().claude.error, /Code invalide/u)
})

test('the deadline kills the attempt', async () => {
  const session = fakeSession()
  const timers = fakeTimers()
  const manager = createSignInManager({ launch: () => session, timeoutMs: FLOW_TIMEOUT_MS, ...timers })

  await manager.start('claude')
  timers.handles.deadline()
  assert.equal(manager.status().claude.state, 'error')
  assert.match(manager.status().claude.error, /Délai dépassé/u)
})

test('a launch failure is reported with its own message', async () => {
  const timers = fakeTimers()
  const manager = createSignInManager({
    launch: async () => {
      throw new Error('Claude Code introuvable : aucun exécutable « claude » valide dans le PATH.')
    },
    ...timers,
  })

  await manager.start('claude')
  assert.equal(manager.status().claude.state, 'error')
  assert.match(manager.status().claude.error, /introuvable/u)
})

test('cancel returns a flow to idle', async () => {
  const session = fakeSession()
  const timers = fakeTimers()
  const manager = createSignInManager({ launch: () => session, ...timers })

  await manager.start('codex')
  manager.cancel('codex')
  assert.equal(manager.status().codex.state, 'idle')
  assert.equal(manager.status().codex.url, undefined)
})
