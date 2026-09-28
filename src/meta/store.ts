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
import type { CollectionDefinition } from '@hamolus/types'
import { COLONY_DEFAULT, LAND_DEFAULT, collectionDefinitionSchema, toMcpCollectionMode } from '@hamolus/types'
import type { Db } from '../db/client'
import { metaCollections, type MetaCollectionRow } from '../db/schema'
import { addColumnSql, auditColumns, buildCreateTableSql, buildDropTableSql, isIdentifier, physicalTable, quoteIdentifier, stampPhysicalTable } from '../db/table'
import { badRequest, notFound } from '../errors'

/**
 * Per-isolate bootstrap state: a completion latch plus a cached VALUE. Neither
 * ever shares a promise with another request — awaiting a promise created inside
 * a different request's handler resumes in that request's async context and the
 * next D1 call throws `Cannot perform I/O on behalf of a different request`
 * (I/O type `UserTraceAsyncContext`). See the same note in `meta/lands.ts`.
 */
let metaReady = false
let allCollectionNames: Set<string> | null = null

/** Cache key for a scope: land and colony joined by a char that cannot appear in an id. */
function scopeKey(land: string, colony: string): string {
  return `${land}\u0000${colony}`
}

/**
 * Cached names of every registered collection across every scope. Used by the
 * scope path-rewrite to avoid hijacking a collection URL whose name happens to
 * collide with a registered land/colony id (bare interpretation wins). The
 * rewrite guard is intentionally conservative — it considers all scopes.
 */
export async function ensureAllCollectionNames(db: Db): Promise<Set<string>> {
  if (allCollectionNames) return allCollectionNames
  await ensureMetaTable(db)
  const rows = await db.all<{ name: string }>(sql`SELECT DISTINCT name FROM _meta_collections`)
  allCollectionNames = new Set(rows.map((r) => r.name))
  return allCollectionNames
}

export function invalidateAllCollectionNames(): void {
  allCollectionNames = null
}

/** Number of columns backing the table's PRIMARY KEY (0 when none). */
async function pkColumnCount(db: Db, table: string): Promise<number> {
  const indexes = await db.all<{ name: string; origin: string }>(
    sql`PRAGMA index_list(${sql.raw(`'${table}'`)})`,
  )
  const pkIdx = indexes.find((i) => i.origin === 'pk')
  if (!pkIdx) return 0
  const info = await db.all<{ seqno: number }>(
    sql`PRAGMA index_info(${sql.raw(`'${pkIdx.name}'`)})`,
  )
  return info.length
}

/** The scope-aware metadata table is keyed by (land, colony, name) — 3 columns. */
export async function pkIsScopeScoped(db: Db, table: string): Promise<boolean> {
  return (await pkColumnCount(db, table)) === 3
}

async function tableExists(db: Db, table: string): Promise<boolean> {
  const rows = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  )
  return rows.length > 0
}

/**
 * One-time rename of every record table to the fully nested per-scope name.
 *
 * Before scopes, tables were named `{name}` for the default land and
 * `{land}__{name}` for every other one. Those become
 * `root_lnd__root_cny__{name}` and `{land}__root_cny__{name}`, which is exactly
 * where the registry rows point once `land`/`colony` are normalized. When both
 * the old and the new name exist the new one wins and the old table is dropped.
 *
 * NOTE: this pass reads the legacy name off the *current* `land` column, so it can
 * only ever find a table that already carries the normalized land. The pre-suffix
 * case (`acme__services` under a `acme_lnd` row) is handled by
 * `repairPhysicalTables` in `meta/lands`, which runs while the old ids are known.
 */
