// Packaging contract: what the Harness loads and what a published bundle must
// ship. These checks fail a release that would install but render wrongly.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (path) => readFile(join(ROOT, path), 'utf8')
const manifest = JSON.parse(await readText('package.json'))

test('manifest identifies a shareable Harness bundle', () => {
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'MIT')
  assert.match(manifest.name, /^[a-z0-9][a-z0-9-]*$/u)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.description.length > 40)
  assert.ok(manifest.repository.url.includes(manifest.name))
})

test('the bundle declares no third-party dependency surface', () => {
  // The plugin runs on the Harness runtime: no packages to audit or pin.
  assert.deepEqual(manifest.dependencies ?? {}, {})
  assert.deepEqual(manifest.devDependencies ?? {}, {})
  assert.deepEqual(manifest.peerDependencies ?? {}, {})
  assert.ok(Number(manifest.engines.node.replace('>=', '')) >= 20)
})

test('the patch row resolves to this package', async () => {
  const patch = await readText('cordis.patch.yml')
  assert.match(patch, new RegExp(`name: '?${manifest.name}'?`, 'u'))
  assert.match(patch, /^ {4}- id: anthropic-account$/mu)
  for (const key of ['providerId', 'credentialRef', 'provisionProvider', 'repairCodex', 'syncModels', 'modelSyncHours', 'modelsPerFamily']) {
    assert.match(patch, new RegExp(`^ {8}${key}:`, 'mu'), `patch is missing ${key}`)
  }
})

test('display metadata exists for every shipped locale', async () => {
  const locales = manifest.exports['./locale/*.json']
  assert.equal(locales, './locale/*.json')
  for (const language of ['en', 'fr']) {
    const locale = JSON.parse(await readText(`locale/${language}.json`))
    assert.equal(typeof locale.meta?.title, 'string')
    assert.ok(locale.meta.title.length > 3, `${language} title is too short`)
    assert.ok(locale.meta.description.length > 20, `${language} description is too short`)
    assert.notEqual(locale.meta.title, locale.meta.description)
  }
})

test('the icon is a small, valid SVG exported by the manifest', async () => {
  assert.equal(manifest.exports['./icon'], './icon.svg')
  const info = await stat(join(ROOT, 'icon.svg'))
  assert.ok(info.size > 0 && info.size <= 256 * 1024, 'icon must be a non-empty file under 256 KiB')
  const svg = await readText('icon.svg')
  assert.match(svg.trimStart(), /^<svg[\s>]/u)
  assert.match(svg, /<\/svg>\s*$/u)
  assert.match(svg, /viewBox="/u)
})

test('the bundle ships its settings client half', () => {
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(manifest.files.includes('client.js'), 'client.js must be published')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-models'))
})

test('every runtime file is listed in the published file set', () => {
  const files = manifest.files
  const listed = new Set(files)
  for (const required of ['index.js', 'logic.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'locale/*.json']) {
    assert.ok(listed.has(required), `package.json files is missing ${required}`)
  }
  // The entry point and its implementation must both ship.
  assert.equal(manifest.exports['.'], './index.js')
  assert.ok(listed.has('index.js') && listed.has('logic.js'))
  // Pure helpers are imported by logic.js, so they must ship too.
  assert.ok(listed.has('lib/*.mjs') || files.some((entry) => entry.startsWith('lib/')), 'lib helpers must be published')
})

test('the entry point loads the implementation through the cache-busting shim', async () => {
  const entry = await readText('index.js')
  assert.match(entry, /\.\/logic\.js/u)
  assert.match(entry, /mtimeMs|statSync/u)
  assert.match(entry, /export function apply/u)
})
