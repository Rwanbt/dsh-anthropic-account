/**
 * Loader shim for the Anthropic-account bundle.
 *
 * Cordis caches an imported plugin module, so editing `logic.js` alone would
 * only take effect after an application restart. Resolving the implementation
 * through its modification time keeps a profile re-apply (disable/enable in the
 * Plugins page) enough to pick up a new build, which is what makes this bundle
 * iterable without restarting the desktop app.
 *
 * The module is imported once per apply and delegates every registration to it;
 * the shim itself holds no state.
 */

import { statSync } from 'node:fs'

const logicUrl = new URL('./logic.js', import.meta.url)

export function apply(ctx, config = {}) {
  let revision = '0'
  try {
    revision = String(Math.round(statSync(logicUrl).mtimeMs))
  } catch {
    // An unreadable timestamp only costs caching, not correctness.
  }
  const url = new URL(`./logic.js?v=${revision}`, import.meta.url)
  void import(url.href)
    .then((module) => module.apply(ctx, config))
    .catch((error) => {
      try {
        ctx.logger?.warn?.('anthropic-account: implementation module failed to load')
        ctx.logger?.warn?.(error)
      } catch {
        // logging must never break the host
      }
    })
}