async function migrateLegacyRecordTables(db: Db): Promise<void> {
  const rows = await db.all<{ land: string; name: string }>(
    sql`SELECT land, name FROM _meta_collections`,
  )
  for (const row of rows) {
    const land = row.land === 'default' ? LAND_DEFAULT : row.land
    const legacy =
      row.land === 'default' || row.land === '' ? row.name : `${row.land}__${row.name}`
    const next = physicalTable(land, COLONY_DEFAULT, row.name)
    if (legacy === next) continue
    if (await tableExists(db, next)) {
      if (await tableExists(db, legacy)) {
        await db.run(sql.raw(`DROP TABLE IF EXISTS ${quoteIdentifier(legacy)}`))
      }
      continue
    }
    if (await tableExists(db, legacy)) {
      await db.run(
        sql.raw(`ALTER TABLE ${quoteIdentifier(legacy)} RENAME TO ${quoteIdentifier(next)}`),
      )
    }
  }
}

/**
 * Auto-bootstrap of the _meta_collections metadata table, including a
 * scope-aware composite PRIMARY KEY (land, colony, name). Idempotent — runs
 * once per isolate. Legacy databases are migrated in place: the `colony` column
 * is backfilled, the old `default` land id is normalized to `root_lnd`, the
 * primary key is rebuilt, and record tables are renamed to their nested names.
 */
export async function ensureMetaTable(db: Db): Promise<void> {
  if (metaReady) return
  const boot = db
      .run(sql.raw(`
        CREATE TABLE IF NOT EXISTS _meta_collections (
          land TEXT NOT NULL DEFAULT '${LAND_DEFAULT}',
          colony TEXT NOT NULL DEFAULT '${COLONY_DEFAULT}',
          name TEXT NOT NULL,
          label TEXT NOT NULL,
          description TEXT,
          "group" TEXT,
          icon TEXT,
          timestamps INTEGER NOT NULL DEFAULT 0,
          soft_delete INTEGER NOT NULL DEFAULT 0,
          primary_key TEXT NOT NULL DEFAULT 'id',
          mcp TEXT,
          fields TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (land, colony, name)
        )
      `))
      .then(async () => {
        // Backfill new columns on databases created before they existed.
        const cols = await db.all<{ name: string }>(
          sql`PRAGMA table_info(${sql.raw('_meta_collections')})`,
        )
        const colNames = new Set(cols.map((c) => c.name))
        // DDL DEFAULT clauses cannot take bound parameters (SQLite has no place
        // to bind them into a schema statement), so the default is inlined as a
        // literal — both values are whitelisted compile-time constants.
        if (!colNames.has('colony')) {
          await db.run(
            sql.raw(
              `ALTER TABLE _meta_collections ADD COLUMN colony TEXT NOT NULL DEFAULT '${COLONY_DEFAULT}'`,
            ),
          )
        }
        if (!colNames.has('land')) {
          await db.run(
            sql.raw(`ALTER TABLE _meta_collections ADD COLUMN land TEXT NOT NULL DEFAULT '${LAND_DEFAULT}'`),
          )
        }
        if (!colNames.has('group')) {
          await db.run(sql`ALTER TABLE _meta_collections ADD COLUMN "group" TEXT`)
        }
        if (!colNames.has('icon')) {
          await db.run(sql`ALTER TABLE _meta_collections ADD COLUMN icon TEXT`)
        }
        if (!colNames.has('mcp')) {
          await db.run(sql`ALTER TABLE _meta_collections ADD COLUMN mcp TEXT`)
        }

        // Normalize the pre-scope `default` land id to the reserved root land.
        await db.run(
          sql`UPDATE _meta_collections SET land = ${LAND_DEFAULT} WHERE land = 'default'`,
        )

        // Reconcile legacy tables that were ever created without a PRIMARY KEY:
        // drop duplicate rows (keep the newest per scope + name) so the composite
        // PK rebuild below cannot violate uniqueness.
        const dupes = await db.all<{ name: string }>(
          sql`SELECT name FROM _meta_collections GROUP BY land, colony, name HAVING COUNT(*) > 1`,
        )
        if (dupes.length > 0) {
          await db.run(sql`
            DELETE FROM _meta_collections
            WHERE rowid NOT IN (
              SELECT MAX(rowid) FROM _meta_collections GROUP BY land, colony, name
            )
          `)
        }

        // Wrong-shaped PK (single name, or the pre-scope (land, name)) → rebuild
        // as the (land, colony, name) composite.
        if (!(await pkIsScopeScoped(db, '_meta_collections'))) {
          await db.run(sql`DROP INDEX IF EXISTS idx_meta_collections_name`)
          await db.run(sql`ALTER TABLE _meta_collections RENAME TO _meta_collections_legacy`)
          await db.run(sql.raw(`
            CREATE TABLE _meta_collections (
              land TEXT NOT NULL DEFAULT '${LAND_DEFAULT}',
              colony TEXT NOT NULL DEFAULT '${COLONY_DEFAULT}',
              name TEXT NOT NULL,
              label TEXT NOT NULL,
              description TEXT,
              "group" TEXT,
              icon TEXT,
              timestamps INTEGER NOT NULL DEFAULT 0,
              soft_delete INTEGER NOT NULL DEFAULT 0,
              primary_key TEXT NOT NULL DEFAULT 'id',
              mcp TEXT,
              fields TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (land, colony, name)
            )
          `))
          await db.run(sql.raw(`
            INSERT INTO _meta_collections (land, colony, name, label, description, "group", icon, timestamps, soft_delete, primary_key, mcp, fields, created_at, updated_at)
            SELECT land, colony, name, label, description, "group", icon, timestamps, soft_delete, primary_key, mcp, fields, created_at, updated_at
            FROM _meta_collections_legacy
          `))
          await db.run(sql`DROP TABLE IF EXISTS _meta_collections_legacy`)
        }

        await migrateLegacyRecordTables(db)
      })
  await boot
  // Latch only on success so a transient failure is retried by the next request.
  metaReady = true
}

