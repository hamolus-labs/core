/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types'
import type { CollectionDefinition } from '@hamolus/types'
import { COLONY_DEFAULT, LAND_DEFAULT, collectionDefinitionSchema, groupDefinitionSchema } from '@hamolus/types'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { isIdentifier, physicalTable, quoteIdentifier } from '../db/table'
import { badRequest } from '../errors'
import { PROTECTED_COLLECTION } from '../auth/privileges'
import { deleteCollection, listCollections, putCollection } from './store'
import { settingsKey as settingsKeyFor } from './settings'
import { deleteGroup, listGroups, putGroup } from './groups'
import { getSettings } from './settings'
import { deleteMedia, ensureMediaTable } from '../media/store'

export const SEED_KIND = 'hamolus-seed'
export const SEED_VERSION = 1

/** One raw physical row (rowid preserved so apply can reproduce exact ordering/slots). */
export interface SeedRow {
  _rowid: number
  [key: string]: unknown
}

export interface SeedGroup {
  id: string
  label: string
  parent?: string | null
  icon?: string | null
}

export interface SeedObjectBytes {
  b64: string
  mime: string
}

/** The JSON snapshot produced by export and consumed by apply. */
export interface SeedSnapshot {
  kind: typeof SEED_KIND
  version: typeof SEED_VERSION
  exportedAt: string
  origin: string
  land: string
  colony: string
  scope: string
  settings: Record<string, unknown> | null
  groups: SeedGroup[]
  collections: CollectionDefinition[]
  records: Record<string, SeedRow[]>
  media: Array<Record<string, unknown>> | null
  mediaObjects: Record<string, SeedObjectBytes> | null
  /**
   * Not part of a snapshot yet. Panel manifests (`_meta_panels`) and private
   * panel assets (`_meta_panel_assets` + `panels/{land}/…` R2 keys) are NOT
   * exported or applied, so `scope: 'all'` covers collections, records, groups,
   * media and settings only. Back up or restore Panels through the
   * `/api/_panels` manifest endpoints until this is wired up.
   */
}

export interface ExportSeedInput {
  db: Db
  kv: KVNamespace
  bucket: R2Bucket
  land: string
  colony: string
  scope: string
  withMediaBytes: boolean
  origin: string
}

export interface SeedApplyInput {
  db: Db
  kv: KVNamespace
  bucket: R2Bucket
  land: string
  colony: string
  snap: unknown
  wipe: boolean
}

export interface SeedApplySummary {
  sourceLand: string
  sourceColony: string
  sourceOrigin: string
  collections: string[]
  groups: number
  settings: boolean
  media: number
  mediaObjects: number
  records: number
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** Pull R2 keys referenced by a `variants` JSON column. */
function variantKeys(value: unknown): string[] {
  if (!value) return []
  try {
    const arr = JSON.parse(String(value)) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map((v) => (v as { key?: unknown })?.key)
      .filter((k: unknown): k is string => typeof k === 'string' && k.length > 0)
  } catch {
    return []
  }
}

function stripLand(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (key === 'land') continue
    out[key] = value
  }
  return out
}

async function readMediaRows(
  db: Db,
  land: string,
  colony: string,
): Promise<Record<string, unknown>[]> {
  await ensureMediaTable(db)
  const rows = await db.all<Record<string, unknown> & { land: string }>(
    sql`SELECT rowid AS _rowid, * FROM _meta_media WHERE land = ${land} AND colony = ${colony} ORDER BY rowid`,
  )
  return rows.map((row) => stripLand(row as Record<string, unknown>))
}

async function collectMediaObjects(
  bucket: R2Bucket,
  rows: Record<string, unknown>[],
): Promise<Record<string, SeedObjectBytes>> {
  const objects: Record<string, SeedObjectBytes> = {}
  const keys = new Set<string>()
  for (const row of rows) {
    if (typeof row.key === 'string' && row.key) keys.add(row.key)
    if (typeof row.thumb_key === 'string' && row.thumb_key) keys.add(row.thumb_key)
    for (const key of variantKeys(row.variants)) keys.add(key)
  }
  for (const key of keys) {
    const obj = await bucket.get(key)
    if (!obj) continue
    const buffer = await obj.arrayBuffer()
    objects[key] = {
      b64: bytesToBase64(new Uint8Array(buffer)),
      mime: obj.httpMetadata?.contentType ?? '',
    }
  }
  return objects
}

