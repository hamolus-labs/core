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
import type {
  CollectionDefinition,
  FieldDefinition,
  PanelDefinition,
  PanelRoleDefinition,
  PanelViewDefinition,
} from '@hamolus/types'
import { COLONY_DEFAULT, LAND_DEFAULT, panelDefinitionSchema } from '@hamolus/types'
import type { Db } from '../db/client'
import { metaPanels, type MetaPanelRow } from '../db/schema'
import { pkField } from '../db/table'
import { badRequest, notFound } from '../errors'
import { getCollection } from './store'

let panelsReady = false
/**
 * Cache of RESOLVED panel maps per scope. Holds values, never promises: a
 * promise created inside one request and awaited by another resumes in the
 * first request's async context, and the next D1 call throws
 * `Cannot perform I/O on behalf of a different request`. Concurrent misses
 * simply both load and the last writer wins; the read is cheap and idempotent.
 */
const panelCache = new Map<string, Map<string, PanelDefinition>>()

/** The primary-key columns of `table`, in key order. */
async function primaryKeyColumns(db: Db, table: string): Promise<string[]> {
  const cols = await db.all<{ name: string; pk: number }>(sql.raw(`PRAGMA table_info('${table}')`))
  return cols
    .filter((col) => col.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((col) => col.name)
}

const PANEL_PRIMARY_KEY = ['land', 'colony', 'id'] as const

/**
 * `putPanel`'s upsert targets `ON CONFLICT (land, colony, id)`, which SQLite can
 * only satisfy when that exact composite key exists. A database created by an
 * earlier build carries `PRIMARY KEY (id)` (pre-scope) or `PRIMARY KEY (land, id)`
 * (before the colony column landed), so every write failed with a bare
 * "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"
 * surfaced as a 500 INTERNAL. Rebuild those into the canonical shape
 * (clone → copy → drop → rename, the same pattern `_meta_colonies` uses).
 *
 * Checking the key is *exactly* the composite and not merely "more than one
 * column" is the load-bearing part: the intermediate `(land, id)` key is already
 * two columns wide, so a length-only test declared the stale table canonical and
 * the rebuild never ran.
 *
 * A legacy row written before lands existed carries the reserved `default` land
 * (the old column default), which no longer resolves to a real land and would
 * leave the panel unreachable through every scope. Fold it into `LAND_DEFAULT`
 * while copying, for the same reason `repairPhysicalTables` renames a stranded
 * record table: a row nothing can query is as good as a row that does not exist.
 */
async function ensurePanelScopePrimaryKey(db: Db): Promise<void> {
  if ((await primaryKeyColumns(db, '_meta_panels')).join(',') === PANEL_PRIMARY_KEY.join(',')) return
  await db.run(sql`DROP TABLE IF EXISTS _meta_panels_rebuild`)
  await db.run(sql`
    CREATE TABLE _meta_panels_rebuild (
      land TEXT NOT NULL DEFAULT ${sql.raw(`'${LAND_DEFAULT}'`)},
      colony TEXT NOT NULL DEFAULT ${sql.raw(`'${COLONY_DEFAULT}'`)},
      id TEXT NOT NULL,
      definition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (land, colony, id)
    )
  `)
  const cols = await db.all<{ name: string }>(sql.raw(`PRAGMA table_info('_meta_panels')`))
  const hasColony = cols.some((col) => col.name === 'colony')
  const sourceColony = hasColony ? sql.raw('colony') : sql.raw(`'${COLONY_DEFAULT}'`)
  // The canonical key is strictly wider than any legacy key, so no two source
  // rows can collide here; OR REPLACE only guards a hand-edited duplicate.
  await db.run(sql`
    INSERT OR REPLACE INTO _meta_panels_rebuild (land, colony, id, definition, created_at, updated_at)
    SELECT CASE WHEN land = 'default' THEN ${LAND_DEFAULT} ELSE land END,
           COALESCE(NULLIF(${sourceColony}, ''), ${COLONY_DEFAULT}),
           id,
           definition,
           COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    FROM _meta_panels
  `)
  await db.run(sql`DROP TABLE _meta_panels`)
  await db.run(sql`ALTER TABLE _meta_panels_rebuild RENAME TO _meta_panels`)
}

export async function ensurePanelsTable(db: Db): Promise<void> {
  if (panelsReady) return
  const boot = db
    .run(sql.raw(`
        CREATE TABLE IF NOT EXISTS _meta_panels (
          land TEXT NOT NULL DEFAULT 'root_lnd',
          colony TEXT NOT NULL DEFAULT 'root_cny',
          id TEXT NOT NULL,
          definition TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (land, colony, id)
        )
      `))
      .then(async () => {
        const columns = await db.all<{ name: string }>(sql`PRAGMA table_info('_meta_panels')`)
        if (!columns.some((column) => column.name === 'land')) {
          await db.run(sql`ALTER TABLE _meta_panels ADD COLUMN land TEXT NOT NULL DEFAULT 'root_lnd'`)
        }
        if (!columns.some((column) => column.name === 'colony')) {
          await db.run(
            sql`ALTER TABLE _meta_panels ADD COLUMN colony TEXT NOT NULL DEFAULT 'root_cny'`,
          )
        }
        if (!columns.some((column) => column.name === 'definition')) {
          await db.run(sql`ALTER TABLE _meta_panels ADD COLUMN definition TEXT`)
        }
        if (!columns.some((column) => column.name === 'created_at')) {
          await db.run(sql`ALTER TABLE _meta_panels ADD COLUMN created_at TEXT`)
        }
        if (!columns.some((column) => column.name === 'updated_at')) {
          await db.run(sql`ALTER TABLE _meta_panels ADD COLUMN updated_at TEXT`)
        }
        await db.run(sql`
          UPDATE _meta_panels
          SET definition = id
          WHERE definition IS NULL OR definition = ''
        `)
        const duplicates = await db.all<{ id: string }>(
          sql`SELECT id FROM _meta_panels GROUP BY land, colony, id HAVING COUNT(*) > 1`,
        )
        if (duplicates.length > 0) {
          await db.run(sql`
            DELETE FROM _meta_panels
            WHERE rowid NOT IN (
              SELECT MAX(rowid) FROM _meta_panels GROUP BY land, colony, id
            )
          `)
        }
        await ensurePanelScopePrimaryKey(db)
      })
  await boot
  panelsReady = true
}

function rowToPanel(row: MetaPanelRow): PanelDefinition {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.definition)
  } catch {
    throw badRequest(`Panel '${row.id}' has an invalid stored definition`, 'INVALID_PANEL')
  }
  const result = panelDefinitionSchema.safeParse(parsed)
  if (!result.success || result.data.id !== row.id) {
    throw badRequest(`Panel '${row.id}' has an invalid stored definition`, 'INVALID_PANEL')
  }
  return result.data
}

