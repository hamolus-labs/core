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
import { z } from 'zod'
import type { AuthTokenPayload } from '@hamolus/types'
import type { Env } from '../env'
import { badRequest, forbidden } from '../errors'
import { createDb } from '../db/client'
import { hasPermission, requireRead, requireSession, requireWrite } from '../auth/session'
import { parseRequestedId } from '../scope'
import {
  colonyDefinitionSchema,
  deleteColony,
  deleteLand,
  getColony,
  getLand,
  landDefinitionSchema,
  listColonies,
  listLands,
  putColony,
  putLand,
} from '../meta/lands'

/**
 * Universe registry routes — the platform's global scope tree.
 *
 *  - `/api/_meta/lands{/id}`    the lands
 *  - `/api/_meta/colonies{/id}` the colonies inside them
 *
 * Access widens with the role:
 *  - a **superadmin** (or the legacy `ADMIN_KEY` session) sees and edits everything;
 *  - a **land_admin** only ever sees its own land and that land's colonies, and may
 *    create/delete colonies inside it — never other lands and never a land itself;
 *  - a colony **admin** has no registry access at all.
 */
export const landRoutes = new Hono<{ Bindings: Env }>()
export const colonyRoutes = new Hono<{ Bindings: Env }>()

const LAND_SUFFIX = '_lnd'
const COLONY_SUFFIX = '_cny'

/** Colony body = colony definition (incl. id) + the owning land id. */
const colonyFullSchema = colonyDefinitionSchema
  .extend({
    landId: z.string().trim().min(2).max(40),
  })
  .strict()

function parseError(label: string, issues: readonly { message: string }[]): never {
  throw badRequest(`${label}: ${issues.map((i) => i.message).join('; ')}`, 'INVALID_SCOPE')
}

/** Land id from the path, suffix-validated. */
function landId(raw: string): string {
  return parseRequestedId(raw, LAND_SUFFIX, 'INVALID_LAND', 'land')
}

/** Colony id from the path or a body field, suffix-validated. */
function colonyId(raw: string): string {
  return parseRequestedId(raw, COLONY_SUFFIX, 'INVALID_COLONY', 'colony')
}

/**
 * The land a session may act on, or `null` when it may act on any land.
 * A `land`-scoped session (land_admin) is pinned to its own land; a colony-scoped
 * session has no registry access at all.
 */
function pinnedLand(payload: AuthTokenPayload | undefined, perm: 'lands' | 'colonies'): string | null {
  if (!payload) throw forbidden('Authentication required')
  if (payload.sub === 'admin' && !payload.permissions) return null
  if (hasPermission(payload, `${perm}.write`) && payload.scope === 'universe') return null
  if (payload.scope === 'land' && payload.land) return payload.land
  throw forbidden(`Missing permission: ${perm}.${perm === 'lands' ? 'read' : 'write'}`)
}

/**
 * Reject a land_admin that points at a land outside the one pinned in its token.
 *
 * Two independent rules, because either alone leaks: the requested id must be the
 * token's own land (a `land_admin` never owns two), and a land that is already
 * owned by a *different* user stays off limits even if the ids line up (a
 * superadmin can hand a land to someone else, and the stale token of the previous
 * owner must not keep reading it). An unowned (`ownerUserId === null`) land is
 * readable only by the token pinned to that very land.
 */
async function assertOwnsLand(
  db: ReturnType<typeof createDb>,
  payload: AuthTokenPayload,
  id: string,
): Promise<void> {
  const pinned = pinnedLand(payload, 'lands')
  if (pinned === null) return
  if (id !== pinned) {
    throw forbidden(`Land '${id}' is not accessible from scope land '${pinned}'`)
  }
  const land = await getLand(db, id)
  if (land.ownerUserId && land.ownerUserId !== payload.sub) {
    throw forbidden(`Land '${id}' is not owned by this user`)
  }
}

/** Reject a land_admin that points at a colony outside its own land. */
async function assertOwnsColony(
  db: ReturnType<typeof createDb>,
  payload: AuthTokenPayload,
  id: string,
  landFilter: string | undefined,
): Promise<void> {
  const pinned = pinnedLand(payload, 'lands')
  if (pinned === null) return
  const colony = await getColony(db, id, landFilter)
  if (colony.landId !== pinned) {
    throw forbidden(`Colony '${id}' does not belong to land '${pinned}'`)
  }
}

