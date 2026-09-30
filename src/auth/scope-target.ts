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
 * Which land/colony a scoped administrative request is allowed to act on.
 *
 * Extracted from `routes/config.ts` so every scoped surface answers the question
 * the same way. A second implementation would be a second set of answers, and
 * the differences would only surface once a deployment has two lands.
 *
 * The rule both surfaces share: a `?land=` / `?colony=` selector is a *request*,
 * never a grant. It narrows what the caller asked for; it can never widen what
 * their privilege already reaches. That is what `check:config-scope-acl` pins.
 */

import { COLONY_DEFAULT, LAND_DEFAULT } from '@hamolus/types'
import type { AuthTokenPayload } from '@hamolus/types'
import type { Db } from '../db/client'
import { badRequest, forbidden, notFound } from '../errors'
import { ensureLandsRegistry } from '../meta/lands'
import type { Env } from '../env'
import type { ScopeContext } from '../scope'

/** A session that may act on any land. */
export function isPlatformAdmin(payload: AuthTokenPayload): boolean {
  if (payload.sub === 'admin' && !payload.permissions) return true
  return payload.scope === 'universe'
}

/**
 * The land a colony belongs to, read from the registry snapshot the scope
 * resolver already memoizes per isolate. A colony that was never registered has
 * no owner, and configuration for a colony that does not exist is not
 * addressable.
 */
async function ownerOfColony(db: Db, env: Env, colony: string): Promise<string> {
  const registry = await ensureLandsRegistry(db, env.SETTINGS)
  const owner = registry.ownerOf.get(colony)
  if (!owner) throw notFound(`Colony '${colony}' is not registered`)
  return owner
}

export async function assertColonyInLand(
  db: Db,
  env: Env,
  colony: string,
  land: string,
): Promise<void> {
  const owner = await ownerOfColony(db, env, colony)
  if (owner !== land) {
    throw forbidden(`Colony '${colony}' belongs to land '${owner}', not '${land}'`)
  }
}

/** A read's reach: every colony, one land, or exactly one colony. */
export interface ListTarget {
  land?: string
  colony?: string
}

/** A write's target: one colony, and therefore one land. */
export interface ColonyTarget {
  land: string
  colony: string
}

export interface ScopeQuery {
  land?: string
  colony?: string
}

/**
 * How wide a read may be. With no query this is the widest thing the session can
 * legitimately see — every land for a superadmin, the whole land for a land
 * admin, the one colony for a colony admin — so the default is never a silent
 * guess.
 */
export async function resolveListTarget(
  db: Db,
  env: Env,
  payload: AuthTokenPayload,
  query: ScopeQuery,
  session: ScopeContext,
): Promise<ListTarget> {
  if (isPlatformAdmin(payload)) {
    if (query.colony) {
      // `?land` next to `?colony` is a claim about the same row, so it has to
      // agree with the registry. Ignoring it would answer "here are land B's
      // rows" with land A's — a wrong answer that looks like a right one.
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
 * The one colony a single-entry request acts on. A land admin has to name it: a
 * land owns colonies rather than being one, and picking one for them would write
 * their configuration into a colony they never mentioned.
 */
export async function resolveColonyTarget(
  db: Db,
  env: Env,
  payload: AuthTokenPayload,
  query: ScopeQuery,
  session: ScopeContext,
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

export const DEFAULT_SCOPE: ColonyTarget = { land: LAND_DEFAULT, colony: COLONY_DEFAULT }