class MetaRegistry {
  private loadedScopes = new Set<string>()
  private cache = new Map<string, CollectionDefinition>()
  private order = new Map<string, string[]>()

  invalidate(): void {
    this.loadedScopes.clear()
    this.cache.clear()
    this.order.clear()
    invalidateAllCollectionNames()
  }

  async getAll(db: Db, land: string = LAND_DEFAULT, colony: string = COLONY_DEFAULT): Promise<CollectionDefinition[]> {
    await ensureMetaTable(db)
    const key = scopeKey(land, colony)
    if (!this.loadedScopes.has(key)) {
      const rows = await db
        .select()
        .from(metaCollections)
        .where(and(eq(metaCollections.land, land), eq(metaCollections.colony, colony)))
        .orderBy(metaCollections.createdAt)
      const defs: CollectionDefinition[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        if (seen.has(row.name)) continue
        seen.add(row.name)
        try {
          defs.push(rowToDefinition(row, land, colony))
        } catch (err) {
          console.error('Skipping corrupt meta collection:', row.name, err)
        }
      }
      const order = this.order.get(key) ?? []
      for (const d of defs) {
        this.cache.set(`${key}\u0000${d.name}`, d)
        order.push(d.name)
      }
      this.order.set(key, order)
      this.loadedScopes.add(key)
    }
    const order = this.order.get(key) ?? []
    return order.map((n) => this.cache.get(`${key}\u0000${n}`)!).filter(Boolean)
  }

  async get(db: Db, name: string, land: string = LAND_DEFAULT, colony: string = COLONY_DEFAULT): Promise<CollectionDefinition> {
    await this.getAll(db, land, colony)
    const def = this.cache.get(`${scopeKey(land, colony)}\u0000${name}`)
    if (!def) throw notFound(`Collection '${name}' is not registered`)
    return def
  }
}

function rowToDefinition(row: MetaCollectionRow, land: string, colony: string): CollectionDefinition {
  const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields
  return stampPhysicalTable(
    {
      name: row.name,
      label: row.label,
      description: row.description ?? undefined,
      group: row.group ?? undefined,
      icon: row.icon ?? undefined,
      timestamps: row.timestamps ?? false,
      softDelete: row.softDelete ?? false,
      primaryKey: row.primaryKey ?? 'id',
      mcp: row.mcp == null ? undefined : toMcpCollectionMode(row.mcp),
      fields,
    },
    land,
    colony,
  )
}

