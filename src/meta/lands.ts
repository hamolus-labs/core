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
import type { ColonyDefinitionInput, ColonyDto, LandDefinitionInput, LandDto } from '@hamolus/types'
import { COLONY_DEFAULT, COLONY_SUFFIX, FILE_KINDS, LAND_DEFAULT, LAND_SUFFIX, TABLE_SEP, colonyDefinitionSchema, landDefinitionSchema } from '@hamolus/types'
import type { Db } from '../db/client'
import { buildDropTableSql, isIdentifier, physicalTable, quoteIdentifier } from '../db/table'
import { badRequest, notFound, forbidden, conflict } from '../errors'
import { invalidatePrivileges, PROTECTED_COLLECTION } from '../auth/privileges'
import { deletePanelAssetsForColony, deletePanelAssetsForLand } from '../media/panel-assets'
import { deleteMediaForLand, deleteMediaForColony } from '../media/store'
import { deleteFilesForLand, deleteFilesForColony } from '../files/store'
import { deletePanelsForLand, deletePanelsForColony } from './panels'
import { settingsKey } from './settings'
import { deleteCollection, invalidateCollectionRegistry } from './store'

/**
 * The scope registry: which lands (and their colonies) the core is allowed to
 * serve. `_meta_lands` / `_meta_colonies` are GLOBAL tables (they are not
 * scope-scoped themselves) — every colony references its land by `land_id`.
 *
 * The reserved root land (`root_lnd`) and its root colony (`root_cny`) always
 * exist; the standalone build (independent mode) lives entirely under them.
 */

interface LandRow {
  id: string
  label: string
  description: string | null
  owner_user_id: string | null
  created_at: string
  updated_at: string
}

interface ColonyRow {
  id: string
  land_id: string
  label: string
  description: string | null
  owner_user_id: string | null
  created_at: string
  updated_at: string
}

/** Cached snapshot of the registry, shared by the path rewrite and the resolver. */
export interface ScopeRegistry {
  /** Every registered land id. */
  lands: Set<string>
  /** land id → its colony ids. */
  colonies: Map<string, Set<string>>
  /** Reverse index: colony id → owning land id. */
  ownerOf: Map<string, string>
}

/**
 * Per-isolate bootstrap state.
 *
 * `tablesReady` is a plain completion latch and `registered` caches the resolved
 * registry VALUE — neither ever hands a promise to another request. Sharing an
 * in-flight promise across requests is unsafe on Workers: the awaiting request
 * resumes inside the creating request's async context, so its next D1 call
 * throws `Cannot perform I/O on behalf of a different request` (I/O type
 * `UserTraceAsyncContext`). A request that merely awaits an *already resolved*
 * foreign promise is poisoned too, so "warm the cache first" is not a workaround.
 */
let tablesReady = false
let registered: ScopeRegistry | null = null