async function loadPanels(
  db: Db,
  land: string,
  colony: string,
): Promise<Map<string, PanelDefinition>> {
  await ensurePanelsTable(db)
  const rows = await db
    .select()
    .from(metaPanels)
    .where(and(eq(metaPanels.land, land), eq(metaPanels.colony, colony)))
    .orderBy(metaPanels.createdAt, metaPanels.id)
  const out = new Map<string, PanelDefinition>()
  for (const row of rows) {
    if (!out.has(row.id)) out.set(row.id, rowToPanel(row))
  }
  return out
}

async function cachedPanels(
  db: Db,
  land: string,
  colony: string,
): Promise<Map<string, PanelDefinition>> {
  const key = panelCacheKey(land, colony)
  const hit = panelCache.get(key)
  if (hit) return hit
  const loaded = await loadPanels(db, land, colony)
  panelCache.set(key, loaded)
  return loaded
}

/** Cache key for one scope. `\u0000` cannot appear in a validated land/colony id. */
function panelCacheKey(land: string, colony: string): string {
  return `${land || LAND_DEFAULT}\u0000${colony || COLONY_DEFAULT}`
}

export function invalidatePanelCache(land?: string, colony?: string): void {
  if (land && colony) panelCache.delete(panelCacheKey(land, colony))
  else if (land) {
    for (const key of [...panelCache.keys()]) {
      if (key.startsWith(`${land}\u0000`)) panelCache.delete(key)
    }
  } else panelCache.clear()
}