export const registry = new MetaRegistry()

/** Upsert collection metadata and guarantee the physical table exists (idempotent). */
export async function putCollection(
  db: Db,
  input: Record<string, unknown>,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<CollectionDefinition> {
  await ensureMetaTable(db)

  const parsed = collectionDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    throw badRequest('Invalid collection definition: ' + parsed.error.issues.map((i) => i.message).join('; '), 'INVALID_COLLECTION')
  }
  const def = parsed.data
  if (!isIdentifier(def.name)) throw badRequest('Collection name must be snake_case', 'INVALID_COLLECTION')

  const table = physicalTable(land, colony, def.name)

  // Ensure the physical table exists/stays in sync for new columns (idempotent).
  await db.run(sql.raw(buildCreateTableSql(def, land, colony)))

  // Migrate newly added fields onto an existing table (ALTER TABLE ADD COLUMN).
  const existing = await db.all<{ name: string }>(
    sql`PRAGMA table_info(${sql.raw(quoteIdentifier(table))})`,
  )
  const existingNames = new Set(existing.map((c) => c.name))
  for (const field of def.fields) {
    if (field.type === 'id' && field.name === (def.primaryKey ?? 'id')) continue
    if (existingNames.has(field.name)) continue
    await db.run(sql.raw(addColumnSql(def, field, land, colony)))
  }
  // Backfill audit-trace columns (created_by/updated_by/deleted_by) onto tables
  // created before they existed — same PRAGMA-diff pattern as the field loop.
  for (const col of auditColumns(def)) {
    if (existingNames.has(col)) continue
    await db.run(sql`ALTER TABLE ${sql.raw(quoteIdentifier(table))} ADD COLUMN ${sql.raw(quoteIdentifier(col))} TEXT`)
  }

  const now = new Date().toISOString()
  await db
    .insert(metaCollections)
    .values({
      land,
      colony,
      name: def.name,
      label: def.label,
      description: def.description ?? null,
      group: def.group ?? null,
      icon: def.icon ?? null,
      timestamps: def.timestamps ?? false,
      softDelete: def.softDelete ?? false,
      primaryKey: def.primaryKey ?? 'id',
      mcp: def.mcp ?? null,
      fields: JSON.stringify(def.fields),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [metaCollections.land, metaCollections.colony, metaCollections.name],
      set: {
        label: def.label,
        description: def.description ?? null,
        group: def.group ?? null,
        icon: def.icon ?? null,
        timestamps: def.timestamps ?? false,
        softDelete: def.softDelete ?? false,
        primaryKey: def.primaryKey ?? 'id',
        mcp: def.mcp ?? null,
        fields: JSON.stringify(def.fields),
        updatedAt: now,
      },
    })

  registry.invalidate()
  return stampPhysicalTable(def, land, colony)
}

/** Remove metadata and drop the physical table. */
export async function deleteCollection(
  db: Db,
  name: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<void> {
  await ensureMetaTable(db)
  if (!isIdentifier(name)) throw badRequest('Invalid collection name')
  await db.run(sql.raw(buildDropTableSql(name, land, colony)))
  await db
    .delete(metaCollections)
    .where(
      and(
        eq(metaCollections.land, land),
        eq(metaCollections.colony, colony),
        eq(metaCollections.name, name),
      ),
    )
  registry.invalidate()
}

/**
 * Drop the cached collection definitions for every scope. Rarely needed — the
 * registry self-heals per collection on write — but deleting a land or colony
 * removes many definitions at once, so its entries must not survive.
 */
export function invalidateCollectionRegistry(): void {
  registry.invalidate()
}

export async function getCollection(
  db: Db,
  name: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<CollectionDefinition> {
  return registry.get(db, name, land, colony)
}

export async function listCollections(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<CollectionDefinition[]> {
  return registry.getAll(db, land, colony)
}