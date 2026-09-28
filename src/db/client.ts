/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import * as schema from './schema'

export type Db = DrizzleD1Database<typeof schema>

export function createDb(binding: D1Database): Db {
  return drizzle(binding, { schema })
}

/**
 * Memoized `createDb`, so code that only needs a handle for a one-off read
 * (`resolveRequestScope` looking a colony up in the registry, say) can reach for
 * the binding directly without paying for a new drizzle wrapper per call.
 */
const handles = new WeakMap<D1Database, Db>()

export function getDb(binding: D1Database): Db {
  const existing = handles.get(binding)
  if (existing) return existing
  const db = createDb(binding)
  handles.set(binding, db)
  return db
}