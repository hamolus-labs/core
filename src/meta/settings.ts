/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import type { KVNamespace } from '@cloudflare/workers-types'
import { COLONY_DEFAULT, LAND_DEFAULT } from '@hamolus/types'

const LEGACY_SETTINGS_KEY = 'settings:v1'

export function settingsKey(land: string, colony: string = COLONY_DEFAULT): string {
  const l = land || LAND_DEFAULT
  const c = colony || COLONY_DEFAULT
  // The root scope keeps the legacy `settings:v1` key so pre-scope blobs keep
  // working untouched.
  if (l === LAND_DEFAULT && c === COLONY_DEFAULT) return LEGACY_SETTINGS_KEY
  return `settings:${l}:${c}:v1`
}

/**
 * Settings are stored as a single JSON blob in Cloudflare KV, keyed per scope
 * (`settings:{land}:{colony}:v1`). The root scope keeps the legacy `settings:v1`
 * key so pre-scope blobs keep working untouched.
 * Shape is free-form — see docs/settings.md for the recommended structure.
 */
export async function getSettings(
  kv: KVNamespace,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<Record<string, unknown>> {
  try {
    const raw = await kv.get(settingsKey(land, colony))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Merges `patch` over the current settings (shallow top-level merge) and persists. */
export async function putSettings(
  kv: KVNamespace,
  patch: Record<string, unknown>,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<Record<string, unknown>> {
  const current = await getSettings(kv, land, colony)
  const merged = { ...current, ...patch }
  await kv.put(settingsKey(land, colony), JSON.stringify(merged))
  return merged
}