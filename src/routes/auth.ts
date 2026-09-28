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
import { sign } from 'hono/jwt'
import type { AuthTokenPayload, AuthUser, LoginResponse, Permission } from '@hamolus/types'
import {
  COLONY_DEFAULT,
  LAND_DEFAULT,
  PERMISSIONS,
  authChangePasswordSchema,
  authLoginSchema,
  authSetupSchema,
  authUserCreateSchema,
  authUserUpdateSchema,
  superAdminCreateSchema,
  superAdminUpdateSchema,
} from '@hamolus/types'
import type { Env } from '../env'
import { createDb } from '../db/client'
import { badRequest, forbidden, unauthorized } from '../errors'
import { resolveRequestScope } from '../scope'
import { hashPassword, verifyPassword } from '../auth/pass'
import {
  countActiveAdmins,
  countUsers,
  createUserRow,
  deleteUserRow,
  getUserRowById,
  getUserRowByUsername,
  listUserRows,
  serializeUser,
  serializeUsers,
  updateUserRow,
} from '../auth/users'
import { getPrivilegeById, getPrivilegesMap, listPrivileges } from '../auth/privileges'
import { decodeBearer, requireSession } from '../auth/session'
import {
  countActiveSupers,
  createSuperRow,
  deleteSuperRow,
  getSuperRowById,
  getSuperRowByUsername,
  listSupers,
  seedSuperFromEnv,
  serializeSuper,
  updateSuperRow,
  type SuperRow,
} from '../auth/super'

export const authRoutes = new Hono<{ Bindings: Env }>()

const TTL_MS = 24 * 60 * 60 * 1000

function normalizePermissions(p?: Permission[] | null): Permission[] {
  if (!Array.isArray(p)) return []
  return p.filter((x) => (PERMISSIONS as readonly string[]).includes(x)) as Permission[]
}

async function issueToken(
  env: Env,
  user: AuthUser,
  permissions: Permission[],
  land: string = user.land,
  colony: string = user.colony,
): Promise<LoginResponse> {
  const iat = Math.floor(Date.now() / 1000)
  const expiresAt = new Date((iat + TTL_MS / 1000) * 1000)
  const token = await sign(
    {
      sub: user.id,
      username: user.username,
      role: user.privilegeName ?? undefined,
      scope: user.privilegeScope ?? undefined,
      permissions,
      land: land || undefined,
      colony: colony || undefined,
      iat,
      exp: Math.floor(expiresAt.getTime() / 1000),
    },
    env.JWT_SECRET,
  )
  return { data: { token, expiresAt: expiresAt.toISOString(), user, permissions } }
}

type Db = ReturnType<typeof createDb>

async function buildSession(
  db: Db,
  row: Awaited<ReturnType<typeof getUserRowById>>,
  land: string = row.land,
  colony: string = row.colony,
): Promise<{ user: AuthUser; userPermissions: Permission[] }> {
  const privById = await getPrivilegesMap(db, land, colony)
  const user = serializeUser(row, privById)
  const priv = await getPrivilegeById(db, row.privilege_id, land, colony)
  return { user, userPermissions: priv ? normalizePermissions(priv.permissions) : [] }
}

