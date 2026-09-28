/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import type { CoreMode } from '@hamolus/types'
import { COLONY_DEFAULT, COLONY_SUFFIX, CORE_MODES, LAND_DEFAULT, LAND_SUFFIX, isColonyId, isLandId, scopeNameSchema } from '@hamolus/types'
import type { ExecutionContext, MiddlewareHandler } from 'hono'
import type { Env } from './env'
import type { Db } from './db/client'
import { createDb, getDb } from './db/client'
import { HttpError } from './errors'
import { ensureAllCollectionNames } from './meta/store'
import { ensureLandsRegistry } from './meta/lands'

export const SCOPE_REQUIRED = 'SCOPE_REQUIRED'
export const SCOPE_MISMATCH = 'SCOPE_MISMATCH'
export const UNKNOWN_LAND = 'UNKNOWN_LAND'
export const UNKNOWN_COLONY = 'UNKNOWN_COLONY'
export const INVALID_LAND = 'INVALID_LAND'
export const INVALID_COLONY = 'INVALID_COLONY'

/** The resolved scope for the request being served. */
export interface ScopeContext {
  mode: CoreMode
  land: string
  colony: string
}

/** Effective scope behavior of an env. Defaults to `independent`. */
export function scopeMode(env: Env): CoreMode {
  const m = env.CORE_MODE?.trim()
  return m && (CORE_MODES as readonly string[]).includes(m) ? (m as CoreMode) : 'independent'
}

/** Land used by bare/unprefixed requests. Defaults to the reserved root land. */
export function defaultLandId(env: Env): string {
  const parsed = scopeNameSchema.safeParse(env.DEFAULT_LAND?.trim().toLowerCase())
  return parsed.success ? parsed.data : LAND_DEFAULT
}

/** Colony used by bare/unprefixed requests, and by `x-land`-only requests. */
export function defaultColonyId(env: Env): string {
  const parsed = scopeNameSchema.safeParse(env.DEFAULT_COLONY?.trim().toLowerCase())
  return parsed.success ? parsed.data : COLONY_DEFAULT
}

/**
 * Re-dispatch target for the scope path rewrite. Wired to the hono app's `fetch`
 * so a rewritten request traverses the whole middleware chain again.
 */
export type ScopeAppFetch = (
  request: Request,
  bindings: Env,
  executionCtx: ExecutionContext,
) => Response | Promise<Response>

/**
 * Pre-auth scope path rewrite (`/api/{land}[/{colony}]/…` → `/api/…` with an
 * `x-colony` header + `x-scope-rewritten: 1` loop guard).
 *
 * Only fires when the first segment is a REGISTERED land (and not rewritten yet,
 * ahead of proxy/bridge modes). A registered land id that collides with a
 * default-scope collection name is never rewritten — the bare/collection
 * interpretation wins. The land is dropped from the path and recorded as
 * `x-land`; when a registered colony of that land follows, it is dropped too and
 * recorded as `x-colony`.
 */
export function createScopeRewrite(appFetch: ScopeAppFetch): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (c.req.header('x-scope-rewritten')) return next()
    const mode = scopeMode(c.env)
    if (mode === 'proxy' || mode === 'bridge') return next()
    const path = c.req.path
    if (!path.startsWith('/api/')) return next()
    const segs = path.slice('/api'.length).split('/').filter(Boolean)
    if (segs.length === 0) return next()
    const seg0 = segs[0]
    // Land ids cannot start with `_`; built-in routes (`_meta`/`_auth`/…) never rewrite.
    if (seg0.startsWith('_')) return next()

    const db: Db = createDb(c.env.DB)
    const registry = await ensureLandsRegistry(db, c.env.SETTINGS)
    if (!registry.lands.has(seg0)) return next()
    // A collection in the default scope named like the land id wins (healthy data
    // keeps a collection and a land id from clashing).
    const defaultCols = await ensureAllCollectionNames(db)
    if (defaultCols.has(seg0)) return next()

    const colony =
      segs.length >= 2 && registry.colonies.get(seg0)?.has(segs[1]) ? segs[1] : undefined
    const strip = colony ? 2 : 1
    const newPath = '/api' + (segs.length > strip ? '/' + segs.slice(strip).join('/') : '')

    const url = new URL(c.req.url)
    url.pathname = newPath
    const headers = new Headers(c.req.raw.headers)
    headers.set('x-land', seg0)
    if (colony) headers.set('x-colony', colony)
    headers.set('x-scope-rewritten', '1')

    const init: RequestInit = {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
    }
    return appFetch(
      // `duplex: 'half'` is required by the fetch spec when re-posting a stream
      // body; the runtime accepts it even though the ambient type omits it.
      new Request(url, { ...init, duplex: 'half' } as unknown as RequestInit),
      c.env,
      c.executionCtx,
    )
  }
}

