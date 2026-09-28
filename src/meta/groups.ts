/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { GroupDefinition } from '@hamolus/types'
import { COLONY_DEFAULT, LAND_DEFAULT, groupDefinitionSchema } from '@hamolus/types'
import type { Db } from '../db/client'
import { metaGroups, type MetaGroupRow } from '../db/schema'
import { isIdentifier } from '../db/table'
import { badRequest, notFound } from '../errors'

let groupsReady = false

async function pkIsComposite(db: Db, table: string): Promise<boolean> {
  const indexes = await db.all<{ name: string; origin: string }>(
    sql`PRAGMA index_list(${sql.raw(`'${table}'`)})`,
  )
  const pkIdx = indexes.find((i) => i.origin === 'pk')
  if (!pkIdx) return false
  const info = await db.all<{ seqno: number }>(
    sql`PRAGMA index_info(${sql.raw(`'${pkIdx.name}'`)})`,
  )
  return info.length > 1
}

/** Auto-bootstrap the _meta_groups metadata table. Idempotent; runs once per isolate. */
export async function ensureGroupsTable(db: Db): Promise<void> {
  if (groupsReady) return
  const boot = db
      .run(sql.raw(`
        CREATE TABLE IF NOT EXISTS _meta_groups (
          land TEXT NOT NULL DEFAULT 'root_lnd',
          colony TEXT NOT NULL DEFAULT 'root_cny',
          id TEXT NOT NULL,
          label TEXT NOT NULL,
          parent TEXT,
          icon TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (land, colony, id)
        )
      `))
      .then(async () => {
        // Land column + composite PK (land, id) migration for legacy tables.
        const cols = await db.all<{ name: string }>(
          sql`PRAGMA table_info('_meta_groups')`,
        )
        if (!cols.some((c) => c.name === 'land')) {
          await db.run(sql`ALTER TABLE _meta_groups ADD COLUMN land TEXT NOT NULL DEFAULT 'root_lnd'`)
        }
        if (!cols.some((c) => c.name === 'colony')) {
          await db.run(
            sql`ALTER TABLE _meta_groups ADD COLUMN colony TEXT NOT NULL DEFAULT 'root_cny'`,
          )
        }
        const dupes = await db.all<{ id: string }>(
          sql`SELECT id FROM _meta_groups GROUP BY id HAVING COUNT(*) > 1`,
        )
        if (dupes.length > 0) {
          await db.run(sql`
            DELETE FROM _meta_groups
            WHERE rowid NOT IN (
              SELECT MAX(rowid) FROM _meta_groups GROUP BY id
            )
          `)
        }
        if (!(await pkIsComposite(db, '_meta_groups'))) {
          await db.run(sql`DROP INDEX IF EXISTS idx_meta_groups_id`)
          await db.run(sql`ALTER TABLE _meta_groups RENAME TO _meta_groups_legacy`)
          await db.run(sql.raw(`
            CREATE TABLE _meta_groups (
              land TEXT NOT NULL DEFAULT 'root_lnd',
              colony TEXT NOT NULL DEFAULT 'root_cny',
              id TEXT NOT NULL,
              label TEXT NOT NULL,
              parent TEXT,
              icon TEXT,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (land, colony, id)
            )
          `))
          await db.run(sql.raw(`
            INSERT INTO _meta_groups (land, colony, id, label, parent, icon, created_at, updated_at)
            SELECT land, colony, id, label, parent, icon, created_at, updated_at FROM _meta_groups_legacy
          `))
          await db.run(sql`DROP TABLE IF EXISTS _meta_groups_legacy`)
        }
      })
  await boot
  groupsReady = true
}

function rowToGroup(row: MetaGroupRow): GroupDefinition {
  return { id: row.id, label: row.label, parent: row.parent ?? null, icon: row.icon ?? undefined }
}

