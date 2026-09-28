/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { desc, eq, like, or, and, sql, type SQL } from 'drizzle-orm'
import type {
  MediaObject,
  MediaTaxonomy,
  MediaTaxonomyDetail,
  MediaUpdate,
  TaxonomyAction,
} from '@hamolus/types'
import { buildPaginationMeta, type PaginationMeta } from '@hamolus/types'
import type { Db } from '../db/client'
import { metaMedia, type MetaMediaRow } from '../db/schema'
import { notFound } from '../errors'

let mediaReady = false

const MEDIA_EXTRA_COLUMNS: Array<[string, string]> = [
  ['land', "TEXT NOT NULL DEFAULT 'root_lnd'"],
  ['colony', "TEXT NOT NULL DEFAULT 'root_cny'"],
  ['width', 'INTEGER'],
  ['height', 'INTEGER'],
  ['title', 'TEXT'],
  ['alt', 'TEXT'],
  ['description', 'TEXT'],
  ['group', 'TEXT'],
  ['category', 'TEXT'],
  ['tags', 'TEXT'],
  ['focus_x', 'REAL'],
  ['focus_y', 'REAL'],
  ['thumb_key', 'TEXT'],
  ['caption', 'TEXT'],
  ['variants', 'TEXT'],
]

/** Auto-bootstrap of the `_meta_media` metadata table (idempotent per isolate). */
export async function ensureMediaTable(db: Db): Promise<void> {
  if (mediaReady) return
  const boot = db
      .run(sql`
      CREATE TABLE IF NOT EXISTS _meta_media (
        id TEXT PRIMARY KEY,
        land TEXT NOT NULL DEFAULT 'root_lnd',
        colony TEXT NOT NULL DEFAULT 'root_cny',
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        title TEXT,
        alt TEXT,
        description TEXT,
        "group" TEXT,
        category TEXT,
        tags TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        thumb_key TEXT,
        caption TEXT,
        variants TEXT
      )
    `)
      .then(async () => {
        // Migrate tables created before width/height/SEO/taxonomy columns existed.
        const cols = await db.all<{ name: string }>(sql`PRAGMA table_info(${sql.raw('_meta_media')})`)
        const existing = new Set(cols.map((c) => c.name))
        for (const [col, type] of MEDIA_EXTRA_COLUMNS) {
          if (existing.has(col)) continue
          await db.run(sql`ALTER TABLE _meta_media ADD COLUMN ${sql.raw(`"${col.replace(/"/g, '')}" ${type}`)}`)
        }
      })
  await boot
  mediaReady = true
}

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** Variants as persisted in the D1 row (no `url` — derived per request origin). */
export type StoredVariant = Omit<MediaObject['variants'][number], 'url'>

function parseVariants(raw: string | null): StoredVariant[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter(
      (x): x is StoredVariant =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as { label?: unknown }).label === 'string' &&
        typeof (x as { key?: unknown }).key === 'string',
    )
  } catch {
    return []
  }
}