/**
 * Global path prefixes that never belong to a scope. Requests to these are served
 * without needing a resolved scope in centralized mode; everything else under
 * `/api` is scope-scoped and requires an explicit header or JWT claim. Exact
 * paths and their sub-paths match (e.g. `/api/_meta/universe/lands` covers
 * `/api/_meta/universe/lands/{id}`).
 */
const GLOBAL_PATH_PREFIXES = [
  '/api/health',
  '/api/_auth/token',
  '/api/_auth/login',
  '/api/_auth/setup',
  '/api/_auth/super',
  '/api/_auth/supers',
  '/api/_auth/me',
  '/api/_meta/universe/lands',
  '/api/_meta/universe/colonies',
]

/**
 * Validate a client-supplied scope id and return it canonicalized (lowercased,
 * suffixed). The **base** name is what gets validated: `root` is reserved for the
 * unnamed land/colony (so `root_lnd`/`root_cny` are legal ids) but may not be
 * re-typed as a fresh scope, and `default` is reserved outright.
 */
function parseRequestedId(raw: string, suffix: string, code: string, label: string): string {
  const value = raw.trim().toLowerCase()
  if (!value) throw new HttpError(400, code, `An empty ${label} id was requested`)
  if (!value.endsWith(suffix)) {
    throw new HttpError(
      400,
      code,
      `Invalid ${label} id '${value}' — expected it to end with '${suffix}'`,
    )
  }
  const base = value.slice(0, -suffix.length)
  if (!base) throw new HttpError(400, code, `Invalid ${label} id '${value}' — the name is empty`)
  if (base === 'default') {
    throw new HttpError(400, code, `'${base}' is a reserved ${label} name — choose another`)
  }
  const rootBase = `root${suffix}`
  if (base !== 'root') {
    // Any other base must satisfy the shared name rules (pattern + length + no
    // reserved words); `root` is the single allowed exception and must be exactly
    // `root` + this axis' suffix, so a cross-axis id never validates here.
    const parsed = scopeNameSchema.safeParse(base)
    if (!parsed.success) {
      const why = parsed.error.issues[0]?.message ?? 'invalid name'
      throw new HttpError(400, code, `Invalid ${label} id '${value}' — ${why.toLowerCase()}`)
    }
  } else if (value !== rootBase) {
    throw new HttpError(400, code, `Invalid ${label} id '${value}'`)
  }
  return `${base}${suffix}`
}

/**
 * Resolve the effective `ScopeContext` for the current request.
 *
 * Resolution order:
 *  1. `x-colony` — the console and every other client send only this. The parent
 *     land is looked up in the colony registry, so a colony id alone is enough.
 *  2. `x-land` — land-admin tooling. A bare `x-land` uses the default colony of
 *     that land; combined with `x-colony` the colony must belong to the land.
 *  3. JWT `land`/`colony` claims.
 *  4. The default land and colony from env.
 *
 * A token that is scoped to a different land than the requested one is rejected
 * with `SCOPE_MISMATCH` (a token must never cross lands). In centralized mode a
 * request with no header and no JWT scope is rejected with `400 SCOPE_REQUIRED`
 * unless its path is global.
 */
