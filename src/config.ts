/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 *
 * Build-time project configuration for a generated core.
 *
 * A generated project declares its settings in `core.config.ts` at the project
 * root and hands them over at start-up:
 *
 * ```ts
 * // src/index.ts
 * import app, { setCoreConfig } from '@hamolus/core'
 * import { config } from '../core.config'
 *
 * setCoreConfig(config)
 * export default app
 * ```
 *
 * A module-level setter (rather than an `app` factory) keeps the existing
 * `export default app` contract intact, so every existing template, test and
 * deploy config that imports the app keeps working unchanged.
 *
 * Configuration is the *floor*, not the ceiling: KV settings can override it at
 * runtime, which is what lets an operator add a locale without a redeploy. When
 * settings declare localization, they win outright; when they declare nothing,
 * this file decides.
 */

import {
  defineCoreConfig,
  localeCodes,
  mergeLocalization,
  resolveLocalization,
  type CoreConfig,
  type ResolvedLocalization,
} from '@hamolus/types'

let current: CoreConfig = defineCoreConfig({})

/** Apply a generated project's config. Idempotent, so a re-import is harmless. */
export function setCoreConfig(config: CoreConfig): void {
  current = defineCoreConfig(config)
}

/** The config in effect, for tests and diagnostics. */
export function getCoreConfig(): CoreConfig {
  return current
}

/** Localization declared in `core.config.ts`, if any. */
export function configuredLocalization(): ResolvedLocalization | undefined {
  return resolveLocalization(current.localization)
}

/**
 * The project's effective localization: KV settings layered over the file config.
 *
 * Every localized-record validation and the console's language switcher go through
 * here, so a value can never be accepted by one and rejected by the other.
 */
export function effectiveLocalization(
  settings: Record<string, unknown> | null | undefined,
): ResolvedLocalization | undefined {
  return mergeLocalization(configuredLocalization(), settings?.localization)
}

/**
 * Locale codes used to validate a localized record.
 *
 * An empty list means "localization is not configured", which the collection schema
 * treats as "accept a plain string" — a project that has not opted into locales
 * must not start rejecting writes.
 */
export function effectiveLocaleCodes(
  settings: Record<string, unknown> | null | undefined,
): string[] {
  return localeCodes(effectiveLocalization(settings))
}
