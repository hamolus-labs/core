/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { and, desc, eq, like, or, sql, type SQL } from 'drizzle-orm'
import type { FileKind, FileObject, FilePatch, MediaTaxonomy } from '@hamolus/types'
import { buildPaginationMeta, type PaginationMeta } from '@hamolus/types'
import type { Db } from '../db/client'
import { quoteIdentifier } from '../db/table'
import { metaAttachments, metaDocuments, type MetaFileRow } from '../db/schema'
import { notFound } from '../errors'

type FileTable = typeof metaDocuments

const KINDS: Record<
  FileKind,
  { table: FileTable; tableName: string; folder: string; urlPrefix: string; noun: string }
> = {
  document: {
    table: metaDocuments,
    tableName: '_meta_documents',
    folder: 'doc',
    urlPrefix: '/documents',
    noun: 'Document',
  },
  // Structurally identical to the documents table — safe shape cast.
  attachment: {
    table: metaAttachments as FileTable,
    tableName: '_meta_attachments',
    folder: 'att',
    urlPrefix: '/attachments',
    noun: 'Attachment',
  },
}

let ready: Record<FileKind, boolean> = { document: false, attachment: false }

/** Columns added after the initial table shape (SEO + taxonomy + land/colony). */
const FILE_EXTRA_COLUMNS: Array<[string, string]> = [
  ['land', "TEXT NOT NULL DEFAULT 'root_lnd'"],
  ['colony', "TEXT NOT NULL DEFAULT 'root_cny'"],
  ['title', 'TEXT'],
  ['description', 'TEXT'],
  ['group', 'TEXT'],
  ['category', 'TEXT'],
  ['tags', 'TEXT'],
]

