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
import type { ConfigEntry } from '@hamolus/types'
import { COLONY_DEFAULT, LAND_DEFAULT } from '@hamolus/types'
import type { Db } from '../db/client'
import { badRequest, notFound } from '../errors'
import { pkIsScopeScoped } from '../meta/store'

// Matches configEntrySchema's key pattern (bind parameter, never a SQL identifier).
const KEY_PATTERN = /^[a-z][a-z0-9._-]*$/

/** Internal key/value table backing the configurations feature (never a dynamic collection). */
const TABLE = '_configs'

interface ConfigRow {
  land: string
  colony: string
  key: string
  value: string
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
        // The `scope` column is gone: which colony a row belongs to *is* its scope, so
        // the old classification ('core' | 'console' | 'site') had no meaning left to
        // keep. Rebuild rather than `DROP COLUMN` — this runs on the same pass that
        // repairs the primary key, and a rebuild is the one path that also works on the
        // SQLite build D1 shipped when the column was introduced.
        //
        // The copy is `OR IGNORE` + `ORDER BY updated_at DESC` on purpose. The old primary
        // key was `(scope, key)`, so `('core', 'theme.mode')` and `('site', 'theme.mode')`
        // were two perfectly normal rows — and they now collide on `(land, colony, key)`.
        // A plain `INSERT` would abort the whole migration on exactly the databases most
        // likely to have one, which is a 500 on every config request. Newest wins: the
        // older one loses a label it no longer has, not its place in the store.
        if (cols.some((c) => c.name === 'scope') || !(await pkIsScopeScoped(db, '_configs'))) {
          await db.run(sql`ALTER TABLE _configs RENAME TO _configs_legacy`)
          await db.run(sql.raw(`
            CREATE TABLE _configs (
              land TEXT NOT NULL DEFAULT 'root_lnd',
              colony TEXT NOT NULL DEFAULT 'root_cny',
              key TEXT NOT NULL COLLATE NOCASE,
              value TEXT NOT NULL,
              description TEXT,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (land, colony, key)
            )
          `))
          await db.run(sql.raw(`
            INSERT OR IGNORE INTO _configs (land, colony, key, value, description, updated_at)
            SELECT
              CASE WHEN land = 'default' THEN 'root_lnd' ELSE land END,
              colony,
              key,
              value,
              description,
              updated_at
            FROM _configs_legacy
            ORDER BY updated_at DESC
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
    land: row.land,
    colony: row.colony,
    description: row.description,
    updatedAt: row.updated_at,
  }
}

/**
 * Which part of the tree a read covers. An empty target means "no filter" — the
 * caller has already decided that the session may see it, so the data layer does not
 * second-guess that and does not silently narrow to a default land.
 */
export interface ConfigTarget {
  /** Every colony of this land. */
  land?: string
  /** Exactly this colony, and therefore exactly this land. */
  colony?: string
}

export async function listConfigs(
  db: Db,
  target: ConfigTarget = {},
): Promise<ConfigEntry[]> {
  await ensureConfigTable(db)
  const where: SQL[] = []
  if (target.colony) {
    where.push(sql`colony = ${target.colony}`)
    // A colony id is unique platform-wide, so pinning it is enough. Passing the land
    // too would only add a second way to get the same answer wrong.
  } else if (target.land) {
    where.push(sql`land = ${target.land}`)
  }
  const cond = where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``
  const rows = await db.all<ConfigRow>(sql`SELECT * FROM ${sql.raw(TABLE)} ${cond} ORDER BY land ASC, colony ASC, key ASC`)
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
  // Always stringify, including strings. `rowToEntry` parses the column back with a
  // fallback to the raw text, so a row written before this change still reads the same
  // way — but writing a string raw meant `"123"` came back as the *number* 123 and
  // `"false"` as the boolean, which is the wrong answer to a value the caller chose as
  // text. Storing `"123"` (with the quotes) is what makes the round trip lossless.
  const value = JSON.stringify(input.value)
  await db.run(
    sql`INSERT INTO ${sql.raw(TABLE)} (land, colony, key, value, description, updated_at) VALUES (${land}, ${colony}, ${input.key}, ${value}, ${input.description ?? null}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(land, colony, key) DO UPDATE SET value = excluded.value, description = excluded.description, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
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