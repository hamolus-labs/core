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
 * The worker-facing half of MCP: what a deployed server calls on every request.
 *
 * These two routes authenticate with an **instance id**, not a session, and they
 * are mounted in `index.ts` *between* the CORS middleware and the JWT
 * middleware. That placement is the point, not an accident:
 *
 * - `AUTH_SKIP` would look like the cheaper way to exempt them, but its skipped
 *   branch still calls `applyScope` → `resolveRequestScope`
 *   (`index.ts:85`), and on a `centralized` core a request with no
 *   `x-land`/`x-colony` is a 400 (`scope.ts:215-221`). A worker that has only an
 *   instance id cannot send a scope header — it does not know its own scope yet,
 *   which is precisely what it is asking for.
 * - These handlers therefore resolve nothing from the request. The instance row
 *   carries its own land and colony, and that is the only scope there is.
 *
 * The instance id is a credential, so the *message* never distinguishes an unknown
 * id from a revoked token — a caller must not be able to enumerate which ids exist.
 * The *status* does distinguish three cases, because the fix is different in each
 * and an operator reading a worker log needs to be told which one happened:
 *
 * - 401 the credential itself is not accepted (missing, unknown, malformed)
 * - 403 the credential is fine but the thing it points at is switched off
 * - 400 the request is malformed
 *
 * Both routes also write a heartbeat — the deployment is live, and this is the release
 * it runs — through `touchMcpInstanceHeartbeat`, which is deliberately the only writer
 * of those two columns.
 */

import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import type { AuthTokenPayload } from '@hamolus/types'
import { MCP_WORKER_VERSION_HEADER, mcpSessionExchangeSchema } from '@hamolus/types'
import type { Env } from '../env'
import { createDb } from '../db/client'
import { badRequest, forbidden, unauthorized } from '../errors'
import {
  getMcpInstanceConfig,
  touchMcpInstanceHeartbeat,
  verifyMcpToken,
} from '../auth/mcp'

export const mcpMachineRoutes = new Hono<{ Bindings: Env }>()

/**
 * Session lifetime. Short on purpose: a revoked token stays usable until the
 * JWT the worker is holding expires, so this is the real revocation window. The
 * worker caches the JWT for exactly this long and no longer.
 */
const SESSION_TTL_SECONDS = 15 * 60

/**
 * The instance id from `Authorization: Bearer …`. Absent or blank ⇒ 401.
 *
 * 401 and not 400 because an MCP client reacts to the two differently: 400 reads
 * as "my request is malformed, retry differently", 401 as "authenticate". A worker
 * that has been configured with no instance id needs the second one to surface it.
 */
function instanceIdFromHeader(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('Missing MCP instance id', 'INSTANCE_REQUIRED')
  }
  const id = header.slice(7).trim()
  if (!id) throw unauthorized('Missing MCP instance id', 'INSTANCE_REQUIRED')
  return id
}

/**
 * What a worker may serve: which land/colony, whether it may write, which tool
 * groups to register.
 *
 * Deliberately unauthenticated apart from the instance id, and deliberately thin.
 * Leaking an id costs a description of the tool surface — not data, not a
 * session — because minting a session needs a per-user token on top.
 *
 * This is also where a deployment registers itself, in the sense that matters to an
 * operator: a worker that reaches this route is alive, and it says which release it
 * is in `MCP_WORKER_VERSION_HEADER`. Recording that is the only way the console can
 * tell a registered instance from a live one — an `enabled` row with no `lastSeenAt`
 * is a credential nobody has deployed yet, which looks identical to a healthy
 * instance until something is wrong.
 */
mcpMachineRoutes.get('/config', async (c) => {
  const db = createDb(c.env.DB)
  const instanceId = instanceIdFromHeader(c.req.header('authorization'))
  const instance = await getMcpInstanceConfig(db, instanceId)
  // 403: the id was accepted, and the answer is "this one is switched off". That is
  // a different problem from a bad id, and the console toggle is where it gets fixed.
  if (!instance.enabled) {
    throw forbidden('This MCP instance is disabled', 'MCP_DISABLED')
  }
  await touchMcpInstanceHeartbeat(db, instanceId, c.req.header(MCP_WORKER_VERSION_HEADER))
  return c.json({ data: { instance } })
})

/**
 * Exchange a per-user token for a short-lived session JWT.
 *
 * This is where the console's decisions become enforcement. The permission list
 * is computed from the instance's tool groups (and its read-only flag) and
 * intersected with the token's own narrowing list, so the JWT the worker then
 * carries is *narrower than the operator's account*. A read-only instance mints a
 * token with no `*.write` at all, and `requireWrite` in the rest of the core
 * answers 403 — the worker's own `readonly` check is a nicer error message, not
 * the thing standing between the model and a write.
 */
mcpMachineRoutes.post('/session', async (c) => {
  const instanceId = instanceIdFromHeader(c.req.header('authorization'))
  const db = createDb(c.env.DB)

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object')
  }
  const parsed = mcpSessionExchangeSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid request: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }

  // The instance id from the header is passed in as well, so a token issued for one
  // instance cannot be redeemed through another. See `verifyMcpToken` for why that
  // check is not redundant.
  const { token, instance, permissions } = await verifyMcpToken(db, parsed.data.token, instanceId)

  // After verification, not before: a rejected credential is an attack or a typo, and
  // neither should make a deployment look healthy to an operator watching `lastSeenAt`.
  await touchMcpInstanceHeartbeat(db, instanceId, c.req.header(MCP_WORKER_VERSION_HEADER))

  const iat = Math.floor(Date.now() / 1000)
  const expiresAt = new Date((iat + SESSION_TTL_SECONDS) * 1000)
  // `satisfies` rather than an annotation: hono/jwt wants an index signature,
  // which an interface does not have, so the literal type has to survive.
  const claims = {
    // A subject space of its own, so a request made through MCP is never
    // mistaken for a console login in a log or in `_auth/me`.
    sub: `mcp:${instance.id}:${token.id}`,
    username: token.name,
    role: 'mcp',
    scope: 'colony',
    permissions,
    land: instance.land,
    colony: instance.colony,
    mcp: { instanceId: instance.id, tokenId: token.id },
    iat,
    exp: Math.floor(expiresAt.getTime() / 1000),
  } satisfies AuthTokenPayload
  const jwt = await sign(claims, c.env.JWT_SECRET)

  return c.json({
    data: {
      token: jwt,
      expiresAt: expiresAt.toISOString(),
      instance: { id: instance.id, land: instance.land, colony: instance.colony },
      tokenId: token.id,
      permissions,
    },
  })
})
