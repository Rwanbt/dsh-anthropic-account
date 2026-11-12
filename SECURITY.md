# Security policy

## What this plugin touches

| Data | Where it comes from | Where it goes |
|---|---|---|
| Claude subscription access/refresh token | the Claude Code credential store: login Keychain on macOS, `<configDir>/.credentials.json` elsewhere | the Harness credential plane (`ANTHROPIC_ACCOUNT_OAUTH` reference), and back into the same store after a refresh |
| Codex subscription tokens | `~/.codex/auth.json` | the `llm-pi-ai/openai-codex` credential record |
| Model catalog | `GET https://api.anthropic.com/v1/models` | the `llm-pi-ai` provider profile (ids, names, capacities only) |
| Sign-in attempt | the vendor CLI output and the authorization code you paste | kept in memory for the attempt only; never written to disk, configuration, or logs |
| Diagnostics | the plugin itself | `~/.dsh/anthropic-account-status.json`, redacted |

**Network destinations fetched by the plugin are limited to `api.anthropic.com`,
`claude.ai` and `platform.claude.com`.** The sign-in panel only *opens* the vendor pages
(`claude.com`, `auth.openai.com`, `chatgpt.com`) in your default browser after an allowlist
check; it never fetches them from the Host. There is no telemetry, no relay, no analytics
endpoint, and no update check. Tests assert both allowlists over the shipped sources.

## Guarantees enforced by the test suite

`npm test` runs 81 deterministic checks, including source-level policy assertions:

- **No shell injection and no bare spawn.** The in-app sign-in starts the vendor CLI through the
  Harness subprocess service with one constant command line; nothing from a request is
  interpolated. The sources import `execFile` only — never `exec`, `execSync`, a bare Node
  `spawn`, `shell: true`, `eval` or `new Function`. Keychain values are passed as arguments, so a
  service name can never become shell code.
- **No literal credentials in the repository.** Every tracked file is scanned for Anthropic,
  OpenAI, GitHub, AWS and JWT shapes; test fixtures are assembled at runtime for this reason.
- **The status document is redacted** through `redactCredentialMaterial` before every write.
- **Credential files are written owner-only (`0600`) and replaced atomically** (temp file +
  rename), so a crash cannot leave a truncated credential behind.
- **Secrets never reach configuration.** The only settings writes are the provider profile
  (route id, endpoint, credential *reference*, model list); a test inspects those writes for
  token material.
- **No third-party runtime dependency.** Nothing to compromise, nothing to pin, no install
  script. `dependencies`, `devDependencies` and `peerDependencies` are asserted empty.

## What is not covered by tests

The impure edges — Keychain reads through `security`, file reads, HTTP calls, settings mutation, vendor-CLI discovery through `where`/`which`, and opening a vendor page through the platform opener — are exercised against the real environment manually rather than in CI, because they require a Harness, a signed-in CLI, or a subscription. The pure rules those edges delegate to (parsing, naming, expiry, refresh decision, catalog reduction, redaction) are fully covered, and the unit suite runs on Linux, macOS and Windows in CI.

## Reporting

Open a private security advisory on GitHub
(<https://github.com/Rwanbt/dsh-anthropic-account/security/advisories/new>) rather than a public
issue. Please include the version, the platform, and the smallest reproduction you have.

## Scope

The plugin reuses an existing Claude Code session and can start the vendor CLIs from the settings
panel. It does not store your password, does not implement the OAuth exchange itself, and cannot
read anything outside the paths listed above. Everything the panel learns about an attempt (the
authorize URL, the one-time code, the pasted authorization code) lives in process memory for that
attempt only. Anything that changes those properties is in scope for a report.