/** All registered groups, in creation order. */
export async function listGroups(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<GroupDefinition[]> {
  await ensureGroupsTable(db)
  const rows = await db
    .select()
    .from(metaGroups)
    .where(and(eq(metaGroups.land, land), eq(metaGroups.colony, colony)))
    .orderBy(metaGroups.createdAt)
  const seen = new Set<string>()
  const out: GroupDefinition[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(rowToGroup(row))
  }
  return out
}

export async function getGroup(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<GroupDefinition> {
  await ensureGroupsTable(db)
  const row = await db
    .select()
    .from(metaGroups)
    .where(and(eq(metaGroups.land, land), eq(metaGroups.colony, colony), eq(metaGroups.id, id)))
    .get()
  if (!row) throw notFound(`Group '${id}' not found`, 'GROUP_NOT_FOUND')
  return rowToGroup(row)
}

/** Walk a group's ancestor chain (id → parent → …) and verify it never reaches `self`. */
async function assertNoCycle(
  db: Db,
  self: string,
  parent: string | null | undefined,
  land: string,
  colony: string,
): Promise<void> {
  let cursor = parent ?? null
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === self) {
      throw badRequest(`Group '${self}' would create a parent cycle`, 'GROUP_CYCLE')
    }
    if (seen.has(cursor)) {
      throw badRequest(`Group parent chain contains a cycle at '${cursor}'`, 'GROUP_CYCLE')
    }
    seen.add(cursor)
    const row = await db
      .select()
      .from(metaGroups)
      .where(and(eq(metaGroups.land, land), eq(metaGroups.colony, colony), eq(metaGroups.id, cursor)))
      .get()
    if (!row) break
    cursor = row.parent
  }
}

/** Upsert a group definition (registry + nesting parent validated, cycle-checked). */
export async function putGroup(
  db: Db,
  input: Record<string, unknown>,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<GroupDefinition> {
  await ensureGroupsTable(db)

  const parsed = groupDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    throw badRequest('Invalid group definition: ' + parsed.error.issues.map((i) => i.message).join('; '), 'INVALID_GROUP')
  }
  const def = parsed.data
  if (!isIdentifier(def.id)) throw badRequest('Group id must be snake_case', 'INVALID_GROUP')

  if (def.parent) {
    // Parent must exist (or be about to be created on the same call is not allowed).
    try {
      await getGroup(db, def.parent, land, colony)
    } catch {
      throw badRequest(`Parent group '${def.parent}' is not registered`, 'GROUP_PARENT_NOT_FOUND')
    }
    await assertNoCycle(db, def.id, def.parent, land, colony)
  }

  const now = new Date().toISOString()
  await db
    .insert(metaGroups)
    .values({
      land,
      colony,
      id: def.id,
      label: def.label,
      parent: def.parent ?? null,
      icon: def.icon ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [metaGroups.land, metaGroups.colony, metaGroups.id],
      set: {
        label: def.label,
        parent: def.parent ?? null,
        icon: def.icon ?? null,
        updatedAt: now,
      },
    })

  return def
}

/** Delete a group. Guards: reject when child groups or collections still reference it. */
export async function deleteGroup(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<void> {
  await ensureGroupsTable(db)
  await getGroup(db, id, land, colony)

  const children = await db
    .select({ id: metaGroups.id })
    .from(metaGroups)
    .where(and(eq(metaGroups.land, land), eq(metaGroups.colony, colony), eq(metaGroups.parent, id)))
  if (children.length > 0) {
    throw badRequest(`Group '${id}' still has ${children.length} child group(s); move or delete them first`, 'GROUP_IN_USE')
  }

  const used = await db.all<{ name: string }>(
    sql`SELECT name FROM _meta_collections WHERE land = ${land} AND colony = ${colony} AND "group" = ${id} LIMIT 1`,
  )
  if (used.length > 0) {
    throw badRequest(`Group '${id}' is still used by collection '${used[0].name}'`, 'GROUP_IN_USE')
  }

  await db
    .delete(metaGroups)
    .where(and(eq(metaGroups.land, land), eq(metaGroups.colony, colony), eq(metaGroups.id, id)))
}