export async function listPanels(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<PanelDefinition[]> {
  return [...(await cachedPanels(db, land, colony)).values()]
}

export async function getPanel(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<PanelDefinition> {
  const panel = (await cachedPanels(db, land, colony)).get(id)
  if (!panel) throw notFound(`Panel '${id}' not found`, 'PANEL_NOT_FOUND')
  return panel
}

function findField(collection: CollectionDefinition, name: string): FieldDefinition | undefined {
  const declared = collection.fields.find((field) => field.name === name)
  if (declared) return declared
  // The primary key is always present on the table and on every record, but it does not
  // have to be declared in `fields` (the DDL adds it). A panel may reference it, so fall
  // back to the same synthetic field `db/table` uses instead of rejecting the manifest.
  const pk = pkField(collection)
  return pk.name === name ? pk : undefined
}

function assertFieldExists(collection: CollectionDefinition, fieldName: string, panelId: string, context: string): FieldDefinition {
  const field = findField(collection, fieldName)
  if (!field) {
    throw badRequest(`Panel '${panelId}' ${context} references unknown field '${collection.name}.${fieldName}'`, 'PANEL_REFERENCE_INVALID')
  }
  if (field.hidden) {
    throw badRequest(`Panel '${panelId}' ${context} cannot use hidden field '${collection.name}.${fieldName}'`, 'PANEL_REFERENCE_INVALID')
  }
  return field
}

function assertFieldsKnown(
  collection: CollectionDefinition,
  names: string[],
  panelId: string,
  context: string,
): void {
  for (const name of names) assertFieldExists(collection, name, panelId, context)
}

function assertViewFields(
  panel: PanelDefinition,
  view: Extract<PanelViewDefinition, { collection: string }>,
  role: PanelRoleDefinition,
  collection: CollectionDefinition,
): void {
  assertFieldsKnown(collection, view.fields.read, panel.id, `view '${view.id}'`)
  assertFieldsKnown(collection, view.fields.write, panel.id, `view '${view.id}'`)
  const access = role.views.find((entry) => entry.viewId === view.id)
  if (!access) return
  const readFields = access.readFields ?? view.fields.read
  const writeFields = access.writeFields ?? view.fields.write
  assertFieldsKnown(collection, readFields, panel.id, `role '${role.id}'`)
  assertFieldsKnown(collection, writeFields, panel.id, `role '${role.id}'`)
  const viewRead = new Set(view.fields.read)
  const viewWrite = new Set(view.fields.write)
  if (readFields.some((name) => !viewRead.has(name))) {
    throw badRequest(`Role '${role.id}' read fields exceed view '${view.id}'`, 'PANEL_REFERENCE_INVALID')
  }
  if (writeFields.some((name) => !viewWrite.has(name))) {
    throw badRequest(`Role '${role.id}' write fields exceed view '${view.id}'`, 'PANEL_REFERENCE_INVALID')
  }
  const allowed = new Set(view.operations)
  if (access.operations.some((operation) => !allowed.has(operation))) {
    throw badRequest(`Role '${role.id}' operations exceed view '${view.id}'`, 'PANEL_REFERENCE_INVALID')
  }
  if (view.operations.includes('create')) {
    const effectiveWrite = new Set(writeFields)
    for (const field of collection.fields) {
      if (field.type !== 'id' && field.required && field.default === undefined && !effectiveWrite.has(field.name)) {
        throw badRequest(`Role '${role.id}' cannot create '${collection.name}' without write access to required field '${field.name}'`, 'PANEL_REFERENCE_INVALID')
      }
    }
  }
  if (view.defaultSort && !readFields.includes(view.defaultSort.field)) {
    throw badRequest(`View '${view.id}' default sort is not readable by role '${role.id}'`, 'PANEL_REFERENCE_INVALID')
  }
  if (view.searchable) {
    const searchable = readFields.some((name) => {
      const field = findField(collection, name)
      return !!field && ['string', 'text', 'email', 'url', 'slug', 'richtext'].includes(field.type)
    })
    if (!searchable) {
      throw badRequest(`View '${view.id}' is searchable but has no readable searchable fields`, 'PANEL_REFERENCE_INVALID')
    }
  }
}

async function validatePanelReferences(
  db: Db,
  land: string,
  colony: string,
  panel: PanelDefinition,
): Promise<void> {
  const viewIds = new Set<string>()
  for (const view of panel.views) {
    if (viewIds.has(view.id)) {
      throw badRequest(`Panel '${panel.id}' has duplicate view id '${view.id}'`, 'PANEL_REFERENCE_INVALID')
    }
    viewIds.add(view.id)
    if (view.kind === 'dashboard') {
      const metricIds = new Set<string>()
      for (const metric of view.metrics) {
        if (metricIds.has(metric.id)) {
          throw badRequest(`Panel '${panel.id}' has duplicate metric id '${metric.id}'`, 'PANEL_REFERENCE_INVALID')
        }
        metricIds.add(metric.id)
        const collection = await getCollection(db, metric.collection, land, colony)
        if (metric.field) {
          const field = assertFieldExists(collection, metric.field, panel.id, `metric '${metric.id}'`)
          if (metric.operation !== 'count' && !['number', 'currency', 'custom_currency'].includes(field.type)) {
            throw badRequest(`Metric '${metric.id}' requires a numeric field`, 'PANEL_REFERENCE_INVALID')
          }
        }
        if (metric.groupBy) {
          assertFieldExists(collection, metric.groupBy, panel.id, `metric '${metric.id}'`)
        }
      }
      continue
    }
    const collection = await getCollection(db, view.collection, land, colony)
    for (const rule of view.filters) {
      assertFieldExists(collection, rule.field, panel.id, `view '${view.id}'`)
      if (rule.op === 'in') {
        if (rule.source || !Array.isArray(rule.value)) {
          throw badRequest(`Filter '${view.id}.${rule.field}' with 'in' requires a static array`, 'PANEL_REFERENCE_INVALID')
        }
      }
    }
    for (const role of panel.roles) {
      assertViewFields(panel, view, role, collection)
    }
  }
}

export async function putPanel(
  db: Db,
  input: unknown,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<PanelDefinition> {
  await ensurePanelsTable(db)
  const parsed = panelDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    throw badRequest('Invalid panel definition: ' + parsed.error.issues.map((issue) => issue.message).join('; '), 'INVALID_PANEL')
  }
  const panel = parsed.data
  await validatePanelReferences(db, land, colony, panel)
  const now = new Date().toISOString()
  await db
    .insert(metaPanels)
    .values({
      land,
      colony,
      id: panel.id,
      definition: JSON.stringify(panel),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [metaPanels.land, metaPanels.colony, metaPanels.id],
      set: {
        definition: JSON.stringify(panel),
        updatedAt: now,
      },
    })
  invalidatePanelCache(land, colony)
  return panel
}

export async function deletePanel(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<void> {
  await ensurePanelsTable(db)
  await getPanel(db, id, land, colony)
  await db
    .delete(metaPanels)
    .where(and(eq(metaPanels.land, land), eq(metaPanels.colony, colony), eq(metaPanels.id, id)))
  invalidatePanelCache(land, colony)
}

/** Drop every panel of one colony; returns the deleted panel ids. */
export async function deletePanelsForColony(
  db: Db,
  land: string,
  colony: string,
): Promise<string[]> {
  await ensurePanelsTable(db)
  const rows = await db.all<{ id: string }>(
    sql`SELECT id FROM _meta_panels WHERE land = ${land} AND colony = ${colony}`,
  )
  if (rows.length > 0) {
    await db.run(sql`DELETE FROM _meta_panels WHERE land = ${land} AND colony = ${colony}`)
  }
  invalidatePanelCache(land, colony)
  return rows.map((row) => row.id)
}

export async function deletePanelsForLand(db: Db, land: string): Promise<string[]> {
  await ensurePanelsTable(db)
  const rows = await db.all<{ id: string }>(sql`SELECT id FROM _meta_panels WHERE land = ${land}`)
  if (rows.length > 0) {
    await db.run(sql`DELETE FROM _meta_panels WHERE land = ${land}`)
  }
  invalidatePanelCache(land)
  return rows.map((row) => row.id)
}
