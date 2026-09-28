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
import type { AuthTokenPayload, FilterMap } from '@hamolus/types'
import { buildEntitySchema, buildPaginationMeta, bulkDeleteSchema, listQuerySchema } from '@hamolus/types'
import type { Env } from '../env'
import { badRequest } from '../errors'
import { createDb } from '../db/client'
import { getCollection } from '../meta/store'
import { getSettings } from '../meta/settings'
import { PROTECTED_COLLECTION } from '../auth/privileges'
import { requireRead, requireWrite } from '../auth/session'
import { resolveRequestScope } from '../scope'
import { effectiveLocaleCodes } from '../config'
import {
  bulkDeleteRecords,
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  updateRecord,
} from '../db/queries'

export const dynamicRoutes = new Hono<{ Bindings: Env }>()

function writePerm(defName: string): 'users.write' | 'records.write' {
  return defName === PROTECTED_COLLECTION ? 'users.write' : 'records.write'
}

function formatZodIssues(issues: { message: string; path?: unknown }[]): string {
  return issues.map((i) => `${String(i.path ?? 'input')}: ${i.message}`).join('; ')
}

/** Lightweight: returns only the lastUpdate hash for a collection. */
dynamicRoutes.get('/:collection/__lastUpdate', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'records.read')
  const scope = await resolveRequestScope(c)
  const name = c.req.param('collection')
  const def = await getCollection(db, name, scope.land, scope.colony)
  const { lastUpdate } = await listRecords(db, def, { page: 1, pageSize: 0 })
  return c.json({ data: { lastUpdate } })
})

/** List records, paginated + filterable. */
dynamicRoutes.get('/:collection', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'records.read')
  const scope = await resolveRequestScope(c)
  const name = c.req.param('collection')
  const def = await getCollection(db, name, scope.land, scope.colony)

  const locale = c.req.query('locale') || undefined
  const search = c.req.query('search') || undefined
  const { locale: _, search: __, ...queryRest } = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  const parsed = listQuerySchema.safeParse(queryRest)
  if (!parsed.success) throw badRequest('Invalid query: ' + formatZodIssues(parsed.error.issues), 'INVALID_QUERY')
  const q = parsed.data

  const { rows, total, lastUpdate } = await listRecords(db, def, {
    page: q.page,
    pageSize: q.pageSize,
    sortBy: q.sortBy,
    sortDesc: q.sortDir === 'desc',
    filter: q.filter as FilterMap | undefined,
    locale,
    search,
  })
  return c.json({
    data: rows,
    meta: buildPaginationMeta(q.page, q.pageSize, total),
    lastUpdate,
  })
})

dynamicRoutes.get('/:collection/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'records.read')
  const scope = await resolveRequestScope(c)
  const def = await getCollection(db, c.req.param('collection'), scope.land, scope.colony)
  const locale = c.req.query('locale') || undefined
  const row = await getRecord(db, def, c.req.param('id'), locale)
  return c.json({ data: row })
})

dynamicRoutes.post('/:collection', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  const scope = await resolveRequestScope(c)
  const def = await getCollection(db, c.req.param('collection'), scope.land, scope.colony)
  requireWrite(payload, writePerm(def.name))
  const input = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!input || typeof input !== 'object') throw badRequest('Body must be a JSON object')

  const settings = await getSettings(c.env.SETTINGS, scope.land, scope.colony)
  const languages = effectiveLocaleCodes(settings)
  const parsed = buildEntitySchema(def, languages).safeParse(input)
  if (!parsed.success) throw badRequest('Validation failed: ' + formatZodIssues(parsed.error.issues), 'VALIDATION')
  const row = await createRecord(db, def, parsed.data, payload?.username ?? 'system')
  return c.json({ data: row }, 201)
})

dynamicRoutes.put('/:collection/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  const scope = await resolveRequestScope(c)
  const def = await getCollection(db, c.req.param('collection'), scope.land, scope.colony)
  requireWrite(payload, writePerm(def.name))
  const input = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!input || typeof input !== 'object') throw badRequest('Body must be a JSON object')

  const settings = await getSettings(c.env.SETTINGS, scope.land, scope.colony)
  const languages = effectiveLocaleCodes(settings)
  const parsed = buildEntitySchema(def, languages).partial().safeParse(input)
  if (!parsed.success) throw badRequest('Validation failed: ' + formatZodIssues(parsed.error.issues), 'VALIDATION')
  const row = await updateRecord(db, def, c.req.param('id'), parsed.data, payload?.username ?? 'system')
  return c.json({ data: row })
})

dynamicRoutes.patch('/:collection/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  const scope = await resolveRequestScope(c)
  const def = await getCollection(db, c.req.param('collection'), scope.land, scope.colony)
  requireWrite(payload, writePerm(def.name))
  const input = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!input || typeof input !== 'object') throw badRequest('Body must be a JSON object')

  const settings = await getSettings(c.env.SETTINGS, scope.land, scope.colony)
  const languages = effectiveLocaleCodes(settings)
  const parsed = buildEntitySchema(def, languages).partial().safeParse(input)
  if (!parsed.success) throw badRequest('Validation failed: ' + formatZodIssues(parsed.error.issues), 'VALIDATION')
  const row = await updateRecord(db, def, c.req.param('id'), parsed.data, payload?.username ?? 'system')
  return c.json({ data: row })
})

dynamicRoutes.delete('/:collection/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  const scope = await resolveRequestScope(c)
  const def = await getCollection(db, c.req.param('collection'), scope.land, scope.colony)
  requireWrite(payload, writePerm(def.name))
  await deleteRecord(db, def, c.req.param('id'), payload?.username ?? 'system')
  return c.body(null, 204)
})

/** Multi-select record removal (bulk delete). Responds 200 even for 0 matches. */
dynamicRoutes.post('/:collection/__bulk_delete', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  const scope = await resolveRequestScope(c)
  const def = await getCollection(db, c.req.param('collection'), scope.land, scope.colony)
  requireWrite(payload, writePerm(def.name))
  const input = (await c.req.json().catch(() => null)) as unknown
  const parsed = bulkDeleteSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid request: ' + formatZodIssues(parsed.error.issues), 'INVALID_BULK_DELETE')
  const deleted = await bulkDeleteRecords(db, def, parsed.data.ids, payload?.username ?? 'system')
  return c.json({ data: { deleted } })
})