/** A super-admin row shaped as an AuthUser so the console session model stays uniform. */
function superToAuthUser(row: SuperRow): AuthUser {
  return {
    id: `super:${row.id}`,
    land: '',
    colony: '',
    username: row.username,
    name: row.name,
    privilegeId: 'super',
    privilegeName: 'superadmin',
    privilegeLabel: 'Super admin',
    privilegeScope: 'universe',
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Public: exchange ADMIN_KEY for a JWT (legacy flow — implicit full `admin` access). */
authRoutes.post('/token', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null
  if (!body || typeof body.key !== 'string' || body.key !== c.env.ADMIN_KEY) {
    return c.json({ error: { code: 'INVALID_KEY', message: 'Invalid key' } }, 401)
  }

  const iat = Math.floor(Date.now() / 1000)
  const expiresAt = new Date((iat + TTL_MS / 1000) * 1000)
  const token = await sign(
    { sub: 'admin', role: 'admin', iat, exp: Math.floor(expiresAt.getTime() / 1000) },
    c.env.JWT_SECRET,
  )

  const payload: LoginResponse = { data: { token, expiresAt: expiresAt.toISOString() } }
  return c.json(payload)
})

/** Public: whether the platform still needs its first user provisioned. */
authRoutes.get('/setup', async (c) => {
  const db = createDb(c.env.DB)
  const setupRequired = (await countUsers(db)) === 0
  return c.json({ data: { setupRequired } })
})

/** Public (only while the users table is empty): provision the first admin user. */
authRoutes.post('/setup', async (c) => {
  const db = createDb(c.env.DB)
  if ((await countUsers(db)) > 0) {
    throw forbidden('Setup has already been completed', 'SETUP_DONE')
  }
  const body = (await c.req.json().catch(() => null)) as unknown
  const parsed = authSetupSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid setup: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const adminPriv = (await listPrivileges(db, LAND_DEFAULT, COLONY_DEFAULT)).find(
    (p) => p.name === 'admin',
  )
  if (!adminPriv) throw badRequest('The admin privilege is not available', 'PROVISIONING')

  const passwordHash = await hashPassword(parsed.data.password)
  const row = await createUserRow(
    db,
    {
      username: parsed.data.username,
      name: parsed.data.name,
      passwordHash,
      privilegeId: adminPriv.id,
      isActive: true,
    },
    LAND_DEFAULT,
    COLONY_DEFAULT,
  )
  const privById = await getPrivilegesMap(db, LAND_DEFAULT, COLONY_DEFAULT)
  const user = serializeUser(row, privById)
  const resp = await issueToken(c.env, user, normalizePermissions(adminPriv.permissions))
  return c.json(resp, 201)
})

/** Public: whether the platform has no usable super administrator yet. */
authRoutes.get('/super', async (c) => {
  const db = createDb(c.env.DB)
  await seedSuperFromEnv(db, c.env)
  const setupRequired = (await countActiveSupers(db)) === 0
  return c.json({ data: { setupRequired } })
})

/** Sign in with username + password; issues a scoped JWT. */
authRoutes.post('/login', async (c) => {
  const db = createDb(c.env.DB)
  const body = (await c.req.json().catch(() => null)) as unknown
  const parsed = authLoginSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid login: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  // Platform super-admin credentials resolve first — they are a global account
  // outside the per-land `_auth_users` table.
  await seedSuperFromEnv(db, c.env)
  const superRow = await getSuperRowByUsername(db, parsed.data.username).catch(() => undefined)
  if (superRow) {
    if (superRow.is_active !== 1) throw forbidden('This account is disabled', 'ACCOUNT_DISABLED')
    const superOk = await verifyPassword(parsed.data.password, superRow.password_hash)
    if (!superOk) throw unauthorized('Invalid username or password', 'INVALID_CREDENTIALS')
    const resp = await issueToken(c.env, superToAuthUser(superRow), [...PERMISSIONS])
    return c.json(resp)
  }
  let row
  try {
    row = await getUserRowByUsername(db, parsed.data.username)
  } catch {
    throw unauthorized('Invalid username or password', 'INVALID_CREDENTIALS')
  }
  const ok = await verifyPassword(parsed.data.password, row.password_hash)
  if (!ok) throw unauthorized('Invalid username or password', 'INVALID_CREDENTIALS')
  if (row.is_active !== 1) throw forbidden('This account is disabled', 'ACCOUNT_DISABLED')

  const { user, userPermissions } = await buildSession(db, row, row.land, row.colony)
  const resp = await issueToken(c.env, user, userPermissions, row.land, row.colony)
  return c.json(resp)
})

/** Current session (works even when the JWT middleware is skipped by PUBLIC_GETS). */
authRoutes.get('/me', async (c) => {
  const db = createDb(c.env.DB)
  const payload = await decodeBearer(c.env.JWT_SECRET, c.req.header('Authorization'))
  requireSession(payload, 'settings.read')

  // A legacy ADMIN_KEY token has `sub: 'admin'` and no `_auth_users` row — it is
  // an implicit full-access session, so report a synthetic admin user.
  if (payload.sub === 'admin') {
    const user: AuthUser = {
      id: 'admin',
      land: LAND_DEFAULT,
      colony: COLONY_DEFAULT,
      username: 'admin',
      name: null,
      privilegeId: 'admin',
      privilegeName: 'admin',
      privilegeLabel: 'Administrator',
      privilegeScope: 'universe',
      isActive: true,
      createdAt: '',
      updatedAt: '',
    }
    return c.json({ data: { user, permissions: [...PERMISSIONS] } })
  }

  // A platform super-admin token carries `sub: 'super:<id>'` — global, no land.
  if (payload.sub.startsWith('super:')) {
    let srow
    try {
      srow = await getSuperRowById(db, payload.sub.slice('super:'.length))
    } catch {
      throw unauthorized('Session user no longer exists')
    }
    return c.json({ data: { user: superToAuthUser(srow), permissions: [...PERMISSIONS] } })
  }

  let row
  try {
    row = await getUserRowById(
      db,
      payload!.sub,
      payload!.land ?? LAND_DEFAULT,
      payload!.colony ?? COLONY_DEFAULT,
    )
  } catch {
    throw unauthorized('Session user no longer exists')
  }
  const { user, userPermissions } = await buildSession(db, row, row.land, row.colony)
  return c.json({ data: { user, permissions: userPermissions } })
})

/**
 * Self-service password change: any signed-in user verifies their current
 * password and sets a new one. Works regardless of role; only the caller's own
 * account is touched. A legacy ADMIN_KEY session never has a password.
 */
authRoutes.post('/me/password', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  if (payload.sub === 'admin') {
    throw badRequest('Cannot change the password of an admin-key session', 'ADMIN_KEY_SESSION')
  }
  const body = (await c.req.json().catch(() => null)) as unknown
  const parsed = authChangePasswordSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid password change: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  let row
  try {
    row = await getUserRowById(
      db,
      payload.sub,
      payload.land ?? LAND_DEFAULT,
      payload.colony ?? COLONY_DEFAULT,
    )
  } catch {
    throw unauthorized('Session user no longer exists')
  }
  const ok = await verifyPassword(parsed.data.currentPassword, row.password_hash)
  if (!ok) throw badRequest('Current password is incorrect', 'INVALID_CREDENTIALS')
  const passwordHash = await hashPassword(parsed.data.newPassword)
  await updateUserRow(db, row.id, { passwordHash }, row.land, row.colony)
  const privById = await getPrivilegesMap(db, row.land, row.colony)
  return c.json({
    data: serializeUser(await getUserRowById(db, row.id, row.land, row.colony), privById),
  })
})