export async function exportSnapshot(input: ExportSeedInput): Promise<SeedSnapshot> {
  const { db, kv, bucket, land, colony, scope, withMediaBytes, origin } = input
  const defs = (await listCollections(db, land, colony)).filter(
    (d) => d.name !== PROTECTED_COLLECTION,
  )
  const selected = scope === 'all' ? defs : defs.filter((d) => d.name === scope)

  const records: Record<string, SeedRow[]> = {}
  for (const def of selected) {
    const table = physicalTable(land, colony, def.name)
    const rows = await db.all<Record<string, unknown>>(
      sql`SELECT rowid AS _rowid, * FROM ${sql.raw(quoteIdentifier(table))} ORDER BY rowid`,
    )
    records[def.name] = rows.map((row) => stripLand(row) as SeedRow)
  }

  const groups = (await listGroups(db, land, colony)).map((g) => {
    const def: SeedGroup = { id: g.id, label: g.label }
    if (g.parent) def.parent = g.parent
    if (g.icon) def.icon = g.icon
    return def
  })

  const settings = (await getSettings(kv, land, colony).catch(() => ({}))) as Record<string, unknown>

  const media = await readMediaRows(db, land, colony)
  const mediaObjects = withMediaBytes ? await collectMediaObjects(bucket, media) : null

  return {
    kind: SEED_KIND,
    version: SEED_VERSION,
    exportedAt: new Date().toISOString(),
    origin,
    land,
    colony,
    scope,
    settings: Object.keys(settings).length > 0 ? settings : null,
    groups,
    collections: selected,
    records,
    media,
    mediaObjects,
  }
}

/** Insert one row into a physical table, preserving its exported rowid. */
async function insertRow(db: Db, table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row).filter((k) => k !== 'land' && k !== '_rowid')
  if (cols.length === 0) return
  const colSql = sql.raw(cols.map(quoteIdentifier).join(', '))
  const placeholders = sql.join(
    cols.map((k) => sql`${row[k] ?? null}`),
    sql`, `,
  )
  const rowid = typeof row._rowid === 'number' ? row._rowid : null
  const target = sql.raw(quoteIdentifier(table))
  if (rowid != null) {
    await db.run(
      sql`INSERT OR REPLACE INTO ${target} (rowid, ${colSql}) VALUES (${rowid}, ${placeholders})`,
    )
  } else {
    await db.run(sql`INSERT OR REPLACE INTO ${target} (${colSql}) VALUES (${placeholders})`)
  }
}

/** Delete every group children-first (parents are rejected while children exist). */
async function wipeGroups(db: Db, land: string, colony: string): Promise<void> {
  const groups = await listGroups(db, land, colony)
  const byId = new Map(groups.map((g) => [g.id, g]))
  const depth = new Map<string, number>()
  const depthOf = (g: { id: string; parent?: string | null }): number => {
    if (!g.parent || !byId.has(g.parent)) return 0
    const cached = depth.get(g.parent)
    if (cached !== undefined) return cached + 1
    depth.set(g.parent, depthOf(byId.get(g.parent)!) + 1)
    return depth.get(g.parent)!
  }
  for (const g of groups) depth.set(g.id, depthOf(g))
  const ordered = [...groups].sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0))
  for (const g of ordered) {
    try {
      await deleteGroup(db, g.id, land, colony)
    } catch {
      // already gone or guarded by another group's removal
    }
  }
}

function validateSnapshot(snap: SeedSnapshot): void {
  if (snap.kind !== SEED_KIND) {
    throw badRequest(`Not a ${SEED_KIND} snapshot (got '${String(snap.kind)}')`, 'INVALID_SEED')
  }
  if (snap.version !== SEED_VERSION) {
    throw badRequest(`Unsupported seed snapshot version ${String(snap.version)}`, 'INVALID_SEED')
  }
  if (!Array.isArray(snap.collections)) {
    throw badRequest('Seed snapshot is missing the collections array', 'INVALID_SEED')
  }
  if (!Array.isArray(snap.groups)) {
    throw badRequest('Seed snapshot is missing the groups array', 'INVALID_SEED')
  }
  if (snap.records === null || typeof snap.records !== 'object' || Array.isArray(snap.records)) {
    throw badRequest('Seed snapshot is missing the records map', 'INVALID_SEED')
  }
  if (snap.media !== null && !Array.isArray(snap.media)) {
    throw badRequest('Seed snapshot media must be an array or null', 'INVALID_SEED')
  }
}

/** Parse every group (schema + snake_case), verify parents resolve within the snapshot, and
 *  return them topologically sorted so apply can insert parents before children. Throws
 *  before anything is wiped. */