// ————————————————————————————— Lands —————————————————————————————

landRoutes.get('/', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'lands.read')
  const db = createDb(c.env.DB)
  const pinned = pinnedLand(payload, 'lands')
  const all = await listLands(db)
  return c.json({ data: pinned === null ? all : all.filter((l) => l.id === pinned) })
})

landRoutes.get('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'lands.read')
  const db = createDb(c.env.DB)
  const id = landId(c.req.param('id'))
  await assertOwnsLand(db, payload!, id)
  return c.json({ data: await getLand(db, id) })
})

/** Upsert a land definition (creates it when the id is new). Superadmin only. */
landRoutes.put('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'lands.write')
  if (pinnedLand(payload, 'lands') !== null) {
    throw forbidden('Only a universe admin may create or update lands')
  }
  const id = landId(c.req.param('id'))
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw badRequest('Body must be a JSON object')
  if (body.id !== undefined && body.id !== id) {
    throw badRequest('Body id must match the path parameter')
  }
  const parsed = landDefinitionSchema.safeParse({ ...body, id })
  if (!parsed.success) parseError('Invalid land definition', parsed.error.issues)
  const db = createDb(c.env.DB)
  const owner = typeof body.ownerUserId === 'string' ? body.ownerUserId : null
  return c.json({ data: await putLand(db, parsed.data, owner) })
})

landRoutes.delete('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'lands.write')
  if (pinnedLand(payload, 'lands') !== null) {
    throw forbidden('Only a universe admin may delete a land')
  }
  const db = createDb(c.env.DB)
  await deleteLand(db, landId(c.req.param('id')), c.env.MEDIA, c.env.SETTINGS)
  return c.body(null, 204)
})

// ———————————————————————————— Colonies ————————————————————————————

colonyRoutes.get('/', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'colonies.read')
  const db = createDb(c.env.DB)
  const pinned = pinnedLand(payload, 'lands')
  const requested = c.req.query('land') || undefined
  if (pinned !== null && requested !== undefined && requested !== pinned) {
    throw forbidden(`Land '${requested}' is outside this user's scope`)
  }
  return c.json({ data: await listColonies(db, requested ?? pinned ?? undefined) })
})

colonyRoutes.get('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'colonies.read')
  const db = createDb(c.env.DB)
  const id = colonyId(c.req.param('id'))
  await assertOwnsColony(db, payload!, id, c.req.query('land') || undefined)
  return c.json({ data: await getColony(db, id, c.req.query('land') || undefined) })
})

/** Upsert a colony under an existing land. */
colonyRoutes.put('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'colonies.write')
  const id = colonyId(c.req.param('id'))
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw badRequest('Body must be a JSON object')
  if (body.id !== undefined && body.id !== id) {
    throw badRequest('Body id must match the path parameter')
  }
  if (typeof body.landId !== 'string') throw badRequest('Body must include a landId', 'INVALID_SCOPE')
  const landIdValue = landId(body.landId)
  const pinned = pinnedLand(payload, 'lands')
  if (pinned !== null && pinned !== landIdValue) {
    throw forbidden(`Land '${landIdValue}' is outside this user's scope`)
  }
  const parsed = colonyFullSchema.safeParse({ ...body, id, landId: landIdValue })
  if (!parsed.success) parseError('Invalid colony definition', parsed.error.issues)
  const db = createDb(c.env.DB)
  const owner = typeof body.ownerUserId === 'string' ? body.ownerUserId : null
  const colony = await putColony(db, parsed.data.landId, {
    id,
    label: parsed.data.label,
    description: parsed.data.description ?? null,
  }, owner)
  return c.json({ data: colony })
})

colonyRoutes.delete('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'colonies.write')
  const id = colonyId(c.req.param('id'))
  const land = c.req.query('land') || undefined
  const pinned = pinnedLand(payload, 'lands')
  if (pinned !== null && land !== undefined && land !== pinned) {
    throw forbidden(`Land '${land}' is outside this user's scope`)
  }
  const db = createDb(c.env.DB)
  await assertOwnsColony(db, payload!, id, land)
  await deleteColony(db, id, land)
  return c.body(null, 204)
})
