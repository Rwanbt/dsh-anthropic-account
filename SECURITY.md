# Security policy

## What this plugin touches

| Data | Where it comes from | Where it goes |
|---|---|---|
| Claude subscription access/refresh token | the Claude Code credential store: login Keychain on macOS, `<configDir>/.credentials.json` elsewhere | the Harness credential plane (`ANTHROPIC_ACCOUNT_OAUTH` reference), and back into the same store after a refresh |
| Codex subscription tokens | `~/.codex/auth.json` | the `llm-pi-ai/openai-codex` credential record |
| Model catalog | `GET https://api.anthropic.com/v1/models` | the `llm-pi-ai` provider profile (ids, names, capacities only) |
| Diagnostics | the plugin itself | `~/.dsh/anthropic-account-status.json`, redacted |

**Network destinations are limited to `api.anthropic.com`, `claude.ai` and
`platform.claude.com`.** There is no telemetry, no relay, no analytics endpoint, and no
update check. A test asserts this allowlist over the shipped sources.

## Guarantees enforced by the test suite

`npm test` runs 70 deterministic checks, including source-level policy assertions:

- **No shell.** Process spawning imports `execFile` only — never `exec`, `execSync`, `spawn`,
  `shell: true`, `eval` or `new Function`. Keychain values are passed as arguments, so a service
  name can never become shell code.
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

The impure edges — Keychain reads through `security`, file reads, HTTP calls, and settings
mutation — are exercised against the real environment manually rather than in CI, because they
require a Harness, a signed-in CLI, or a subscription. The pure rules those edges delegate to
(parsing, naming, expiry, refresh decision, catalog reduction, redaction) are fully covered.

## Reporting

Open a private security advisory on GitHub
(<https://github.com/Rwanbt/dsh-anthropic-account/security/advisories/new>) rather than a public
issue. Please include the version, the platform, and the smallest reproduction you have.

## Scope

The plugin deliberately reuses an existing Claude Code session. It does not implement a sign-in
flow, does not store your password, and cannot read anything outside the paths listed above.
Anything that changes those properties is in scope for a report.