/** List managed users (requires an authenticated session with `users.read`). */
authRoutes.get('/users', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'users.read')
  const scope = await resolveRequestScope(c, db)
  const rows = await listUserRows(db, scope.land, scope.colony)
  const privById = await getPrivilegesMap(db, scope.land, scope.colony)
  return c.json({ data: serializeUsers(rows, privById) })
})

/** Create a user (admin-only). */
authRoutes.post('/users', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'users.write')
  const scope = await resolveRequestScope(c, db)
  const body = (await c.req.json().catch(() => null)) as unknown
  const parsed = authUserCreateSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid user: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const priv = await getPrivilegeById(db, parsed.data.privilegeId, scope.land, scope.colony)
  if (!priv) throw badRequest('Privilege does not exist', 'UNKNOWN_FIELD')
  const passwordHash = await hashPassword(parsed.data.password)
  const row = await createUserRow(
    db,
    {
      username: parsed.data.username,
      name: parsed.data.name,
      passwordHash,
      privilegeId: parsed.data.privilegeId,
      isActive: parsed.data.isActive ?? true,
    },
    scope.land,
    scope.colony,
  )
  const privById = await getPrivilegesMap(db, scope.land, scope.colony)
  return c.json({ data: serializeUser(row, privById) }, 201)
})

/** Update a user (admin-only): profile, role, activation, password reset. */
authRoutes.put('/users/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'users.write')
  const scope = await resolveRequestScope(c, db)
  const id = c.req.param('id')
  const row = await getUserRowById(db, id, scope.land, scope.colony)
  const body = (await c.req.json().catch(() => null)) as unknown
  const parsed = authUserUpdateSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid user: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const currentPriv = await getPrivilegeById(db, row.privilege_id, scope.land, scope.colony)
  const isAdminUser = currentPriv?.name === 'admin'
  const lastAdmin = isAdminUser && (await countActiveAdmins(db, scope.land, scope.colony)) === 1

  const data = parsed.data
  if (lastAdmin) {
    if (data.isActive === false || data.privilegeId !== undefined) {
      const nextPriv = data.privilegeId ? await getPrivilegeById(db, data.privilegeId, scope.land, scope.colony) : undefined
      if (nextPriv) throw badRequest('Cannot demote the last active administrator', 'LAST_ADMIN')
      if (data.isActive === false) throw badRequest('Cannot disable the last active administrator', 'LAST_ADMIN')
      if (nextPriv === undefined && data.privilegeId !== undefined) throw badRequest('Privilege does not exist', 'UNKNOWN_FIELD')
    }
  } else if (data.privilegeId !== undefined) {
    const nextPriv = await getPrivilegeById(db, data.privilegeId, scope.land, scope.colony)
    if (!nextPriv) throw badRequest('Privilege does not exist', 'UNKNOWN_FIELD')
  }

  const updated = await updateUserRow(
    db,
    id,
    {
      name: data.name,
      passwordHash: data.password ? await hashPassword(data.password) : undefined,
      privilegeId: data.privilegeId,
      isActive: data.isActive,
    },
    scope.land,
    scope.colony,
  )
  const privById = await getPrivilegesMap(db, scope.land, scope.colony)
  return c.json({ data: serializeUser(updated, privById) })
})

