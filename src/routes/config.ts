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
import { badRequest, forbidden, notFound } from '../errors'
import { deleteConfig, getConfig, listConfigs, putConfig } from '../auth/config'
import type { ConfigTarget } from '../auth/config'
import { requireSession, requireWrite } from '../auth/session'
import { ensureLandsRegistry } from '../meta/lands'
import { resolveRequestScope } from '../scope'

export const configRoutes = new Hono<{ Bindings: Env }>()

type Db = ReturnType<typeof createDb>
type Query = { land?: string; colony?: string }

/** Narrowed to a single colony — what reading, writing or deleting one entry needs. */
interface ColonyTarget {
  land: string
  colony: string
}

/**
 * A session that may act on any land: the legacy `ADMIN_KEY` login, or a privilege
 * whose *scope* is `universe`.
 *
 * Deliberately not `role === 'admin'`: `role` carries the privilege **name**, and the
 * default colony-level role is literally called `admin`. Reading the name would hand
 * every colony administrator the whole platform — which is exactly the kind of mistake
 * that looks like a working feature right up until two tenants exist. `scope` is what
 * says how far a session reaches.
 */
function isPlatformAdmin(payload: AuthTokenPayload): boolean {
  if (payload.sub === 'admin' && !payload.permissions) return true
  return payload.scope === 'universe'
}

/**
 * The land a colony belongs to, read from the registry snapshot that the scope
 * resolver already memoizes per isolate. A colony that was never registered has no
 * owner, and configuration for a colony that does not exist is not addressable.
 */
async function ownerOfColony(db: Db, env: Env, colony: string): Promise<string> {
  const registry = await ensureLandsRegistry(db, env.SETTINGS)
  const owner = registry.ownerOf.get(colony)
  if (!owner) throw notFound(`Colony '${colony}' is not registered`)
  return owner
}

async function assertColonyInLand(db: Db, env: Env, colony: string, land: string): Promise<void> {
  const owner = await ownerOfColony(db, env, colony)
  if (owner !== land) {
    throw forbidden(`Colony '${colony}' belongs to land '${owner}', not '${land}'`)
  }
}

/**
 * How wide a config read may be. With no query this is the widest thing the session
 * can legitimately see — every land for a superadmin, the whole land for a land admin,
 * the one colony for a colony admin — so the default is never a silent guess.
 */
async function resolveListTarget(
  db: Db,
  env: Env,
  payload: AuthTokenPayload,
  query: Query,
  session: { land: string; colony: string },
): Promise<ConfigTarget> {
  if (isPlatformAdmin(payload)) {
    if (query.colony) {
      // `?land` next to `?colony` is a claim about the same row, so it has to agree
      // with the registry. Ignoring it would answer "here are land B's rows" with
      // land A's — a wrong answer that looks like a right one.
      const owner = await ownerOfColony(db, env, query.colony)
      if (query.land && query.land !== owner) {
        throw badRequest(
          `Colony '${query.colony}' belongs to land '${owner}', not '${query.land}'`,
          'SCOPE_MISMATCH',
        )
      }
      return { colony: query.colony }
    }
    if (query.land) return { land: query.land }
    return {}
  }
  if (payload.scope === 'land' && payload.land) {
    if (query.land && query.land !== payload.land) {
      throw forbidden(`Land '${query.land}' is outside this session's land '${payload.land}'`)
    }
    if (query.colony) {
      await assertColonyInLand(db, env, query.colony, payload.land)
      return { colony: query.colony }
    }
    return { land: payload.land }
  }
  if (!payload.colony) throw forbidden('This session is not bound to a colony')
  if (query.colony && query.colony !== payload.colony) {
    throw forbidden(`Colony '${query.colony}' is outside this session's colony '${payload.colony}'`)
  }
  if (query.land && query.land !== session.land) {
    throw forbidden(`Land '${query.land}' is outside this session's land '${session.land}'`)
  }
  return { colony: payload.colony }
}

/**
 * The one colony a single-entry request acts on. A land admin has to name it: a land
 * owns colonies rather than being one, and picking one for them would write their
 * configuration into a colony they never mentioned.
 */
async function resolveColonyTarget(
  db: Db,
  env: Env,
  payload: AuthTokenPayload,
  query: Query,
  session: { land: string; colony: string },
): Promise<ColonyTarget> {
  if (isPlatformAdmin(payload)) {
    const colony = query.colony ?? session.colony
    const owner = await ownerOfColony(db, env, colony)
    if (query.land && query.land !== owner) {
      throw badRequest(
        `Colony '${colony}' belongs to land '${owner}', not '${query.land}'`,
        'SCOPE_MISMATCH',
      )
    }
    return { land: owner, colony }
  }
  if (payload.scope === 'land' && payload.land) {
    if (query.land && query.land !== payload.land) {
      throw forbidden(`Land '${query.land}' is outside this session's land '${payload.land}'`)
    }
    if (!query.colony) {
      throw badRequest(
        `Name the colony to act on: pass '?colony=<id>' for a colony of land '${payload.land}'`,
        'SCOPE_REQUIRED',
      )
    }
    await assertColonyInLand(db, env, query.colony, payload.land)
    return { land: payload.land, colony: query.colony }
  }
  if (!payload.colony) throw forbidden('This session is not bound to a colony')
  if (query.colony && query.colony !== payload.colony) {
    throw forbidden(`Colony '${query.colony}' is outside this session's colony '${payload.colony}'`)
  }
  if (query.land && query.land !== session.land) {
    throw forbidden(`Land '${query.land}' is outside this session's land '${session.land}'`)
  }
  return { land: session.land, colony: payload.colony }
}

/** `?land=` / `?colony=`, validated for shape. Access is decided by the resolvers above. */
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