export async function resolveRequestScope(
  c: {
    env: Env
    req: { header(name: string): string | undefined; path?: string }
    get(key: string): unknown
  },
  db?: Db,
): Promise<ScopeContext> {
  const mode = scopeMode(c.env)
  if (mode === 'proxy' || mode === 'bridge') {
    return { mode, land: defaultLandId(c.env), colony: defaultColonyId(c.env) }
  }

  const headerLand = c.req.header('x-land')?.trim().toLowerCase()
  const headerColony = c.req.header('x-colony')?.trim().toLowerCase()
  const payload = c.get('jwtPayload') as { land?: string; colony?: string } | undefined
  const path = c.req.path ?? ''
  const isGlobal = GLOBAL_PATH_PREFIXES.some(
    (p) => path === p || (path.startsWith(p) && path.charCodeAt(p.length) === 47 /* '/' */),
  )

  if (mode === 'centralized' && !headerLand && !headerColony && !payload?.land && !isGlobal) {
    throw new HttpError(
      400,
      SCOPE_REQUIRED,
      `This endpoint requires a scope — pass an 'x-colony' or 'x-land' header, or use a scoped JWT (path '${path}')`,
    )
  }

  if (headerColony && !isColonyId(headerColony)) {
    throw new HttpError(
      400,
      INVALID_COLONY,
      `Invalid colony id '${headerColony}' — expected a '${COLONY_SUFFIX}'-suffixed id`,
    )
  }
  if (headerLand && !isLandId(headerLand)) {
    throw new HttpError(
      400,
      INVALID_LAND,
      `Invalid land id '${headerLand}' — expected a '${LAND_SUFFIX}'-suffixed id`,
    )
  }

  // A colony-only request derives its land from the registry; otherwise fall back
  // to the land header/claim. Explicit ids win over the defaults.
  let land = headerLand || payload?.land || defaultLandId(c.env)
  let colony = headerColony || payload?.colony || defaultColonyId(c.env)

  // The registry is only consulted when a colony needs a parent lookup, so the
  // common default-scope request pays no extra D1 round trip. When the caller
  // has no handle we build one from the binding rather than skipping the check:
  // a route that re-resolved the scope without the registry silently fell back
  // to the default land, so an `x-colony` owned by another land wrote into the
  // wrong land's namespace. `ensureLandsRegistry` memoizes per isolate, so the
  // lookup costs one D1 read for the isolate, not per request.
  if (headerColony) {
    const registry = await ensureLandsRegistry(db ?? getDb(c.env.DB), c.env.SETTINGS)
    const owner = registry.ownerOf.get(headerColony)
    if (!owner) {
      throw new HttpError(404, UNKNOWN_COLONY, `Colony '${headerColony}' is not registered`)
    }
    if (headerLand && headerLand !== owner) {
      throw new HttpError(
        400,
        SCOPE_MISMATCH,
        `Colony '${headerColony}' belongs to land '${owner}', not '${headerLand}'`,
      )
    }
    land = owner
  }

  // A token must never cross lands. Land-admin tooling legitimately holds a
  // land-wide token and may address any colony of that land, so a colony claim
  // only has to match when the token actually names a colony.
  if (payload?.land && land !== payload.land) {
    throw new HttpError(
      403,
      SCOPE_MISMATCH,
      `JWT token is scoped to land '${payload.land}' but the request resolved to '${land}'`,
    )
  }
  if (payload?.colony && headerColony && payload.colony !== headerColony) {
    throw new HttpError(
      403,
      SCOPE_MISMATCH,
      `JWT token is scoped to colony '${payload.colony}' but the request asked for '${headerColony}'`,
    )
  }

  return { mode, land, colony }
}

export { parseRequestedId }
