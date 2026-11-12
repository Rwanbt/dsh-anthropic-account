// Security policy checks over the shipped sources.
//
// These are source-level assertions, not behaviour tests: they make the plugin's
// safety properties reviewable and keep a future edit from quietly removing one
// (a shell invocation, an unexpected network host, a literal credential).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_FILES = ['index.js', 'logic.js', join('lib', 'credentials.mjs'), join('lib', 'model-catalog.mjs'), join('lib', 'sign-in.mjs'), join('lib', 'status.mjs')]

/** Read the shipped runtime sources. */
async function runtimeSources() {
  const sources = []
  for (const file of RUNTIME_FILES) sources.push({ file, text: await readFile(join(ROOT, file), 'utf8') })
  return sources
}

/** Every tracked file, so the checks cover what is actually published. */
function trackedFiles() {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

test('process spawning is limited to execFile, with no shell and no eval', async () => {
  for (const { file, text } of await runtimeSources()) {
    if (text.includes("from 'node:child_process'")) {
      const named = /import \{([^}]*)\} from 'node:child_process'/u.exec(text)
      assert.ok(named !== null, `${file} imports node:child_process without named imports`)
      const names = named[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
      assert.deepEqual(names, ['execFile'], `${file} imports ${names.join(', ')} from node:child_process`)
    }
    assert.doesNotMatch(text, /execSync\s*\(/u, `${file} uses execSync()`)
    // The Host subprocess service is the only process seam; a bare Node spawn
    // stays forbidden.
    assert.doesNotMatch(text, /(?<![.\w])spawn(?:Sync)?\s*\(/u, `${file} uses a bare spawn()`)
    assert.doesNotMatch(text, /shell\s*:\s*true/u, `${file} asks for a shell`)
    assert.doesNotMatch(text, /\beval\s*\(/u, `${file} uses eval()`)
    assert.doesNotMatch(text, /new Function\s*\(/u, `${file} uses new Function()`)
    assert.doesNotMatch(text, /\brequire\s*\(/u, `${file} uses require() in an ES module`)
  }
  const logic = await readFile(join(ROOT, 'logic.js'), 'utf8')
  assert.match(logic, /promisify\(execFile\)/u, 'the Keychain reader must wrap execFile')
  assert.match(logic, /execFileAsync\(/u, 'the Keychain calls must go through execFile')
  // The in-app sign-in starts the vendor CLI through the Host subprocess
  // service, with one constant argument list that no request can influence.
  assert.match(logic, /subprocess\.spawn\(/u, 'sign-in must use the Host subprocess service')
  assert.match(logic, /const args = kind === 'claude' \? \['auth', 'login'\] : \['login', '--device-auth'\]/u,
    'the sign-in arguments must stay a constant')
  assert.match(logic, /resolveVendorCli/u, 'the sign-in must resolve the real vendor CLI')
})

test('network access is limited to the provider origins', async () => {
  const allowed = new Set([
    'api.anthropic.com',
    'claude.ai',
    'claude.com',
    'platform.claude.com',
    'auth.openai.com',
    'chatgpt.com',
    'chat.openai.com',
  ])
  for (const { file, text } of await runtimeSources()) {
    for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/gu)) {
      assert.ok(allowed.has(match[1]), `${file} reaches an unexpected host: ${match[1]}`)
    }
  }
})

test('the repository holds no literal credential shape', async () => {
  const shapes = [
    ['anthropic-oauth', /sk-ant-(?:oat|ort)[A-Za-z0-9_-]{8,}/u],
    ['anthropic-api', /sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{8,}/u],
    ['openai-key', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u],
    ['github-token', /gh[pousr]_[A-Za-z0-9]{20,}/u],
    ['aws-key', /\bAKIA[0-9A-Z]{16}\b/u],
    ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/u],
  ]
  const files = trackedFiles()
  assert.ok(files.length > 0, 'git ls-files returned nothing; run the tests from a checkout')
  for (const file of files) {
    let text
    try {
      text = await readFile(join(ROOT, file), 'utf8')
    } catch {
      continue // binary asset
    }
    for (const [name, pattern] of shapes) {
      assert.doesNotMatch(text, pattern, `${file} contains a ${name} shape`)
    }
  }
})

test('the status document is redacted before it is written', async () => {
  const logic = await readFile(join(ROOT, 'logic.js'), 'utf8')
  assert.match(logic, /from '\.\/lib\/status\.mjs'/u)
  const writeStatus = /async function writeStatus\(status\)\s*\{[\s\S]*?\n\}/u.exec(logic)
  assert.ok(writeStatus !== null, 'writeStatus not found')
  assert.match(writeStatus[0], /redactCredentialMaterial/u, 'writeStatus must redact before writing')
})

test('the Claude Code store is written owner-only and atomically', async () => {
  const logic = await readFile(join(ROOT, 'logic.js'), 'utf8')
  assert.match(logic, /mode:\s*0o600/u, 'the credential file must be written with owner-only permissions')
  assert.match(logic, /rename\(temporary, path\)/u, 'the credential file must be replaced atomically')
})

test('credentials are written to the credential plane, not to configuration', async () => {
  const logic = await readFile(join(ROOT, 'logic.js'), 'utf8')
  // A token may only reach `credentials.set`/`modifyRecord`, never a settings write.
  const settingsWrites = [...logic.matchAll(/writeProfile\(ctx, \[([\s\S]*?)\], names\.providerId/gu)].map((match) => match[1])
  assert.ok(settingsWrites.length > 0, 'expected the provider profile writes')
  for (const write of settingsWrites) {
    assert.doesNotMatch(write, /accessToken|refreshToken|oauth\.|token\b/u, 'a settings write must not carry credential material')
  }
})

test('the shipped file set contains no unexpected executable code', async () => {
  const files = trackedFiles()
  assert.ok(files.length > 0)
  for (const file of files) {
    assert.doesNotMatch(file, /\.(exe|dll|node|so|dylib|sh|bat|cmd|ps1)$/iu, `unexpected executable in the bundle: ${file}`)
  }
})

test('lib helpers import only node builtins', async () => {
  for (const file of await readdir(join(ROOT, 'lib'))) {
    const text = await readFile(join(ROOT, 'lib', file), 'utf8')
    for (const match of text.matchAll(/from\s+'([^']+)'/gu)) {
      assert.ok(match[1].startsWith('node:') || match[1].startsWith('./'), `${file} imports ${match[1]}`)
    }
  }
})