/** Delete a user (admin-only; the last active admin is protected). */
authRoutes.delete('/users/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'users.write')
  const scope = await resolveRequestScope(c, db)
  const id = c.req.param('id')
  const row = await getUserRowById(db, id, scope.land, scope.colony)
  const priv = await getPrivilegeById(db, row.privilege_id, scope.land, scope.colony)
  if (priv?.name === 'admin' && row.is_active === 1 && (await countActiveAdmins(db, scope.land, scope.colony)) === 1) {
    throw badRequest('Cannot delete the last active administrator', 'LAST_ADMIN')
  }
  await deleteUserRow(db, id, scope.land, scope.colony)
  return c.body(null, 204)
})

/**
 * Platform super-admin registry (`/api/_auth/supers`). GLOBAL — the records
 * live outside any scope table, so these routes resolve no land/colony and are
 * gated by the `lands.*` permissions instead of `users.*`/`config.*`.
 */

/**
 * The platform super-admin directory sits outside every land's remit. Gating it
 * on `lands.*` alone was too loose: `land_admin` holds `lands.read` (it needs the
 * registry to switch lands), so one land's admin could enumerate every platform
 * account — usernames, ids and timestamps. The permission check is kept as the
 * coarse gate, then a platform-scoped session is required on top: either the
 * ADMIN_KEY session, or a token whose privilege scope is `universe`, which no
 * in-land role can be granted (`PRIVILEGE_SEEDS` never seeds it).
 */
function requirePlatformSession(payload: AuthTokenPayload | undefined, permission: Permission): void {
  requireSession(payload, permission)
  if (payload.sub === 'admin' || payload.scope === 'universe') return
  throw forbidden('Super administrators are managed at the platform level', 'PLATFORM_ONLY')
}

/** List super admins (requires `lands.read`). */
authRoutes.get('/supers', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requirePlatformSession(payload, 'lands.read')
  await seedSuperFromEnv(db, c.env)
  const rows = await listSupers(db)
  return c.json({ data: rows.map(serializeSuper) })
})

/** Create a super admin (requires `lands.write`). */
authRoutes.post('/supers', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requirePlatformSession(payload, 'lands.write')
  await seedSuperFromEnv(db, c.env)
  const body = (await c.req.json().catch(() => null)) as unknown
  const parsed = superAdminCreateSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid super admin: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const passwordHash = await hashPassword(parsed.data.password)
  const existing = await getSuperRowByUsername(db, parsed.data.username).catch(() => undefined)
  if (existing) {
    throw badRequest('A super admin with that username already exists', 'DUPLICATE')
  }
  const row = await createSuperRow(db, {
    username: parsed.data.username,
    name: parsed.data.name,
    passwordHash,
  })
  return c.json({ data: serializeSuper(row) }, 201)
})

/** Update a super admin — profile, password reset, activation (requires `lands.write`). */
authRoutes.put('/supers/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requirePlatformSession(payload, 'lands.write')
  const id = c.req.param('id')
  const row = await getSuperRowById(db, id)
  const body = (await c.req.json().catch(() => null)) as unknown
  const parsed = superAdminUpdateSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid super admin: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  if (row.is_active === 1 && parsed.data.isActive === false && (await countActiveSupers(db)) === 1) {
    throw badRequest('Cannot disable the last active super administrator', 'LAST_SUPER_ADMIN')
  }
  const updated = await updateSuperRow(db, id, {
    name: parsed.data.name,
    passwordHash: parsed.data.password ? await hashPassword(parsed.data.password) : undefined,
    isActive: parsed.data.isActive,
  })
  return c.json({ data: serializeSuper(updated) })
})

/** Delete a super admin (requires `lands.write`; the last active one is protected). */
authRoutes.delete('/supers/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requirePlatformSession(payload, 'lands.write')
  const id = c.req.param('id')
  const row = await getSuperRowById(db, id)
  if (row.is_active === 1 && (await countActiveSupers(db)) === 1) {
    throw badRequest('Cannot delete the last active super administrator', 'LAST_SUPER_ADMIN')
  }
  await deleteSuperRow(db, id)
  return c.body(null, 204)
})