export function rowToMedia(row: MetaMediaRow, baseUrl: string): MediaObject {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    mime: row.mime,
    size: row.size,
    width: row.width ?? null,
    height: row.height ?? null,
    title: row.title ?? null,
    alt: row.alt ?? null,
    description: row.description ?? null,
    group: row.group ?? null,
    category: row.category ?? null,
    tags: parseTags(row.tags),
    focusX: row.focusX ?? null,
    focusY: row.focusY ?? null,
    url: `${baseUrl}/media/${row.key}`,
    thumbKey: row.thumbKey ?? null,
    thumbUrl: row.thumbKey ? `${baseUrl}/media/${row.thumbKey}` : null,
    caption: row.caption ?? null,
    variants: parseVariants(row.variants).map((v) => ({ ...v, url: `${baseUrl}/media/${v.key}` })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface ListMediaResult {
  data: MediaObject[]
  meta: PaginationMeta
}

export interface ListMediaOpts {
  page?: number
  pageSize?: number
  search?: string
  group?: string
  category?: string
  tag?: string
}

export async function listMedia(
  db: Db,
  baseUrl: string,
  opts: ListMediaOpts,
  land: string,
  colony: string,
): Promise<ListMediaResult> {
  await ensureMediaTable(db)
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20))
  const term = opts.search?.trim()
  const clauses: SQL[] = [eq(metaMedia.land, land), eq(metaMedia.colony, colony)]
  if (term) {
    clauses.push(
      or(
        like(metaMedia.name, `%${term}%`),
        like(metaMedia.mime, `%${term}%`),
        like(metaMedia.title, `%${term}%`),
        like(metaMedia.group, `%${term}%`),
        like(metaMedia.category, `%${term}%`),
        like(metaMedia.tags, `%${term}%`),
      )!,
    )
  }
  if (opts.group) clauses.push(eq(metaMedia.group, opts.group))
  if (opts.category) clauses.push(eq(metaMedia.category, opts.category))
  if (opts.tag) clauses.push(like(metaMedia.tags, `%"${opts.tag}"%`))
  const filter = clauses.length > 0 ? and(...clauses) : undefined

  const rows = await db
    .select()
    .from(metaMedia)
    .where(filter)
    .orderBy(desc(metaMedia.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(metaMedia)
    .where(filter)

  return {
    data: rows.map((r) => rowToMedia(r, baseUrl)),
    meta: buildPaginationMeta(page, pageSize, Number(count)),
  }
}

/** Distinct group / category / tag values across a land's assets (for filters + suggestions). */
export async function mediaTaxonomy(db: Db, land: string, colony: string): Promise<MediaTaxonomy> {
  await ensureMediaTable(db)

  const groups = await db
    .selectDistinct({ value: metaMedia.group })
    .from(metaMedia)
    .where(
      and(
        eq(metaMedia.land, land),
        eq(metaMedia.colony, colony),
        sql`${metaMedia.group} IS NOT NULL AND ${metaMedia.group} != ''`,
      ),
    )

  const categories = await db
    .selectDistinct({ value: metaMedia.category })
    .from(metaMedia)
    .where(
      and(eq(metaMedia.land, land), sql`${metaMedia.category} IS NOT NULL AND ${metaMedia.category} != ''`),
    )

  const tagRows = await db
    .select({ tags: metaMedia.tags })
    .from(metaMedia)
    .where(and(eq(metaMedia.land, land), sql`${metaMedia.tags} IS NOT NULL`))
  const tagSet = new Set<string>()
  for (const row of tagRows) {
    for (const t of parseTags(row.tags)) tagSet.add(t)
  }

  return {
    groups: groups.map((g) => g.value!).sort(),
    categories: categories.map((c) => c.value!).sort(),
    tags: [...tagSet].sort(),
  }
}

/** Taxonomy values with per-value usage counts (for the console management panel). */
export async function mediaTaxonomyDetail(
  db: Db,
  land: string,
  colony: string,
): Promise<MediaTaxonomyDetail> {
  await ensureMediaTable(db)

  const groupRows = await db.all<{ value: string; count: number }>(
    sql`SELECT "group" AS value, count(*) AS count FROM _meta_media
        WHERE land = ${land} AND colony = ${colony} AND "group" IS NOT NULL AND "group" != ''
        GROUP BY "group" ORDER BY "group" COLLATE NOCASE`,
  )
  const categoryRows = await db.all<{ value: string; count: number }>(
    sql`SELECT category AS value, count(*) AS count FROM _meta_media
        WHERE land = ${land} AND colony = ${colony} AND category IS NOT NULL AND category != ''
        GROUP BY category ORDER BY category COLLATE NOCASE`,
  )
  const tagRows = await db.all<{ tags: string | null }>(
    sql`SELECT tags FROM _meta_media WHERE land = ${land} AND colony = ${colony} AND tags IS NOT NULL`,
  )
  const tagCounts = new Map<string, number>()
  for (const row of tagRows) {
    for (const t of parseTags(row.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  }

  return {
    groups: groupRows.map((r) => ({ value: r.value, count: r.count })),
    categories: categoryRows.map((r) => ({ value: r.value, count: r.count })),
    tags: [...tagCounts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
  }
}

/**
 * Rename or remove a taxonomy value across every asset. `action.to` present →
 * rename (merges into a duplicate target); absent → remove the value.
 */
export async function applyTaxonomyChange(
  db: Db,
  action: TaxonomyAction,
  land: string,
  colony: string,
): Promise<MediaTaxonomyDetail> {
  await ensureMediaTable(db)
  const { type, from, to } = action

  if (type === 'group' || type === 'category') {
    const col = type === 'group' ? '"group"' : 'category'
    if (to !== undefined) {
      await db.run(
        sql`UPDATE _meta_media SET ${sql.raw(col)} = ${to}
            WHERE land = ${land} AND colony = ${colony} AND ${sql.raw(col)} = ${from}`,
      )
    } else {
      await db.run(
        sql`UPDATE _meta_media SET ${sql.raw(col)} = NULL
            WHERE land = ${land} AND colony = ${colony} AND ${sql.raw(col)} = ${from}`,
      )
    }
  } else {
    const rows = await db.all<{ id: string; tags: string | null }>(
      sql`SELECT id, tags FROM _meta_media WHERE land = ${land} AND colony = ${colony}`,
    )
    for (const row of rows) {
      const tags = parseTags(row.tags)
      if (!tags.includes(from)) continue
      const next = to !== undefined
        ? [...new Set(tags.map((t) => (t === from ? to! : t)))]
        : tags.filter((t) => t !== from)
      await db.run(sql`UPDATE _meta_media SET tags = ${next.length ? JSON.stringify(next) : null} WHERE id = ${row.id}`)
    }
  }

  return mediaTaxonomyDetail(db, land, colony)
}

export async function getMedia(
  db: Db,
  id: string,
  baseUrl: string,
  land: string,
  colony: string,
): Promise<MediaObject> {
  const row = await getMediaRow(db, id, land, colony)
  return rowToMedia(row, baseUrl)
}

async function getMediaRow(db: Db, id: string, land: string, colony: string): Promise<MetaMediaRow> {
  await ensureMediaTable(db)
  const rows = await db
    .select()
    .from(metaMedia)
    .where(and(eq(metaMedia.id, id), eq(metaMedia.land, land), eq(metaMedia.colony, colony)))
    .limit(1)
  const row = rows[0]
  if (!row) throw notFound('Media not found')
  return row
}

/** Look up a media row by R2 object key (falls back to thumbnail + variant keys). */
export async function getMediaRowByKey(db: Db, key: string): Promise<MetaMediaRow | null> {
  await ensureMediaTable(db)
  const rows = await db
    .select()
    .from(metaMedia)
    .where(or(eq(metaMedia.key, key), eq(metaMedia.thumbKey, key)))
    .limit(1)
  if (rows[0]) return rows[0]
  // Variant keys are `<uuid>.<label>.<ext>` — match by the leading id prefix.
  const m = key.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./)
  if (!m) return null
  const byId = await db.select().from(metaMedia).where(eq(metaMedia.id, m[1])).limit(1)
  if (!byId[0]) return null
  return parseVariants(byId[0].variants).some((v) => v.key === key) ? byId[0] : null
}

export async function createMedia(
  db: Db,
  input: {
    id: string
    key: string
    name: string
    mime: string
    size: number
    width?: number | null
    height?: number | null
    title?: string | null
    alt?: string | null
    description?: string | null
    group?: string | null
    category?: string | null
    tags?: string[] | null
    focusX?: number | null
    focusY?: number | null
    thumbKey?: string | null
    caption?: string | null
    variants?: StoredVariant[]
  },
  land: string,
  colony: string,
): Promise<void> {
  await ensureMediaTable(db)
  const values = {
    id: input.id,
    land,
    colony,
    key: input.key,
    name: input.name,
    mime: input.mime,
    size: input.size,
    width: input.width ?? null,
    height: input.height ?? null,
    title: input.title ?? null,
    alt: input.alt ?? null,
    description: input.description ?? null,
    group: input.group ?? null,
    category: input.category ?? null,
    tags: input.tags ? JSON.stringify(input.tags) : null,
    focusX: input.focusX ?? null,
    focusY: input.focusY ?? null,
    thumbKey: input.thumbKey ?? null,
    caption: input.caption ?? null,
    variants: input.variants && input.variants.length > 0 ? JSON.stringify(input.variants) : null,
  }
  await db.insert(metaMedia).values(values)
}

/** Apply metadata edits (rename + SEO + taxonomy fields). Only given keys are updated. */
export async function updateMedia(
  db: Db,
  id: string,
  patch: MediaUpdate,
  baseUrl: string,
  land: string,
  colony: string,
): Promise<MediaObject> {
  await ensureMediaTable(db)
  const sets: SQL[] = []
  const add = (col: string, value: unknown) => {
    if (value !== undefined) sets.push(sql`${sql.raw(`"${col}"`)} = ${value}`)
  }
  add('name', patch.name)
  add('title', patch.title)
  add('alt', patch.alt)
  add('description', patch.description)
  add('caption', patch.caption)
  add('group', patch.group)
  add('category', patch.category)
  if (patch.tags !== undefined) {
    add('tags', patch.tags === null ? null : JSON.stringify(patch.tags))
  }
  if (patch.focusX !== undefined) add('focus_x', patch.focusX)
  if (patch.focusY !== undefined) add('focus_y', patch.focusY)
  if (sets.length === 0) throw notFound('Media not found')
  sets.push(sql`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)

  const res = await db.run(
    sql`UPDATE _meta_media SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id} AND land = ${land} AND colony = ${colony}`,
  )
  if (res.meta.changes === 0) throw notFound('Media not found')
  return getMedia(db, id, baseUrl, land, colony)
}

/** Replace the bytes of an asset under its existing R2 key (dimensions update). */
export async function replaceMedia(
  db: Db,
  id: string,
  input: {
    mime: string
    size: number
    width: number | null
    height: number | null
    thumbKey?: string | null
  },
  baseUrl: string,
  land: string,
  colony: string,
): Promise<MediaObject> {
  await ensureMediaTable(db)
  const update: Partial<typeof metaMedia.$inferInsert> = {
    size: input.size,
    mime: input.mime,
    width: input.width,
    height: input.height,
    updatedAt: new Date().toISOString(),
  }
  if (input.thumbKey !== undefined) update.thumbKey = input.thumbKey
  const res = await db
    .update(metaMedia)
    .set(update)
    .where(and(eq(metaMedia.id, id), eq(metaMedia.land, land), eq(metaMedia.colony, colony)))
  if (res.meta.changes === 0) throw notFound('Media not found')
  return getMedia(db, id, baseUrl, land, colony)
}

export async function deleteMedia(
  db: Db,
  id: string,
  land: string,
  colony: string,
): Promise<{ key: string; thumbKey: string | null; variantKeys: string[] }> {
  const row = await getMediaRow(db, id, land, colony)
  await db
    .delete(metaMedia)
    .where(and(eq(metaMedia.id, id), eq(metaMedia.land, land), eq(metaMedia.colony, colony)))
  return {
    key: row.key,
    thumbKey: row.thumbKey ?? null,
    variantKeys: parseVariants(row.variants).map((v) => v.key),
  }
}

/** Drop every media row of one colony; returns the R2 keys that must be purged. */
export async function deleteMediaForColony(
  db: Db,
  land: string,
  colony: string,
): Promise<string[]> {
  await ensureMediaTable(db)
  const rows = await db.all<{ key: string; thumbKey: string | null; variants: string | null }>(
    sql`SELECT key, thumb_key AS "thumbKey", variants FROM _meta_media
        WHERE land = ${land} AND colony = ${colony}`,
  )
  if (rows.length === 0) return []
  await db.run(sql`DELETE FROM _meta_media WHERE land = ${land} AND colony = ${colony}`)
  const keys: string[] = []
  for (const row of rows) {
    keys.push(row.key)
    if (row.thumbKey) keys.push(row.thumbKey)
    for (const variant of parseVariants(row.variants)) keys.push(variant.key)
  }
  return keys
}

/**
 * Land-wide sweep. Only reachable for a land that owns no colonies (land delete
 * is otherwise blocked), so it doubles as the safety net for orphaned rows.
 */
export async function deleteMediaForLand(db: Db, land: string): Promise<string[]> {
  await ensureMediaTable(db)
  const rows = await db.all<{ key: string; thumbKey: string | null; variants: string | null }>(
    sql`SELECT key, thumb_key AS "thumbKey", variants FROM _meta_media WHERE land = ${land}`,
  )
  if (rows.length === 0) return []
  await db.run(sql`DELETE FROM _meta_media WHERE land = ${land}`)
  const keys: string[] = []
  for (const row of rows) {
    keys.push(row.key)
    if (row.thumbKey) keys.push(row.thumbKey)
    for (const variant of parseVariants(row.variants)) keys.push(variant.key)
  }
  return keys
}