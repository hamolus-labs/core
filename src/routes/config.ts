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
import { configEntrySchema, configListQuerySchema } from '@hamolus/types'
import type { Env } from '../env'
import { createDb } from '../db/client'
import { badRequest } from '../errors'
import { deleteConfig, getConfig, listConfigs, putConfig } from '../auth/config'
import { requireSession, requireWrite } from '../auth/session'
import { resolveRequestScope } from '../scope'

export const configRoutes = new Hono<{ Bindings: Env }>()

/** List key/value configuration entries (optional `?scope=` filter). Session required. */
configRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'config.read')
  const parsed = configListQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()))
  if (!parsed.success) throw badRequest('Invalid query: ' + parsed.error.issues.map((i) => i.message).join('; '), 'INVALID_QUERY')
  const scope = await resolveRequestScope(c)
  const entries = await listConfigs(db, parsed.data.scope, scope.land, scope.colony)
  return c.json({ data: entries })
})

/** Read a single config entry. Session required. */
configRoutes.get('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'config.read')
  const scope = await resolveRequestScope(c)
  const entry = await getConfig(db, c.req.param('key'), scope.land, scope.colony)
  return c.json({ data: entry })
})

/** Upsert a config entry (`key` must match the path parameter). */
configRoutes.put('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'config.write')
  const scope = await resolveRequestScope(c)
  const key = c.req.param('key')
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw badRequest('Body must be a JSON object')
  if (body.key !== undefined && body.key !== key) {
    throw badRequest('Body key must match the path parameter')
  }
  const parsed = configEntrySchema.safeParse({ ...body, key })
  if (!parsed.success) {
    throw badRequest('Invalid config: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const entry = await putConfig(db, {
    key: parsed.data.key,
    value: parsed.data.value,
    scope: parsed.data.scope,
    description: parsed.data.description ?? null,
  }, scope.land, scope.colony)
  return c.json({ data: entry })
})

/** Delete a config entry. */
configRoutes.delete('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'config.write')
  const scope = await resolveRequestScope(c)
  await deleteConfig(db, c.req.param('key'), scope.land, scope.colony)
  return c.body(null, 204)
})