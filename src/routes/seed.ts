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
import { badRequest } from '../errors'
import { createDb } from '../db/client'
import { requireSession } from '../auth/session'
import { resolveRequestScope } from '../scope'
import { applySnapshot, exportSnapshot } from '../meta/seed'

export const seedRoutes = new Hono<{ Bindings: Env }>()

/** Export the current land state into a reproducible JSON snapshot. */
seedRoutes.get('/export', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'settings.write')
  const sc = await resolveRequestScope(c, db)
  const sel = c.req.query('scope') ?? 'all'
  const media = c.req.query('media') ?? 'none'
  const data = await exportSnapshot({
    db,
    kv: c.env.SETTINGS,
    bucket: c.env.MEDIA,
    land: sc.land,
    colony: sc.colony,
    scope: sel,
    withMediaBytes: media === 'bytes',
    origin: new URL(c.req.url).origin,
  })
  return c.json(data)
})

/** Wipe (optionally) and restore a land from a snapshot JSON payload. */
seedRoutes.post('/apply', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'settings.write')
  const sc = await resolveRequestScope(c, db)
  const wipe = c.req.query('wipe') !== 'false'
  const body = (await c.req.json().catch(() => null)) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Seed payload must be a JSON snapshot object')
  }
  const data = await applySnapshot({
    db,
    kv: c.env.SETTINGS,
    bucket: c.env.MEDIA,
    land: sc.land,
    colony: sc.colony,
    snap: body,
    wipe,
  })
  return c.json({ data })
})