function landRowToDto(row: LandRow): LandDto {
  return {
    id: row.id,
    label: row.label,
    description: row.description ?? null,
    ownerUserId: row.owner_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function colonyRowToDto(row: ColonyRow): ColonyDto {
  return {
    id: row.id,
    landId: row.land_id,
    label: row.label,
    description: row.description ?? null,
    ownerUserId: row.owner_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** True when a table exists in the database (migrations must tolerate gaps). */
async function tableExists(db: Db, table: string): Promise<boolean> {
  const rows = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  )
  return rows.length > 0
}

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const rows = await db.all<{ name: string }>(sql`PRAGMA table_info(${sql.raw(`'${table}'`)})`)
  return rows.some((r) => r.name === column)
}

/**
 * Bring the scope columns of every metadata table up to date on a database whose
 * tables were created before the land/colony split.
 *
 * The purge paths in `deleteColony` / `deleteLand` write
 * `WHERE land = ? AND colony = ?` against tables that may predate the split.
 * A `tableExists` guard is not enough: a table can exist and still be missing
 * the column, which turns a delete into a `no such column` 500 and leaves the
 * scope undeletable. This runs the same PRAGMA-diff `ALTER TABLE` the per-table
 * `ensure*Table` helpers do, for the whole `SCOPE_TABLES` set at once, so a purge
 * is always safe no matter which request first touched a table.
 */
async function ensureScopeColumns(db: Db): Promise<void> {
  for (const [table, landCol, colonyCol] of SCOPE_TABLES) {
    if (!(await tableExists(db, table))) continue
    if (!(await hasColumn(db, table, landCol))) {
      await db.run(
        sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN land TEXT NOT NULL DEFAULT 'root_lnd'`,
      )
    }
    if (!(await hasColumn(db, table, colonyCol))) {
      await db.run(
        sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN colony TEXT NOT NULL DEFAULT 'root_cny'`,
      )
    }
  }
}

/** Auto-bootstrap `_meta_lands` + `_meta_colonies` (idempotent per isolate). */
export async function ensureLandsTable(db: Db, kv?: KVNamespace): Promise<void> {
  if (tablesReady) return
  await db.run(sql`
      CREATE TABLE IF NOT EXISTS _meta_lands (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        owner_user_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `)
  await db.run(sql`
        CREATE TABLE IF NOT EXISTS _meta_colonies (
          id TEXT PRIMARY KEY,
          land_id TEXT NOT NULL,
          label TEXT NOT NULL,
          description TEXT,
          owner_user_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `)
  // Pre-land/colony databases have no `owner_user_id` column.
  for (const t of ['_meta_lands', '_meta_colonies']) {
    if (!(await hasColumn(db, t, 'owner_user_id'))) {
      await db.run(sql`ALTER TABLE ${sql.raw(t)} ADD COLUMN owner_user_id TEXT`)
    }
  }
  await migrateScopeIds(db, kv)
  await ensureColonyIdUnique(db)
  await ensureRootScopeRows(db)
  // Only latch on success, so a transient failure is retried by the next request.
  tablesReady = true
}

/** Invalidate the cached registry after any land/colony write. */
export function invalidateLandsRegistry(): void {
  registered = null
}

/**
 * Normalize a pre-scope registry id to the suffixed form. `default` / `root` (and
 * an empty value) collapse onto the reserved root ids; anything else just gains
 * the suffix, so a legacy land `acme` becomes `acme_lnd`.
 */
function normalizeLandId(raw: string): string {
  const base = raw.trim().toLowerCase()
  if (base === '' || base === 'default' || base === LAND_DEFAULT) return LAND_DEFAULT
  return base.endsWith(LAND_SUFFIX) ? base : `${base}${LAND_SUFFIX}`
}

function normalizeColonyId(raw: string): string {
  const base = raw.trim().toLowerCase()
  if (base === '' || base === 'default' || base === 'root' || base === COLONY_DEFAULT) {
    return COLONY_DEFAULT
  }
  return base.endsWith(COLONY_SUFFIX) ? base : `${base}${COLONY_SUFFIX}`
}

/** Every table that carries land/colony scope columns, paired with its columns. */
const SCOPE_TABLES: Array<[string, string, string]> = [
  ['_meta_collections', 'land', 'colony'],
  ['_meta_groups', 'land', 'colony'],
  ['_meta_panels', 'land', 'colony'],
  ['_meta_media', 'land', 'colony'],
  ['_meta_documents', 'land', 'colony'],
  ['_meta_attachments', 'land', 'colony'],
  ['_configs', 'land', 'colony'],
  ['_auth_users', 'land', 'colony'],
]

/**
 * Make every registered collection's physical table reachable under its canonical
 * `{land}__{colony}__{name}` name, wherever the table currently lives.
 *
 * A physical table is only ever renamed forward, so a stale name can come from two
 * eras: the land-only scheme (`{land}__{name}`, and bare `{name}` for the reserved
 * default land) and the current one. For each registered collection this tries the
 * canonical name first, then the legacy spellings, and renames the first hit. When
 * the canonical table already exists the legacy leftovers are dropped, so the pass
 * converges instead of accumulating copies.
 */
async function repairPhysicalTables(db: Db): Promise<void> {
  // This runs before `ensureMetaTable` on a first boot, when a brand new D1 has no
  // collection metadata at all. There is nothing to repair in that state, and querying
  // the missing table would fail the very first request a new project makes.
  if (!(await tableExists(db, '_meta_collections'))) return

  const registered = await db.all<{ land: string; colony: string; name: string }>(
    sql`SELECT land, colony, name FROM _meta_collections`,
  )
  for (const row of registered) {
    const land = row.land || LAND_DEFAULT
    const colony = row.colony || COLONY_DEFAULT
    const canonical = physicalTable(land, colony, row.name)
    const preSuffix = land.endsWith(LAND_SUFFIX) ? land.slice(0, -LAND_SUFFIX.length) : land
    const candidates = [
      canonical,
      `${land}${TABLE_SEP}${row.name}`,
      `${preSuffix}${TABLE_SEP}${row.name}`,
      row.name,
    ].filter((n, idx, all) => all.indexOf(n) === idx)
    if (await tableExists(db, canonical)) {
      for (const legacy of candidates.slice(1)) {
        if (legacy !== canonical && (await tableExists(db, legacy))) {
          await db.run(sql.raw(`DROP TABLE IF EXISTS ${quoteIdentifier(legacy)}`))
        }
      }
      continue
    }
    for (const legacy of candidates.slice(1)) {
      if (await tableExists(db, legacy)) {
        await db.run(
          sql.raw(`ALTER TABLE ${quoteIdentifier(legacy)} RENAME TO ${quoteIdentifier(canonical)}`),
        )
        break
      }
    }
  }
}

/**
 * One-time, idempotent migration of a land-only registry to the land/colony model.
 *
 * Legacy ids gain the reserved suffix (`acme` → `acme_lnd`, its colony
 * `website` → `website_cny`, the reserved `default` land → `root_lnd`), and the
 * scope columns of every metadata table are remapped to match.
 *
 * The physical record tables are handled by `repairPhysicalTables` here, NOT by
 * the rename in `meta/store`. That one derives the legacy name it looks for from
 * the *current* `land` column, so once the ids below are rewritten it can no
 * longer find `acme__services` and would leave it stranded — metadata saying
 * the collection is registered, reads failing with `no such table`.
 */
async function migrateScopeIds(db: Db, kv?: KVNamespace): Promise<void> {
  const landRows = await db.all<{ id: string }>(sql`SELECT id FROM _meta_lands`)
  const colonyRows = await db.all<{ id: string; land_id: string }>(
    sql`SELECT id, land_id FROM _meta_colonies`,
  )

  const landMap = new Map<string, string>()
  for (const row of landRows) {
    const next = normalizeLandId(row.id)
    if (next !== row.id) landMap.set(row.id, next)
  }
  const colonyMap = new Map<string, string>()
  for (const row of colonyRows) {
    const next = normalizeColonyId(row.id)
    if (next !== row.id) colonyMap.set(row.id, next)
  }
  // Physical record tables are repaired on every pass, not only when an id changed:
  // a database that already carries normalized registry rows but pre-split table
  // names (the `acme_lnd` land whose tables are still `acme__*`) is exactly the
  // state a half-applied upgrade leaves behind, and it is silent until a read 500s
  // with `no such table`. The repair is idempotent and keyed on the collection list.
  await repairPhysicalTables(db)

  if (landMap.size === 0 && colonyMap.size === 0) return

  // Registry tables next, so the scope columns below can resolve their new names.
  for (const [from, to] of landMap) {
    // Children first, otherwise the parent's new key collides with the legacy row.
    await db.run(sql`UPDATE _meta_colonies SET land_id = ${to} WHERE land_id = ${from}`)
    await db.run(sql`UPDATE _meta_lands SET id = ${to} WHERE id = ${from}`)
  }
  for (const [from, to] of colonyMap) {
    await db.run(sql`UPDATE _meta_colonies SET id = ${to} WHERE id = ${from}`)
  }

  for (const [table, landCol, colonyCol] of SCOPE_TABLES) {
    if (!(await tableExists(db, table))) continue
    if (!(await hasColumn(db, table, landCol))) continue
    for (const [from, to] of landMap) {
      await db.run(
        sql`UPDATE ${sql.raw(table)} SET ${sql.raw(landCol)} = ${to} WHERE ${sql.raw(landCol)} = ${from}`,
      )
    }
    if (!(await hasColumn(db, table, colonyCol))) continue
    for (const [from, to] of colonyMap) {
      await db.run(
        sql`UPDATE ${sql.raw(table)} SET ${sql.raw(colonyCol)} = ${to} WHERE ${sql.raw(colonyCol)} = ${from}`,
      )
    }
  }
  invalidateLandsRegistry()

  if (kv) {
    const known = new Map<string, Set<string>>()
    for (const row of colonyRows) {
      const set = known.get(row.land_id) ?? new Set<string>()
      set.add(row.id)
      known.set(row.land_id, set)
    }
    await migrateScopeKv(kv, landMap, colonyMap, known)
  }
}

/**
 * Move a renamed scope's KV documents onto the new key shape.
 *
 * The D1 half of the id migration is only half the job: the land id is embedded
 * in KV keys too (`settings:{land}:{colony}:v1`, `plugin:{land}:{colony}:{plugin}:…`).
 * Rewriting the registry without moving these leaves the land reading an EMPTY
 * settings blob and an empty plugin board, and it is silent — D1 looks healthy,
 * so the half-applied upgrade only surfaces as missing configuration. In the
 * console an empty `localization.languages` drops the language selector, and
 * because a localized field with no configured languages falls through to the
 * non-localized control, every such field then renders as `[object Object]`.
 *
 * Pre-colony keys had no colony segment at all (`settings:acme:v1`,
 * `plugin:acme:kanban:board`), so this reshapes rather than string-replaces.
 * An existing destination is never overwritten and the source is dropped only
 * after its copy landed, which makes the pass idempotent and non-destructive.
 */
async function migrateScopeKv(
  kv: KVNamespace,
  landMap: Map<string, string>,
  colonyMap: Map<string, string>,
  coloniesOf: Map<string, Set<string>>,
): Promise<void> {
  const move = async (from: string, to: string): Promise<void> => {
    if (from === to) return
    if ((await kv.get(to)) !== null) {
      await kv.delete(from)
      return
    }
    const value = await kv.get(from)
    if (value === null) return
    await kv.put(to, value)
    await kv.delete(from)
  }

  for (const [from, to] of landMap) {
    const siblings = coloniesOf.get(from) ?? new Set<string>()
    const knownColony = (id: string): boolean =>
      siblings.has(id) || [...siblings].some((c) => colonyMap.get(c) === id) || id === COLONY_DEFAULT

    let cursor: string | undefined
    do {
      const page = await kv.list({ prefix: `settings:${from}:`, cursor })
      for (const key of page.keys) {
        const suffix = key.name.slice(`settings:${from}:`.length)
        const legacy = suffix === 'v1'
        const colony = legacy ? COLONY_DEFAULT : suffix.replace(/:v1$/, '')
        const target = legacy ? COLONY_DEFAULT : (colonyMap.get(colony) ?? colony)
        await move(key.name, settingsKey(to, target))
      }
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)

    let pluginCursor: string | undefined
    do {
      const page = await kv.list({ prefix: `plugin:${from}:`, cursor: pluginCursor })
      for (const key of page.keys) {
        const rest = key.name.slice(`plugin:${from}:`.length).split(':')
        // `{plugin}:{key}` when written before the colony split, else
        // `{colony}:{plugin}:{key}`. A known colony id in first position decides it.
        const hasColony = rest.length >= 3 && knownColony(rest[0])
        const colony = hasColony ? rest[0] : COLONY_DEFAULT
        const tail = (hasColony ? rest.slice(1) : rest).join(':')
        const target = colonyMap.get(colony) ?? colony
        await move(key.name, `plugin:${to}:${target}:${tail}`)
      }
      pluginCursor = page.list_complete ? undefined : page.cursor
    } while (pluginCursor)
  }
}

/**
 * A colony id addresses exactly one scope across the whole deployment: the
 * resolver, the path rewrite and every physical-table name depend on that, so a
 * duplicate must be impossible at the storage layer too. The (land_id, id)
 * primary key alone would happily let two lands claim the same id and the
 * registry would silently resolve to whichever row it read last.
 *
 * Legacy data (pre-scope databases were keyed by id alone) can only contain
 * duplicates if a land was renamed into an existing colony, so reconcile by
 * keeping the oldest parent and dropping the rest — then lock it in with a
 * unique index. `putColony` rejects a cross-land claim with a clear error long
 * before the index would.
 *
 * The table's primary key is `id` alone, which *is* the global-uniqueness
 * guarantee and the constraint `putColony`'s `ON CONFLICT` targets. A database
 * created by an intermediate build carries a composite `(land_id, id)` key
 * instead, which that upsert cannot match, so the table is rebuilt into the
 * canonical shape first (clone → copy → drop → rename, the same pattern the
 * record-table migration uses).
 */
async function ensureColonyIdUnique(db: Db): Promise<void> {
  const cols = await db.all<{ name: string; pk: number }>(sql`PRAGMA table_info(_meta_colonies)`)
  const pkColumns = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
  if (pkColumns.length !== 1 || pkColumns[0] !== 'id') {
    await db.run(sql`DROP TABLE IF EXISTS _meta_colonies_rebuild`)
    await db.run(sql`
      CREATE TABLE _meta_colonies_rebuild (
        id TEXT PRIMARY KEY,
        land_id TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        owner_user_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `)
    const hasOwner = cols.some((c) => c.name === 'owner_user_id')
    await db.run(
      sql`INSERT OR REPLACE INTO _meta_colonies_rebuild (id, land_id, label, description, owner_user_id, created_at, updated_at)
          SELECT id, land_id, label, description, ${hasOwner ? sql.raw('owner_user_id') : sql.raw('NULL')}, created_at, updated_at
          FROM _meta_colonies`,
    )
    await db.run(sql`DROP TABLE _meta_colonies`)
    await db.run(sql`ALTER TABLE _meta_colonies_rebuild RENAME TO _meta_colonies`)
  }
  const dupes = await db.all<{ id: string }>(
    sql`SELECT id FROM _meta_colonies GROUP BY id HAVING COUNT(*) > 1`,
  )
  if (dupes.length > 0) {
    await db.run(sql`
      DELETE FROM _meta_colonies
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM _meta_colonies GROUP BY id
      )
    `)
  }
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_colonies_id ON _meta_colonies (id)`,
  )
}

/** Ensure the reserved root land and root colony rows exist. */
async function ensureRootScopeRows(db: Db): Promise<void> {
  const lands = await db.all<{ id: string }>(sql`SELECT id FROM _meta_lands WHERE id = ${LAND_DEFAULT}`)
  if (lands.length === 0) {
    await db.run(sql`INSERT INTO _meta_lands (id, label) VALUES (${LAND_DEFAULT}, ${'Root land'})`)
  }
  const colonies = await db.all<{ id: string }>(
    sql`SELECT id FROM _meta_colonies WHERE land_id = ${LAND_DEFAULT} AND id = ${COLONY_DEFAULT}`,
  )
  if (colonies.length === 0) {
    await db.run(
      sql`INSERT INTO _meta_colonies (id, land_id, label) VALUES (${COLONY_DEFAULT}, ${LAND_DEFAULT}, ${'Root colony'})`,
    )
  }
  invalidateLandsRegistry()
}

/** Ensure the root land row exists (used by the scope rewrite + setup). */
export async function ensureRootLandRow(db: Db): Promise<void> {
  await ensureLandsTable(db)
  await ensureRootScopeRows(db)
}

/**
 * Cached snapshot of registered land ids, per-land colony id sets, and the
 * colony → land reverse index. Used by the scope path-rewrite and resolver.
 */
export async function ensureLandsRegistry(db: Db, kv?: KVNamespace): Promise<ScopeRegistry> {
  if (registered) return registered
  await ensureLandsTable(db, kv)
  await ensureRootScopeRows(db)
  const landRows = await db.all<{ id: string }>(sql`SELECT id FROM _meta_lands`)
  const lands = new Set(landRows.map((r) => r.id))
  const colonyRows = await db.all<{ land_id: string; id: string }>(
    sql`SELECT land_id, id FROM _meta_colonies`,
  )
  const colonies = new Map<string, Set<string>>()
  const ownerOf = new Map<string, string>()
  for (const row of colonyRows) {
    const set = colonies.get(row.land_id) ?? new Set<string>()
    set.add(row.id)
    colonies.set(row.land_id, set)
    ownerOf.set(row.id, row.land_id)
  }
  // Cache the value, never the promise: concurrent callers each run the query in
  // their own request context and simply overwrite this slot.
  registered = { lands, colonies, ownerOf }
  return registered
}

export async function listLands(db: Db): Promise<LandDto[]> {
  await ensureLandsTable(db)
  const rows = await db.all<LandRow>(sql`SELECT * FROM _meta_lands ORDER BY created_at`)
  return rows.map(landRowToDto)
}

export async function getLand(db: Db, id: string): Promise<LandDto> {
  await ensureLandsTable(db)
  const rows = await db.all<LandRow>(sql`SELECT * FROM _meta_lands WHERE id = ${id} LIMIT 1`)
  const row = rows[0]
  if (!row) throw notFound(`Land '${id}' is not registered`)
  return landRowToDto(row)
}

/** Upsert a land definition (creates it if the id is new). */
export async function putLand(
  db: Db,
  input: LandDefinitionInput,
  ownerUserId?: string | null,
): Promise<LandDto> {
  await ensureLandsTable(db)
  const now = new Date().toISOString()
  await db.run(
    sql`INSERT INTO _meta_lands (id, label, description, owner_user_id, created_at, updated_at)
        VALUES (${input.id}, ${input.label}, ${input.description ?? null}, ${ownerUserId ?? null}, ${now}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          label = ${input.label},
          description = ${input.description ?? null},
          owner_user_id = COALESCE(${ownerUserId ?? null}, owner_user_id),
          updated_at = ${now}`,
  )
  invalidateLandsRegistry()
  return getLand(db, input.id)
}


/** Drop the whole KV footprint of a land: its settings blob + plugin documents. */
async function purgeLandKv(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(settingsKey(id))
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: `plugin:${id}:`, cursor })
    for (const key of page.keys) await kv.delete(key.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
}

/**
 * Delete a land and every piece of state it owns: colonies are blocked, and
 * panels, panel assets, the media / document / attachment libraries (rows **and**
 * R2 bytes), collection metadata + physical record tables, the privileges
 * bootstrap table, groups, config rows, auth users and the land's KV documents.
 *
 * Purging the physical tables is what makes the deletion final — land ids are
 * part of the table name, so a stale table would silently resurrect its records
 * if the same land id were ever registered again.
 */
export async function deleteLand(
  db: Db,
  id: string,
  bucket?: R2Bucket,
  settings?: KVNamespace,
): Promise<void> {
  await ensureLandsTable(db)
  await ensureScopeColumns(db)
  if (id === LAND_DEFAULT) {
    throw forbidden("The default land cannot be deleted", 'DEFAULT_LAND_RESERVED')
  }
  if (!isIdentifier(id)) throw badRequest(`Invalid land id: ${id}`, 'INVALID_LAND')
  const res = await db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM _meta_colonies WHERE land_id = ${id}`,
  )
  if (res[0]?.n > 0) {
    throw badRequest(`Land '${id}' still has colonies; remove them first`, 'LAND_IN_USE')
  }

  // Panels and their private assets.
  await deletePanelsForLand(db, id)
  const assets = await deletePanelAssetsForLand(db, id)
  const objectKeys: string[] = assets.map((asset) => asset.key)

  // Media / document / attachment libraries: collect the R2 keys first, then
  // drop the metadata rows.
  if (await tableExists(db, '_meta_media')) {
    objectKeys.push(...(await deleteMediaForLand(db, id)))
  }
  for (const kind of FILE_KINDS) {
    if (await tableExists(db, kind === 'document' ? '_meta_documents' : '_meta_attachments')) {
      objectKeys.push(...(await deleteFilesForLand(db, kind, id)))
    }
  }

  // Collection metadata + every physical table the land owns.
  if (await tableExists(db, '_meta_collections')) {
    const names = await db.all<{ name: string }>(
      sql`SELECT name FROM _meta_collections WHERE land = ${id}`,
    )
    for (const row of names) await deleteCollection(db, row.name, id)
  }
  // The privileges table is bootstrapped on demand — drop it even when the land
  // never registered the collection, and forget the cached bootstrap so a
  // re-created land gets its roles back.
  await db.run(sql.raw(buildDropTableSql(PROTECTED_COLLECTION, id)))
  invalidatePrivileges(id)
  invalidateCollectionRegistry()

  if (await tableExists(db, '_meta_groups')) {
    await db.run(sql`DELETE FROM _meta_groups WHERE land = ${id}`)
  }
  if (await tableExists(db, '_configs')) {
    await db.run(sql`DELETE FROM _configs WHERE land = ${id}`)
  }
  // Auth users live in the global `_auth_users` table (land column) — cascade
  // them so deleting a land never leaves orphan accounts behind.
  if (await tableExists(db, '_auth_users')) {
    await db.run(sql`DELETE FROM _auth_users WHERE land = ${id}`)
  }

  await db.run(sql`DELETE FROM _meta_lands WHERE id = ${id}`)
  invalidateLandsRegistry()

  // Bytes last: the metadata is already gone, so an R2 hiccup can never leave
  // rows pointing at objects that no longer exist.
  if (bucket) {
    for (const key of new Set(objectKeys)) await bucket.delete(key)
  }
  if (settings) await purgeLandKv(settings, id)
}

export async function listColonies(db: Db, landId?: string): Promise<ColonyDto[]> {
  await ensureLandsTable(db)
  const rows = landId
    ? await db.all<ColonyRow>(
        sql`SELECT * FROM _meta_colonies WHERE land_id = ${landId} ORDER BY created_at`,
      )
    : await db.all<ColonyRow>(sql`SELECT * FROM _meta_colonies ORDER BY created_at`)
  return rows.map(colonyRowToDto)
}

export async function getColony(db: Db, id: string, landId?: string): Promise<ColonyDto> {
  await ensureLandsTable(db)
  const rows = landId
    ? await db.all<ColonyRow>(
        sql`SELECT * FROM _meta_colonies WHERE id = ${id} AND land_id = ${landId} LIMIT 1`,
      )
    : await db.all<ColonyRow>(sql`SELECT * FROM _meta_colonies WHERE id = ${id} LIMIT 1`)
  const row = rows[0]
  if (!row) throw notFound(`Colony '${id}' is not registered`)
  return colonyRowToDto(row)
}

/** Upsert a colony under an existing land. */
export async function putColony(
  db: Db,
  landId: string,
  input: ColonyDefinitionInput,
  ownerUserId?: string | null,
): Promise<ColonyDto> {
  await ensureLandsTable(db)
  await getLand(db, landId)
  // Colony ids are globally unique, so re-using one under a different land would
  // make its scope ambiguous everywhere (physical tables, resolver, headers).
  const owner = await db.all<{ land_id: string }>(
    sql`SELECT land_id FROM _meta_colonies WHERE id = ${input.id} AND land_id != ${landId} LIMIT 1`,
  )
  if (owner[0]) {
    throw conflict(
      `Colony '${input.id}' already belongs to land '${owner[0].land_id}' — colony ids must be unique`,
      'COLONY_ID_TAKEN',
    )
  }
  const now = new Date().toISOString()
  await db.run(
    sql`INSERT INTO _meta_colonies (id, land_id, label, description, owner_user_id, created_at, updated_at)
        VALUES (${input.id}, ${landId}, ${input.label}, ${input.description ?? null}, ${ownerUserId ?? null}, ${now}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          land_id = ${landId},
          label = ${input.label},
          description = ${input.description ?? null},
          owner_user_id = COALESCE(${ownerUserId ?? null}, owner_user_id),
          updated_at = ${now}`,
  )
  invalidateLandsRegistry()
  return getColony(db, input.id, landId)
}

/** Drop the whole KV footprint of a colony: its settings blob + plugin documents. */
async function purgeColonyKv(kv: KVNamespace, land: string, colony: string): Promise<void> {
  await kv.delete(settingsKey(land, colony))
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: `plugin:${land}:${colony}:`, cursor })
    for (const key of page.keys) await kv.delete(key.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
}

/**
 * Delete a colony and every piece of state it owns — the same cascade as
 * `deleteLand`, but pinned to a single `{land, colony}` pair. Panels and panel
 * assets, the media / document / attachment libraries (rows **and** R2 bytes),
 * collection metadata + physical record tables, the privileges bootstrap table,
 * groups, config rows, the colony's auth users, and its KV documents.
 *
 * Purging the physical tables is what makes the deletion final — the colony id
 * is part of the table name, so a stale table would silently resurrect records if
 * the same colony id were ever registered again.
 */
export async function deleteColony(
  db: Db,
  id: string,
  landId?: string,
  bucket?: R2Bucket,
  settings?: KVNamespace,
): Promise<void> {
  await ensureLandsTable(db)
  await ensureScopeColumns(db)
  const colony = await getColony(db, id, landId)
  const land = colony.landId
  if (colony.id === COLONY_DEFAULT && land === LAND_DEFAULT) {
    throw forbidden('The root colony cannot be deleted', 'DEFAULT_COLONY_RESERVED')
  }
  if (!isIdentifier(colony.id)) throw badRequest(`Invalid colony id: ${id}`, 'INVALID_COLONY')

  await deletePanelsForColony(db, land, colony.id)
  const assets = await deletePanelAssetsForColony(db, land, colony.id)
  const objectKeys: string[] = assets.map((asset) => asset.key)

  if (await tableExists(db, '_meta_media')) {
    objectKeys.push(...(await deleteMediaForColony(db, land, colony.id)))
  }
  for (const kind of FILE_KINDS) {
    if (await tableExists(db, kind === 'document' ? '_meta_documents' : '_meta_attachments')) {
      objectKeys.push(...(await deleteFilesForColony(db, kind, land, colony.id)))
    }
  }

  if (await tableExists(db, '_meta_collections')) {
    const names = await db.all<{ name: string }>(
      sql`SELECT name FROM _meta_collections WHERE land = ${land} AND colony = ${colony.id}`,
    )
    for (const row of names) await deleteCollection(db, row.name, land, colony.id)
  }
  await db.run(sql.raw(buildDropTableSql(PROTECTED_COLLECTION, land, colony.id)))
  invalidatePrivileges(land, colony.id)
  invalidateCollectionRegistry()

  if (await tableExists(db, '_meta_groups')) {
    await db.run(
      sql`DELETE FROM _meta_groups WHERE land = ${land} AND colony = ${colony.id}`,
    )
  }
  if (await tableExists(db, '_configs')) {
    await db.run(sql`DELETE FROM _configs WHERE land = ${land} AND colony = ${colony.id}`)
  }
  // Auth users live in the global `_auth_users` table (land/colony columns).
  if (await tableExists(db, '_auth_users')) {
    await db.run(sql`DELETE FROM _auth_users WHERE land = ${land} AND colony = ${colony.id}`)
  }

  await db.run(sql`DELETE FROM _meta_colonies WHERE land_id = ${land} AND id = ${colony.id}`)
  invalidateLandsRegistry()

  // Bytes last: the metadata is already gone, so an R2 hiccup can never leave
  // rows pointing at objects that no longer exist.
  if (bucket) {
    for (const key of new Set(objectKeys)) await bucket.delete(key)
  }
  if (settings) await purgeColonyKv(settings, land, colony.id)
}

// Re-export validation schemas so the routes can parse bodies consistently.
export { colonyDefinitionSchema, landDefinitionSchema }