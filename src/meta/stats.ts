/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { sql } from 'drizzle-orm'
import type { CollectionStat, DashboardStats } from '@hamolus/types'
import type { Db } from '../db/client'
import { physicalTableName, quoteIdentifier } from '../db/table'
import { COLONY_DEFAULT, LAND_DEFAULT } from '@hamolus/types'
import { listCollections } from './store'
import { ensureMediaTable } from '../media/store'

/**
 * Aggregate dashboard statistics: collection/record/media counts and a per-collection
 * record breakdown. Row counts respect soft-delete (deleted_at IS NULL).
 */
export async function getDashboardStats(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<DashboardStats> {
  const defs = await listCollections(db, land, colony)

  const perCollection: CollectionStat[] = []
  let totalRecords = 0
  for (const def of defs) {
    const table = sql.raw(quoteIdentifier(physicalTableName(def)))
    const where = def.softDelete ? sql` WHERE deleted_at IS NULL` : sql``
    const row = await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM ${table}${where}`)
    const count = Number(row?.total ?? 0)
    totalRecords += count
    perCollection.push({
      name: def.name,
      label: def.label,
      icon: def.icon,
      group: def.group,
      count,
    })
  }

  await ensureMediaTable(db)
  const mediaRow = await db.get<{ total: number }>(
    sql`SELECT count(*) AS total FROM _meta_media WHERE land = ${land} AND colony = ${colony}`,
  )

  const groups = new Set(defs.map((d) => d.group).filter((g): g is string => !!g))

  return {
    collections: defs.length,
    totalRecords,
    media: Number(mediaRow?.total ?? 0),
    groups: groups.size,
    perCollection,
  }
}