/** Auto-bootstrap of a file-library metadata table (idempotent per isolate). */
export async function ensureFileTable(db: Db, kind: FileKind): Promise<void> {
  if (ready[kind]) return
  const { tableName } = KINDS[kind]
  const boot = db
      .run(sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(tableName)} (
        id TEXT PRIMARY KEY,
        land TEXT NOT NULL DEFAULT 'root_lnd',
        colony TEXT NOT NULL DEFAULT 'root_cny',
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        ext TEXT NOT NULL,
        title TEXT,
        description TEXT,
        "group" TEXT,
        category TEXT,
        tags TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `)
      .then(async () => {
        // Migrate tables created before the SEO/taxonomy columns existed.
        const cols = await db.all<{ name: string }>(sql`PRAGMA table_info(${sql.raw(tableName)})`)
        const existing = new Set(cols.map((c) => c.name))
        for (const [col, type] of FILE_EXTRA_COLUMNS) {
          if (existing.has(col)) continue
          await db.run(
            sql`ALTER TABLE ${sql.raw(tableName)} ADD COLUMN ${sql.raw(`"${col.replace(/"/g, '')}" ${type}`)}`,
          )
        }
      })
  await boot
  ready[kind] = true
}

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** Public basename of an R2 storage key (strip the `doc/` / `att/` prefix). */
function basenameOf(key: string): string {
  const slash = key.indexOf('/')
  return slash >= 0 ? key.slice(slash + 1) : key
}

export function rowToFile(row: MetaFileRow, baseUrl: string, kind: FileKind): FileObject {
  const { urlPrefix } = KINDS[kind]
  const url = `${baseUrl}${urlPrefix}/${basenameOf(row.key)}`
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    mime: row.mime,
    size: row.size,
    ext: row.ext,
    title: row.title ?? null,
    description: row.description ?? null,
    group: row.group ?? null,
    category: row.category ?? null,
    tags: parseTags(row.tags),
    url,
    downloadUrl: kind === 'document' ? `${url}/download` : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface ListFilesResult {
  data: FileObject[]
  meta: PaginationMeta
}

export interface ListFilesOpts {
  page?: number
  pageSize?: number
  search?: string
  group?: string
  category?: string
  tag?: string
}

export async function listFiles(
  db: Db,
  baseUrl: string,
  kind: FileKind,
  opts: ListFilesOpts,
  land: string,
  colony: string,
): Promise<ListFilesResult> {
  await ensureFileTable(db, kind)
  const { table } = KINDS[kind]
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20))
  const term = opts.search?.trim()
  const clauses: SQL[] = [eq(table.land, land), eq(table.colony, colony)]
  if (term) {
    clauses.push(
      or(
        like(table.name, `%${term}%`),
        like(table.mime, `%${term}%`),
        like(table.title, `%${term}%`),
        like(table.group, `%${term}%`),
        like(table.category, `%${term}%`),
        like(table.tags, `%${term}%`),
      )!,
    )
  }
  if (opts.group) clauses.push(eq(table.group, opts.group))
  if (opts.category) clauses.push(eq(table.category, opts.category))
  if (opts.tag) clauses.push(like(table.tags, `%"${opts.tag}"%`))
  const filter = clauses.length > 0 ? and(...clauses) : undefined

  const rows = await db
    .select()
    .from(table)
    .where(filter)
    .orderBy(desc(table.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(table).where(filter)

  return {
    data: rows.map((r) => rowToFile(r, baseUrl, kind)),
    meta: buildPaginationMeta(page, pageSize, Number(count)),
  }
}

/** Distinct group / category / tag values across a land's assets (for filters + suggestions). */
export async function fileTaxonomy(
  db: Db,
  kind: FileKind,
  land: string,
  colony: string,
): Promise<MediaTaxonomy> {
  await ensureFileTable(db, kind)
  const tableName = KINDS[kind].tableName
  const groupRows = await db.all<{ value: string | null }>(
    sql`SELECT DISTINCT "group" AS value FROM ${sql.raw(tableName)}
        WHERE land = ${land} AND colony = ${colony} AND "group" IS NOT NULL AND "group" != '' ORDER BY "group" COLLATE NOCASE`,
  )
  const categoryRows = await db.all<{ value: string | null }>(
    sql`SELECT DISTINCT category AS value FROM ${sql.raw(tableName)}
        WHERE land = ${land} AND colony = ${colony} AND category IS NOT NULL AND category != '' ORDER BY category COLLATE NOCASE`,
  )
  const tagRows = await db.all<{ tags: string | null }>(
    sql`SELECT tags FROM ${sql.raw(tableName)} WHERE land = ${land} AND colony = ${colony} AND tags IS NOT NULL`,
  )
  const tagSet = new Set<string>()
  for (const row of tagRows) {
    for (const t of parseTags(row.tags)) tagSet.add(t)
  }
  return {
    groups: groupRows.map((g) => g.value!).sort(),
    categories: categoryRows.map((c) => c.value!).sort(),
    tags: [...tagSet].sort(),
  }
}

function nounFor(kind: FileKind): string {
  return KINDS[kind].noun
}

export async function getFile(
  db: Db,
  kind: FileKind,
  id: string,
  baseUrl: string,
  land: string,
  colony: string,
): Promise<FileObject> {
  const row = await getFileRow(db, kind, id, land, colony)
  return rowToFile(row, baseUrl, kind)
}

async function getFileRow(db: Db, kind: FileKind, id: string, land: string, colony: string): Promise<MetaFileRow> {
  await ensureFileTable(db, kind)
  const { table, noun } = KINDS[kind]
  const rows = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.land, land), eq(table.colony, colony)))
    .limit(1)
  const row = rows[0]
  if (!row) throw notFound(`${noun} not found`)
  return row
}

/** Look up a file row by public basename (the route param, without the library prefix). */
export async function getFileRowByBasename(
  db: Db,
  kind: FileKind,
  basename: string,
): Promise<MetaFileRow | null> {
  await ensureFileTable(db, kind)
  const { table, folder } = KINDS[kind]
  const rows = await db
    .select()
    .from(table)
    .where(eq(table.key, `${folder}/${basename}`))
    .limit(1)
  return rows[0] ?? null
}

export async function createFile(
  db: Db,
  kind: FileKind,
  input: {
    id: string
    key: string
    name: string
    mime: string
    size: number
    ext: string
    title?: string | null
    description?: string | null
    group?: string | null
    category?: string | null
    tags?: string[] | null
  },
  land: string,
  colony: string,
): Promise<void> {
  await ensureFileTable(db, kind)
  const { table } = KINDS[kind]
  await db.insert(table).values({
    id: input.id,
    land,
    colony,
    key: input.key,
    name: input.name,
    mime: input.mime,
    size: input.size,
    ext: input.ext,
    title: input.title ?? null,
    description: input.description ?? null,
    group: input.group ?? null,
    category: input.category ?? null,
    tags: input.tags ? JSON.stringify(input.tags) : null,
  })
}

/** Apply metadata edits (rename + SEO + taxonomy fields). Only given keys are updated. */
export async function updateFile(
  db: Db,
  kind: FileKind,
  id: string,
  patch: FilePatch,
  baseUrl: string,
  land: string,
  colony: string,
): Promise<FileObject> {
  await ensureFileTable(db, kind)
  const { tableName, noun } = KINDS[kind]
  const sets: SQL[] = []
  const add = (col: string, value: unknown) => {
    if (value !== undefined) sets.push(sql`${sql.raw(`"${col}"`)} = ${value}`)
  }
  add('name', patch.name)
  add('title', patch.title)
  add('description', patch.description)
  add('group', patch.group)
  add('category', patch.category)
  if (patch.tags !== undefined) {
    add('tags', patch.tags === null ? null : JSON.stringify(patch.tags))
  }
  if (sets.length === 0) throw notFound(`${noun} not found`)
  sets.push(sql`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)

  const res = await db.run(
    sql`UPDATE ${sql.raw(tableName)} SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id} AND land = ${land} AND colony = ${colony}`,
  )
  if (res.meta.changes === 0) throw notFound(`${noun} not found`)
  return getFile(db, kind, id, baseUrl, land, colony)
}

