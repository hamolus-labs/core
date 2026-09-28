/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import type { CollectionDefinition, FieldDefinition, FieldType } from '@hamolus/types'
import { COLONY_DEFAULT, LAND_DEFAULT, TABLE_SEP } from '@hamolus/types'

const IDENTIFIER = /^[a-z][a-z0-9_]*$/

export function isIdentifier(value: string): boolean {
  return IDENTIFIER.test(value)
}

export function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"'
}

/**
 * Physical D1 table name for a collection inside a scope. Every scope owns its
 * own table, so the name is always fully nested:
 * `{land}__{colony}__{collection}` — e.g. `root_lnd__root_cny__posts` for the
 * default scope and `acme_lnd__purchasing_cny__posts` for a named one. Because
 * each table belongs to exactly one scope, record tables need no `land`/`colony`
 * columns and keep a single-column primary key.
 */
export function physicalTable(land: string, colony: string, name: string): string {
  const l = land || LAND_DEFAULT
  const c = colony || COLONY_DEFAULT
  if (!isIdentifier(l)) throw new Error(`Invalid land id for physical table: ${l}`)
  if (!isIdentifier(c)) throw new Error(`Invalid colony id for physical table: ${c}`)
  if (!isIdentifier(name)) throw new Error(`Invalid collection name for physical table: ${name}`)
  return `${l}${TABLE_SEP}${c}${TABLE_SEP}${name}`
}

/** The `{land}__{colony}__` prefix shared by every table in a scope. */
export function scopeTablePrefix(land: string, colony: string): string {
  const l = land || LAND_DEFAULT
  const c = colony || COLONY_DEFAULT
  if (!isIdentifier(l)) throw new Error(`Invalid land id for table prefix: ${l}`)
  if (!isIdentifier(c)) throw new Error(`Invalid colony id for table prefix: ${c}`)
  return `${l}${TABLE_SEP}${c}${TABLE_SEP}`
}

/** True when `table` belongs to the given scope. */
export function tableInScope(table: string, land: string, colony: string): boolean {
  return table.startsWith(scopeTablePrefix(land, colony))
}

/**
 * Non-enumerable stamp carrying the resolved physical table name on a
 * `CollectionDefinition`. The registry computes it once per scope; `db/queries`
 * reads it so no caller has to thread a land/colony argument through.
 */
export const PHYSICAL_TABLE = Symbol.for('@hamolus/core/physicalTable')
export type StampedCollection = CollectionDefinition & { [PHYSICAL_TABLE]: string }
export function stampPhysicalTable(
  def: CollectionDefinition,
  land: string,
  colony: string,
): StampedCollection {
  const stamped = def as StampedCollection
  if (stamped[PHYSICAL_TABLE] === undefined) {
    Object.defineProperty(stamped, PHYSICAL_TABLE, {
      value: physicalTable(land, colony, def.name),
      enumerable: false,
      configurable: true,
    })
  }
  return stamped
}
export function physicalTableName(def: CollectionDefinition): string {
  const stamped = def as Partial<StampedCollection>
  return stamped[PHYSICAL_TABLE] ?? def.name
}

const SQLITE_COLUMN: Record<FieldType, string> = {
  id: 'TEXT',
  string: 'TEXT',
  slug: 'TEXT',
  text: 'TEXT',
  richtext: 'TEXT',
  email: 'TEXT',
  url: 'TEXT',
  date: 'TEXT',
  datetime: 'TEXT',
  enum: 'TEXT',
  relation: 'TEXT',
  media: 'TEXT',
  document: 'TEXT',
  attachment: 'TEXT',
  json: 'TEXT',
  number: 'NUMERIC',
  currency: 'NUMERIC',
  custom_currency: 'NUMERIC',
  boolean: 'INTEGER',
}

export function columnType(field: FieldDefinition): string {
  return SQLITE_COLUMN[field.type]
}

function renderDefault(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

function fieldTimestamps(): string[] {
  return [
    `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    `updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ]
}

/** Define all non-id columns usable in INSERT/UPDATE. */
export function dataFields(def: CollectionDefinition): FieldDefinition[] {
  return def.fields.filter((f) => f.type !== 'id')
}

/** Kolom id / primary key. */
export function pkField(def: CollectionDefinition): FieldDefinition {
  const pk = def.primaryKey ?? 'id'
  return def.fields.find((f) => f.name === pk) ?? { name: pk, type: 'id' }
}

/** Audit-trace columns names (created_by / updated_by / deleted_by). */
export function auditColumns(def: CollectionDefinition): string[] {
  const names = new Set(def.fields.map((f) => f.name))
  const cols: string[] = []
  if (def.timestamps && !names.has('created_by') && !names.has('updated_by')) {
    cols.push('created_by', 'updated_by')
  }
  if (def.softDelete && !names.has('deleted_by')) {
    cols.push('deleted_by')
  }
  return cols
}

/**
 * Ensure the physical table for a collection exists (idempotent). A table
 * belongs to exactly one scope, so it carries no `land`/`colony` columns and
 * keeps a single-column PRIMARY KEY.
 */
export function buildCreateTableSql(
  def: CollectionDefinition,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): string {
  const pk = pkField(def)
  const columns: string[] = []

  if (!def.fields.some((f) => f.name === pk.name)) {
    columns.push(`${quoteIdentifier(pk.name)} TEXT PRIMARY KEY`)
  }

  for (const field of def.fields) {
    const parts = [quoteIdentifier(field.name), columnType(field)]
    if (field.name === pk.name) parts.push('PRIMARY KEY')
    if (field.required) parts.push('NOT NULL')
    if (field.unique) parts.push('UNIQUE')
    if (field.default !== undefined && field.type !== 'id') {
      parts.push(`DEFAULT ${renderDefault(field.default)}`)
    }
    columns.push(parts.join(' '))
  }

  if (def.timestamps) columns.push(...fieldTimestamps())
  if (def.softDelete) columns.push(`deleted_at TEXT`)

  // Audit trail — who created/updated/deleted each row. The actor username is
  // written by the queries layer from the JWT (fallback 'system'); a user field
  // named exactly like an audit column keeps its own column (no collision).
  for (const col of auditColumns(def)) columns.push(`${quoteIdentifier(col)} TEXT`)

  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(physicalTable(land, colony, def.name))} (${columns.join(', ')})`
}

export function buildDropTableSql(
  name: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): string {
  return `DROP TABLE IF EXISTS ${quoteIdentifier(physicalTable(land, colony, name))}`
}

/** Render a single column definition (without PRIMARY KEY), usable for ALTER TABLE ADD COLUMN. */
export function addColumnSql(
  def: CollectionDefinition,
  field: FieldDefinition,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): string {
  const parts = [quoteIdentifier(field.name), columnType(field)]
  if (field.required) parts.push('NOT NULL')
  if (field.default !== undefined && field.type !== 'id') {
    parts.push(`DEFAULT ${renderDefault(field.default)}`)
  }
  return `ALTER TABLE ${quoteIdentifier(physicalTable(land, colony, def.name))} ADD COLUMN ${parts.join(' ')}`
}