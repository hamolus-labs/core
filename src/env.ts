/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types'

export interface Env {
  /** D1 binding from wrangler.jsonc */
  DB: D1Database
  /** KV binding for site settings / configuration */
  SETTINGS: KVNamespace
  /** R2 bucket for media assets (`/media/*` public, managed via `/api/_media`) */
  MEDIA: R2Bucket
  /** Secret used to sign JWTs. Production: `wrangler secret put JWT_SECRET` */
  JWT_SECRET: string
  /** Key for admin login (`POST /api/_auth/token`). Production: `wrangler secret put ADMIN_KEY` */
  ADMIN_KEY: string
  /** Optional separate secret for short-lived private Panel asset URLs. */
  PANEL_ASSET_SECRET?: string
  /**
   * Optional bootstrap of a platform super admin (`_auth_super`): the first
   * request seeds this global cross-land account when the table is empty.
   * Production: `wrangler secret put SUPER_ADMIN_USERNAME/PASSWORD`.
   */
  SUPER_ADMIN_USERNAME?: string
  SUPER_ADMIN_PASSWORD?: string
  /** 'true' => GET /api endpoints are public without JWT (used by site SSG) */
  PUBLIC_GETS?: string
  /**
   * Scope behavior: 'independent' (default, single land) | 'centralized'
   * (URL-scoped `/{land}` lands) | 'proxy' | 'bridge'. Production:
   * `wrangler secret put CORE_MODE` or a `var`.
   */
  CORE_MODE?: string
  /** Land used by bare/unprefixed requests (default 'default'). */
  DEFAULT_LAND?: string

  /**
   * Colony used by bare/unprefixed requests and by `x-land`-only (land-admin)
   * requests. Defaults to the reserved root colony `root_cny`.
   */
  DEFAULT_COLONY?: string
}

export function publicGetsEnabled(env: Env): boolean {
  return env.PUBLIC_GETS === 'true'
}