/** Delete a file row and return its R2 object key (the route purges the bytes). */
export async function deleteFile(
  db: Db,
  kind: FileKind,
  id: string,
  land: string,
  colony: string,
): Promise<{ key: string }> {
  const { table, noun } = KINDS[kind]
  const row = await getFileRow(db, kind, id, land, colony)
  await db
    .delete(table)
    .where(and(eq(table.id, id), eq(table.land, land), eq(table.colony, colony)))
  return { key: row.key }
}

/**
 * Delete every file row of one library kind owned by a land and return the R2
 * object keys so the caller can purge the bytes. Used when a land is removed.
 */
/** Drop every file row of one colony; returns the R2 keys that must be purged. */
export async function deleteFilesForColony(
  db: Db,
  kind: FileKind,
  land: string,
  colony: string,
): Promise<string[]> {
  await ensureFileTable(db, kind)
  const { table, tableName } = KINDS[kind]
  const rows = await db.all<{ key: string }>(
    sql`SELECT key FROM ${sql.raw(quoteIdentifier(tableName))}
        WHERE land = ${land} AND colony = ${colony}`,
  )
  if (rows.length === 0) return []
  await db.delete(table).where(and(eq(table.land, land), eq(table.colony, colony)))
  return rows.map((row) => row.key)
}

export async function deleteFilesForLand(db: Db, kind: FileKind, land: string): Promise<string[]> {
  await ensureFileTable(db, kind)
  const { table, tableName } = KINDS[kind]
  const rows = await db.all<{ key: string }>(
    sql`SELECT key FROM ${sql.raw(quoteIdentifier(tableName))} WHERE land = ${land}`,
  )
  if (rows.length === 0) return []
  await db.delete(table).where(eq(table.land, land))
  return rows.map((row) => row.key)
}