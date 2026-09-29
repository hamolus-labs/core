/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import type { AuthTokenPayload, Permission } from '@hamolus/types'
import { PERMISSIONS } from '@hamolus/types'
import { verify } from 'hono/jwt'
import { forbidden, unauthorized } from '../errors'

/**
 * Permission helpers around the decoded JWT payload.
 * A legacy ADMIN_KEY `/token` issues `sub: 'admin'` with no permission list;
 * it is treated as implicit full access.
 */
export function sessionPermissions(payload: AuthTokenPayload | undefined): Permission[] {
  if (!payload) return []
  if (payload.sub === 'admin' && !payload.permissions) return [...PERMISSIONS]
  return payload.permissions ?? []
}

export function hasPermission(payload: AuthTokenPayload | undefined, perm: Permission): boolean {
  if (!payload) return false
  if (payload.sub === 'admin' && !payload.permissions) return true
  if (payload.role === 'admin') return true
  return (payload.permissions ?? []).includes(perm)
}

/**
 * Writes always require an authenticated session with the given permission.
 * Asserts like `requireSession` so a route can keep using the payload afterwards
 * without re-narrowing it at every call site.
 */
export function requireWrite(
  payload: AuthTokenPayload | undefined,
  perm: Permission,
): asserts payload is AuthTokenPayload {
  requireSession(payload, perm)
}

/** A session must be present (never anonymous) and hold the permission. */
export function requireSession(payload: AuthTokenPayload | undefined, perm: Permission): asserts payload is AuthTokenPayload {
  if (!payload) throw unauthorized('Authentication required')
  if (!hasPermission(payload, perm)) throw forbidden(`Missing permission: ${perm}`)
}

/**
 * Reads require the permission only when a session is present — an anonymous
 * request is allowed (this is what powers `PUBLIC_GETS` and the public site).
 */
export function requireRead(payload: AuthTokenPayload | undefined, perm: Permission): void {
  if (!payload) return
  if (!hasPermission(payload, perm)) throw forbidden(`Missing permission: ${perm}`)
}

/** Decode a `Bearer <token>` header directly (used by GET routes that the middleware may skip). */
export async function decodeBearer(
  secret: string,
  header?: string,
): Promise<AuthTokenPayload | undefined> {
  if (!header?.startsWith('Bearer ')) return undefined
  try {
    return (await verify(header.slice(7), secret, 'HS256')) as unknown as AuthTokenPayload
  } catch {
    return undefined
  }
}