function validateGroupsAndOrder(groups: SeedGroup[]): SeedGroup[] {
  const byId = new Map<string, SeedGroup>()
  for (const g of groups) {
    const parsed = groupDefinitionSchema.safeParse(g)
    if (!parsed.success) {
      throw badRequest(
        'Invalid group definition: ' + parsed.error.issues.map((i) => i.message).join('; '),
        'INVALID_GROUP',
      )
    }
    const def = parsed.data
    if (!isIdentifier(def.id)) throw badRequest('Group id must be snake_case', 'INVALID_GROUP')
    byId.set(def.id, {
      id: def.id,
      label: def.label,
      parent: def.parent ?? null,
      icon: def.icon ?? null,
    })
  }
  const order: SeedGroup[] = []
  const placed = new Set<string>()
  const pending = [...byId.values()]
  while (pending.length > 0) {
    let made = false
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const g = pending[i]!
      const parent = g.parent ?? null
      if (parent && !byId.has(parent)) {
        throw badRequest(`Parent group '${parent}' is not registered`, 'GROUP_PARENT_NOT_FOUND')
      }
      if (parent && !placed.has(parent)) continue
      order.push(g)
      placed.add(g.id)
      pending.splice(i, 1)
      made = true
    }
    if (!made) {
      throw badRequest('Seed snapshot groups contain a parent cycle', 'GROUP_CYCLE')
    }
  }
  return order
}

/** Parse every collection definition up front so a broken snapshot can never wipe the target. */
export function validateCollections(defs: CollectionDefinition[]): void {
  for (const d of defs) {
    const parsed = collectionDefinitionSchema.safeParse(d)
    if (!parsed.success) {
      throw badRequest(
        'Invalid collection definition: ' + parsed.error.issues.map((i) => i.message).join('; '),
        'INVALID_COLLECTION',
      )
    }
    if (!isIdentifier(parsed.data.name)) throw badRequest('Collection name must be snake_case', 'INVALID_COLLECTION')
  }
}

export async function applySnapshot(input: SeedApplyInput): Promise<SeedApplySummary> {
  const { db, kv, bucket, land, colony = COLONY_DEFAULT, wipe } = input
  if (!input.snap || typeof input.snap !== 'object' || Array.isArray(input.snap)) {
    throw badRequest('Failed to parse seed snapshot JSON', 'INVALID_SEED')
  }
  const snap = input.snap as SeedSnapshot
  validateSnapshot(snap)

  const collections = snap.collections.filter((d) => d && typeof d.name === 'string' && isIdentifier(d.name))
  const records = snap.records as Record<string, SeedRow[]>

  // Validate the ENTIRE snapshot before any destructive step runs.
  const groupOrder = validateGroupsAndOrder(snap.groups)
  validateCollections(collections)

  if (wipe) {
    const defs = (await listCollections(db, land, colony)).filter(
      (d) => d.name !== PROTECTED_COLLECTION,
    )
    for (const d of defs) await deleteCollection(db, d.name, land, colony)
    await wipeGroups(db, land, colony)
    const mediaIds = await db.all<{ id: string }>(
      sql`SELECT id FROM _meta_media WHERE land = ${land} AND colony = ${colony}`,
    )
    for (const { id } of mediaIds) {
      const keys = await deleteMedia(db, id, land, colony)
      const objects = [keys.key, keys.thumbKey, ...keys.variantKeys].filter(
        (k): k is string => typeof k === 'string' && k.length > 0,
      )
      await Promise.all(objects.map((k) => bucket.delete(k)))
    }
  }

  for (const g of groupOrder) {
    const gDef: Record<string, unknown> = { id: g.id, label: g.label ?? g.id }
    if (g.parent) gDef.parent = g.parent
    if (g.icon) gDef.icon = g.icon
    await putGroup(db, gDef, land, colony)
  }

  for (const def of collections) {
    await putCollection(db, def as unknown as Record<string, unknown>, land, colony)
  }

  await kv.put(settingsKeyFor(land, colony), JSON.stringify(snap.settings ?? {}))

  const decoded = new Map<string, Uint8Array>()
  let mediaCount = 0
  let objectCount = 0
  for (const row of snap.media ?? []) {
    const keys = [row.key, row.thumb_key, ...variantKeys(row.variants)].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    )
    for (const key of keys) {
      if (decoded.has(key)) continue
      const entry = snap.mediaObjects?.[key]
      if (!entry) continue
      const bytes = base64ToBytes(entry.b64)
      decoded.set(key, bytes)
      await bucket.put(key, bytes, { httpMetadata: { contentType: entry.mime } })
      objectCount += 1
    }
    await insertRow(db, '_meta_media', row)
    mediaCount += 1
  }

  let recordCount = 0
  for (const def of collections) {
    const name = def.name
    const rows = records[name]
    if (!Array.isArray(rows)) continue
    const table = physicalTable(land, colony, name)
    for (const row of rows) {
      await insertRow(db, table, row as unknown as Record<string, unknown>)
      recordCount += 1
    }
  }

  return {
    sourceLand: snap.land,
    sourceColony: snap.colony,
    sourceOrigin: snap.origin,
    collections: collections.map((d) => d.name),
    groups: groupOrder.length,
    settings: true,
    media: mediaCount,
    mediaObjects: objectCount,
    records: recordCount,
  }
}