/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { sql, type SQL } from 'drizzle-orm'
import type { ConfigEntry, ConfigScope } from '@hamolus/types'
import { COLONY_DEFAULT, LAND_DEFAULT } from '@hamolus/types'
import type { Db } from '../db/client'
import { badRequest, notFound } from '../errors'
import { pkIsScopeScoped } from '../meta/store'

// Matches configEntrySchema's key pattern (bind parameter, never a SQL identifier).
const KEY_PATTERN = /^[a-z][a-z0-9._-]*$/

/** Internal key/value table backing the configurations feature (never a dynamic collection). */
const TABLE = '_configs'

interface ConfigRow {
  key: string
  value: string
  scope: string
  description: string | null
  updated_at: string
}

let configReady = false

export async function ensureConfigTable(db: Db): Promise<void> {
  if (configReady) return
  const boot = db
      .run(sql.raw(`
        CREATE TABLE IF NOT EXISTS _configs (
          land TEXT NOT NULL DEFAULT 'root_lnd',
          colony TEXT NOT NULL DEFAULT 'root_cny',
          key TEXT NOT NULL COLLATE NOCASE,
          value TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'core',
          description TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (land, colony, key)
        )
      `))
      .then(async () => {
        const cols = await db.all<{ name: string }>(
          sql`PRAGMA table_info('_configs')`,
        )
        if (!cols.some((c) => c.name === 'land')) {
          await db.run(sql`ALTER TABLE _configs ADD COLUMN land TEXT NOT NULL DEFAULT 'root_lnd'`)
        }
        if (!cols.some((c) => c.name === 'colony')) {
          await db.run(
            sql`ALTER TABLE _configs ADD COLUMN colony TEXT NOT NULL DEFAULT 'root_cny'`,
          )
        }
        await db.run(
          sql`UPDATE _configs SET land = 'root_lnd' WHERE land = 'default'`,
        )
        if (!(await pkIsScopeScoped(db, '_configs'))) {
          await db.run(sql`ALTER TABLE _configs RENAME TO _configs_legacy`)
          await db.run(sql.raw(`
            CREATE TABLE _configs (
              land TEXT NOT NULL DEFAULT 'root_lnd',
              colony TEXT NOT NULL DEFAULT 'root_cny',
              key TEXT NOT NULL COLLATE NOCASE,
              value TEXT NOT NULL,
              scope TEXT NOT NULL DEFAULT 'core',
              description TEXT,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (land, colony, key)
            )
          `))
          await db.run(sql.raw(`
            INSERT INTO _configs (land, colony, key, value, scope, description, updated_at)
            SELECT 'root_lnd', 'root_cny', key, value, scope, description, updated_at
            FROM _configs_legacy
          `))
          await db.run(sql`DROP TABLE IF EXISTS _configs_legacy`)
        }
      })
  await boot
  configReady = true
}

function rowToEntry(row: ConfigRow): ConfigEntry {
  let value: unknown = row.value
  try {
    value = JSON.parse(row.value) as unknown
  } catch {
    value = row.value
  }
  return {
    key: row.key,
    value,
    scope: (row.scope as ConfigScope) || 'core',
    description: row.description,
    updatedAt: row.updated_at,
  }
}

export async function listConfigs(
  db: Db,
  scope: string | undefined,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<ConfigEntry[]> {
  await ensureConfigTable(db)
  const where: SQL[] = [sql`land = ${land}`, sql`colony = ${colony}`]
  if (scope) where.push(sql`scope = ${scope}`)
  const cond = sql`WHERE ${sql.join(where, sql` AND `)}`
  const rows = await db.all<ConfigRow>(sql`SELECT * FROM ${sql.raw(TABLE)} ${cond} ORDER BY scope ASC, key ASC`)
  return rows.map(rowToEntry)
}

export async function getConfig(
  db: Db,
  key: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<ConfigEntry> {
  await ensureConfigTable(db)
  const rows = await db.all<ConfigRow>(
    sql`SELECT * FROM ${sql.raw(TABLE)} WHERE land = ${land} AND colony = ${colony} AND key = ${key} LIMIT 1`,
  )
  if (rows.length === 0) throw notFound(`Config '${key}' not found`)
  return rowToEntry(rows[0]!)
}

export interface PutConfigInput {
  key: string
  value: unknown
  scope: ConfigScope
  description?: string | null
}

export async function putConfig(
  db: Db,
  input: PutConfigInput,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<ConfigEntry> {
  await ensureConfigTable(db)
  if (!KEY_PATTERN.test(input.key)) throw badRequest('Invalid config key')
  const value = typeof input.value === 'string' ? input.value : JSON.stringify(input.value)
  await db.run(
    sql`INSERT INTO ${sql.raw(TABLE)} (land, colony, key, value, scope, description, updated_at) VALUES (${land}, ${colony}, ${input.key}, ${value}, ${input.scope}, ${input.description ?? null}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(land, colony, key) DO UPDATE SET value = excluded.value, scope = excluded.scope, description = excluded.description, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
  return getConfig(db, input.key, land, colony)
}

export async function deleteConfig(
  db: Db,
  key: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<void> {
  await ensureConfigTable(db)
  const res = await db.run(
    sql`DELETE FROM ${sql.raw(TABLE)} WHERE land = ${land} AND colony = ${colony} AND key = ${key}`,
  )
  if (res.meta.changes === 0) throw notFound(`Config '${key}' not found`)
}