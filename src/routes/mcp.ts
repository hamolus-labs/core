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
 * Console-facing MCP administration — the operator's half of the feature.
 *
 * This is where an instance is created, pointed at a colony, switched between
 * read-only and read-write, and given per-user tokens. Every answer the console
 * draws comes from here, which is what makes the console the only place the
 * operator has to go.
 *
 * Auth is the ordinary session JWT plus `mcp.read` / `mcp.write`, and reach is
 * the same `(land, colony)` resolution `/_config` uses — a `?colony=` selector
 * is a request, never a grant. The two surfaces share the resolvers rather than
 * each having their own opinion about who may see what.
 *
 * The machine-facing half lives in `mcp-machine.ts` and is deliberately a
 * different file: it authenticates with an instance id, not a session, and it
 * runs below the JWT middleware entirely.
 */

import { Hono } from 'hono'
import type { AuthTokenPayload } from '@hamolus/types'
import {
  mcpInstanceCreateSchema,
  mcpInstanceUpdateSchema,
  mcpListQuerySchema,
  mcpTokenCreateSchema,
  PERMISSIONS,
} from '@hamolus/types'
import type { Env } from '../env'
import { createDb } from '../db/client'
import { badRequest } from '../errors'
import {
  createMcpInstance,
  createMcpToken,
  deleteMcpInstance,
  getMcpInstance,
  listMcpInstances,
  listMcpTokens,
  revokeMcpToken,
  updateMcpInstance,
} from '../auth/mcp'
import { requireSession, requireWrite } from '../auth/session'
import { resolveColonyTarget, resolveListTarget } from '../auth/scope-target'
import { resolveRequestScope } from '../scope'

export const mcpRoutes = new Hono<{ Bindings: Env }>()

type Db = ReturnType<typeof createDb>
type Query = { land?: string; colony?: string }

/** `?land=` / `?colony=`; shape only — the resolvers decide access. */
function parseQuery(url: string): Query {
  const parsed = mcpListQuerySchema.safeParse(
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

/** A body that must be a JSON object, or `null` when it is not. */
async function readJsonObject(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object')
  }
  return body
}

mcpRoutes.get('/instances', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'mcp.read')
  const session = await resolveRequestScope(c)
  const target = await resolveListTarget(db, c.env, payload, parseQuery(c.req.url), session)
  return c.json({ data: await listMcpInstances(db, target) })
})

mcpRoutes.get('/instances/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'mcp.read')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(db, c.env, payload, parseQuery(c.req.url), session)
  return c.json({ data: await getMcpInstance(db, c.req.param('id'), land, colony) })
})

/**
 * Create an instance and hand back the id.
 *
 * The id is generated, not chosen: it is the worker's credential, so an
 * operator-supplied value would be a guessable credential. The console copies it
 * into `wrangler.jsonc` — that is the only manual step the feature leaves.
 */
mcpRoutes.post('/instances', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'mcp.write')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(db, c.env, payload, parseQuery(c.req.url), session)
  const parsed = mcpInstanceCreateSchema.safeParse(await readJsonObject(c.req))
  if (!parsed.success) {
    throw badRequest('Invalid instance: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const input = parsed.data
  return c.json(
    {
      data: await createMcpInstance(
        db,
        {
          label: input.label,
          enabled: input.enabled,
          readonly: input.readonly,
          toolGroups: input.toolGroups,
          dynamicTools: input.dynamicTools,
          dynamicMax: input.dynamicMax,
        },
        land,
        colony,
      ),
    },
    201,
  )
})

mcpRoutes.put('/instances/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'mcp.write')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(db, c.env, payload, parseQuery(c.req.url), session)
  const parsed = mcpInstanceUpdateSchema.safeParse(await readJsonObject(c.req))
  if (!parsed.success) {
    throw badRequest('Invalid update: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const input = parsed.data
  return c.json({
    data: await updateMcpInstance(
      db,
      c.req.param('id'),
      {
        label: input.label,
        enabled: input.enabled,
        readonly: input.readonly,
        toolGroups: input.toolGroups,
        dynamicTools: input.dynamicTools,
        dynamicMax: input.dynamicMax,
      },
      land,
      colony,
    ),
  })
})

/** Deletes the instance and every token under it, so no credential outlives it. */
mcpRoutes.delete('/instances/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'mcp.write')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(db, c.env, payload, parseQuery(c.req.url), session)
  await deleteMcpInstance(db, c.req.param('id'), land, colony)
  return c.body(null, 204)
})

mcpRoutes.get('/instances/:id/tokens', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'mcp.read')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(db, c.env, payload, parseQuery(c.req.url), session)
  return c.json({ data: await listMcpTokens(db, c.req.param('id'), land, colony) })
})

/**
 * Issue a per-user token.
 *
 * The plaintext is in this response and nowhere else, ever — the row keeps only
 * its hash, so an operator who loses it issues a new one. `permissions` narrows
 * the instance: a token can be strictly less powerful than the instance it
 * belongs to, never more.
 */
mcpRoutes.post('/instances/:id/tokens', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'mcp.write')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(db, c.env, payload, parseQuery(c.req.url), session)
  const parsed = mcpTokenCreateSchema.safeParse(await readJsonObject(c.req))
  if (!parsed.success) {
    throw badRequest('Invalid token: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const input = parsed.data
  const unknown = (input.permissions ?? []).filter((p) => !(PERMISSIONS as readonly string[]).includes(p))
  if (unknown.length > 0) throw badRequest(`Unknown permissions: ${unknown.join(', ')}`, 'VALIDATION')
  const created = await createMcpToken(
    db,
    c.req.param('id'),
    { name: input.name, permissions: input.permissions, expiresAt: input.expiresAt ?? null },
    land,
    colony,
  )
  return c.json({ data: { ...created.token, token: created.secret } }, 201)
})

mcpRoutes.delete('/tokens/:tokenId', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'mcp.write')
  const session = await resolveRequestScope(c)
  const { land, colony } = await resolveColonyTarget(db, c.env, payload, parseQuery(c.req.url), session)
  return c.json({ data: await revokeMcpToken(db, c.req.param('tokenId'), land, colony) })
})
