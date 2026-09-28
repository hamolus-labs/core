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
import type { Db } from './client'
import { quoteIdentifier } from './table'

interface PragmaCol {
  name: string
  type: string | null
  notnull: number
  dflt_value: string | number | null
  pk: number
}

async function tableInfo(db: Db, table: string): Promise<PragmaCol[]> {
  return db.all<PragmaCol>(
    sql`PRAGMA table_info(${sql.raw(quoteIdentifier(table))})`,
  )
}

/**
 * Add a `land TEXT NOT NULL DEFAULT 'default'` column when missing (idempotent).
 * SQLite allows adding a NOT NULL column with a constant default, so existing
 * rows are backfilled to the legacy single-land scope (`default`).
 */
export async function ensureLandColumn(db: Db, table: string): Promise<void> {
  const cols = await tableInfo(db, table)
  if (!cols.some((c) => c.name === 'land')) {
    await db.run(
      sql`ALTER TABLE ${sql.raw(quoteIdentifier(table))} ADD COLUMN land TEXT NOT NULL DEFAULT 'default'`,
    )
  }
}

/**
 * Rebuild a table into the composite primary key `(land, key…)`. Idempotent:
 * once the PK already starts with `land` this is a no-op. The rebuild is
 * required because SQLite cannot ALTER a PRIMARY KEY — SQLite only allows nop
 * changes plus ADD COLUMN — so we clone the table, copy rows, drop + rename.
 *
 * The clone keeps every column exactly as PRAGMA reports it (type, NOT NULL
 * flags and raw defaults), so optional backfilled columns (e.g. `_meta_
 * collections.group` / `icon`) are always carried through. `foreign_keys` is
 * toggled off during the swap (D1 enforces FKs off by default anyway).
 */
export async function ensureCompositeLandPk(
  db: Db,
  table: string,
  pk: string[],
): Promise<void> {
  await ensureLandColumn(db, table)
  const info = await tableInfo(db, table)
  const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name)
  const isComposite = pkCols.length === pk.length && pk.every((p) => pkCols.includes(p))
  if (isComposite) return

  const legacy = `${table}__legacy_${Math.random().toString(36).slice(2, 8)}`
  const qtab = quoteIdentifier(table)

  const colDefs = info.map((c) => {
    let d = `${quoteIdentifier(c.name)} ${(c.type ?? '').trim()}`
    if (c.notnull === 1) d += ' NOT NULL'
    if (c.dflt_value !== null && c.dflt_value !== undefined) {
      d += ` DEFAULT ${String(c.dflt_value)}`
    }
    return d
  })

  await db.run('PRAGMA foreign_keys=OFF')
  try {
    await db.run(sql`ALTER TABLE ${sql.raw(qtab)} RENAME TO ${sql.raw(quoteIdentifier(legacy))}`)
    await db.run(
      sql`CREATE TABLE ${sql.raw(qtab)} (${sql.raw(colDefs.join(', '))}, PRIMARY KEY (${sql.raw(pk.map(quoteIdentifier).join(', '))}))`,
    )
    const names = (await tableInfo(db, legacy)).map((c) => c.name)
    const qn = names.map(quoteIdentifier).join(', ')
    await db.run(
      sql`INSERT INTO ${sql.raw(qtab)} (${sql.raw(qn)}) SELECT ${sql.raw(qn)} FROM ${sql.raw(quoteIdentifier(legacy))}`,
    )
    await db.run(sql`DROP TABLE ${sql.raw(quoteIdentifier(legacy))}`)
  } finally {
    await db.run('PRAGMA foreign_keys=ON')
  }
}

/**
 * Ensure a UNIQUE index on `(land, key)` so future rows cannot collide across
 * lands even when the row primary key stays a single UUID column.
 */
export async function ensureUniqueLandIndex(
  db: Db,
  table: string,
  name: string,
  cols: string[],
): Promise<void> {
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw('idx_' + name)} ON ${sql.raw(quoteIdentifier(table))} (${sql.raw(cols.map(quoteIdentifier).join(', '))})`,
  )
}