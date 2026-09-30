/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

/**
 * Key/value configuration entries, one per (land, colony, key).
 *
 * A row has no classification column: the colony it lives in *is* its scope, so
 * "which scope is this?" is answered by the same registry that answers it everywhere
 * else in the core. What these routes add on top of the session's own scope is a
 * page-local `?land=` / `?colony=` selector, checked against the caller's privilege
 * before it reaches SQL — a query here is a request, never a grant.
 */

import { Hono } from 'hono'
import type { AuthTokenPayload } from '@hamolus/types'
import { configEntrySchema, configListQuerySchema } from '@hamolus/types'
import type { Env } from '../env'
import { createDb } from '../db/client'
import { badRequest } from '../errors'
import { deleteConfig, getConfig, listConfigs, putConfig } from '../auth/config'
import { requireSession, requireWrite } from '../auth/session'
import { resolveColonyTarget, resolveListTarget } from '../auth/scope-target'
import { resolveRequestScope } from '../scope'

export const configRoutes = new Hono<{ Bindings: Env }>()

type Db = ReturnType<typeof createDb>
type Query = { land?: string; colony?: string }

/** `?land=` / `?colony=`, validated for shape. Access is decided by the shared scope resolvers. */
function parseQuery(url: string): Query {
  const parsed = configListQuerySchema.safeParse(
    Object.fromEntries(new URL(url).searchParams.entries()),
  )
  if (!parsed.success) {
    throw badRequest(
      'Invalid query: ' + parsed.error.issues.map((i) => i.message).join('; '),
      'INVALID_QUERY',
    )
  }
  return parsed.data
}

/** List configuration entries, optionally narrowed to one land or one colony. */
configRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'config.read')
  const session = await resolveRequestScope(c)
  const target = await resolveListTarget(db, c.env, payload, parseQuery(c.req.url), session)
  return c.json({ data: await listConfigs(db, target) })
})

/** Read a single configuration entry out of one colony. */
configRoutes.get('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'config.read')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(
    db,
    c.env,
    payload,
    parseQuery(c.req.url),
    session,
  )
  return c.json({ data: await getConfig(db, c.req.param('key'), land, colony) })
})

/** Upsert a configuration entry in one colony (`key` must match the path parameter). */
configRoutes.put('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'config.write')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(
    db,
    c.env,
    payload,
    parseQuery(c.req.url),
    session,
  )
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
  const entry = await putConfig(
    db,
    {
      key: parsed.data.key,
      value: parsed.data.value,
      description: parsed.data.description ?? null,
    },
    land,
    colony,
  )
  return c.json({ data: entry })
})

/** Delete a configuration entry out of one colony. */
configRoutes.delete('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'config.write')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(
    db,
    c.env,
    payload,
    parseQuery(c.req.url),
    session,
  )
  await deleteConfig(db, c.req.param('key'), land, colony)
  return c.body(null, 204)
})
