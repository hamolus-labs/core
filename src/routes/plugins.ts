/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { Hono } from 'hono'
import type { AuthTokenPayload } from '@hamolus/types'
import type { Env } from '../env'
import { badRequest, notFound } from '../errors'
import { requireRead, requireWrite } from '../auth/session'
import { resolveRequestScope } from '../scope'

/**
 * Plugin application data lives in the shared SETTINGS KV namespace under a
 * strict per-land, per-plugin prefix (`plugin:{land}:{plugin}:`). The console's
 * built-in plugins (todo, kanban) use these routes as their persistence layer —
 * a plugin may store any JSON value under a simple key (e.g. `item:a1b2c3`).
 *
 * Permissions mirror the settings surface: reads require `settings.read`,
 * writes require `settings.write` (the `settings.read` grant is universal).
 */
const PLUGIN_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const PLUGIN_KEY_RE = /^[a-zA-Z0-9._:-]+$/

function pluginPrefix(land: string, colony: string, plugin: string): string {
  return `plugin:${land}:${colony}:${plugin}:`
}

function parseValue(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function validatePlugin(plugin: string): string {
  if (!PLUGIN_ID_RE.test(plugin)) throw badRequest('Invalid plugin id')
  return plugin
}

function validateKey(key: string): string {
  if (!PLUGIN_KEY_RE.test(key)) throw badRequest('Invalid plugin key')
  return key
}

export const pluginRoutes = new Hono<{ Bindings: Env }>()

/** List every entry stored under a plugin's prefix. */
pluginRoutes.get('/:plugin', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'settings.read')
  const scope = await resolveRequestScope(c)
  const plugin = validatePlugin(c.req.param('plugin'))
  const prefix = pluginPrefix(scope.land, scope.colony, plugin)
  const { keys } = await c.env.SETTINGS.list({ prefix })
  const entries = []
  for (const k of keys) {
    const raw = await c.env.SETTINGS.get(k.name)
    entries.push({ key: k.name.slice(prefix.length), value: parseValue(raw) })
  }
  return c.json({ data: entries })
})

/** Read one plugin entry; 404 when the key does not exist. */
pluginRoutes.get('/:plugin/:key', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'settings.read')
  const scope = await resolveRequestScope(c)
  const plugin = validatePlugin(c.req.param('plugin'))
  const key = validateKey(c.req.param('key'))
  const raw = await c.env.SETTINGS.get(pluginPrefix(scope.land, scope.colony, plugin) + key)
  if (raw === null) throw notFound('Plugin entry not found')
  return c.json({ data: parseValue(raw) })
})

/** Create or replace a plugin entry. The body may be any JSON value. */
pluginRoutes.put('/:plugin/:key', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'settings.write')
  const scope = await resolveRequestScope(c)
  const plugin = validatePlugin(c.req.param('plugin'))
  const key = validateKey(c.req.param('key'))
  const body = (await c.req.json().catch(() => null)) as unknown
  await c.env.SETTINGS.put(pluginPrefix(scope.land, scope.colony, plugin) + key, JSON.stringify(body))
  return c.json({ data: body })
})

/** Delete one plugin entry. */
pluginRoutes.delete('/:plugin/:key', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'settings.write')
  const scope = await resolveRequestScope(c)
  const plugin = validatePlugin(c.req.param('plugin'))
  const key = validateKey(c.req.param('key'))
  await c.env.SETTINGS.delete(pluginPrefix(scope.land, scope.colony, plugin) + key)
  return c.body(null, 204)
})