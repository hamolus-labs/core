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
import type { PanelAssetKind, PanelAssetObject } from '@hamolus/types'
import type { Db } from '../db/client'
import { notFound } from '../errors'

export type PanelAssetRow = {
  id: string
  land: string
  panel_id: string
  kind: PanelAssetKind
  key: string
  name: string
  mime: string
  size: number
  ext: string
  created_at: string | null
  updated_at: string | null
}

export type PanelAssetList = {
  rows: PanelAssetRow[]
  total: number
}

let ready = false

export async function ensurePanelAssetTable(db: Db): Promise<void> {
  if (ready) return
  const boot = db.run(sql`
      CREATE TABLE IF NOT EXISTS _meta_panel_assets (
        id TEXT PRIMARY KEY,
        land TEXT NOT NULL,
        colony TEXT NOT NULL,
        panel_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        ext TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).then(async () => {
      const cols = await db.all<{ name: string }>(sql`PRAGMA table_info('_meta_panel_assets')`)
      if (!cols.some((c) => c.name === 'colony')) {
        await db.run(
          sql`ALTER TABLE _meta_panel_assets ADD COLUMN colony TEXT NOT NULL DEFAULT 'root_cny'`,
        )
      }
    })
  await boot
  ready = true
}

export async function listPanelAssets(
  db: Db,
  input: {
    land: string
    colony: string
    panelId: string
    kind: PanelAssetKind
    page: number
    pageSize: number
    search?: string
  },
): Promise<PanelAssetList> {
  await ensurePanelAssetTable(db)
  const where = [
    sql`land = ${input.land}`,
    sql`colony = ${input.colony}`,
    sql`panel_id = ${input.panelId}`,
    sql`kind = ${input.kind}`,
  ]
  if (input.search) {
    const term = `%${input.search.replace(/[\\%_]/g, '\\$&')}%`
    where.push(sql`(name LIKE ${term} ESCAPE '\\' OR mime LIKE ${term} ESCAPE '\\')`)
  }
  const filter = sql.join(where, sql` AND `)
  const offset = (input.page - 1) * input.pageSize
  const rows = await db.all<PanelAssetRow>(sql`
    SELECT id, land, colony, panel_id, kind, key, name, mime, size, ext, created_at, updated_at
    FROM _meta_panel_assets
    WHERE ${filter}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ${input.pageSize} OFFSET ${offset}
  `)
  const count = await db.get<{ total: number }>(sql`
    SELECT count(*) AS total FROM _meta_panel_assets WHERE ${filter}
  `)
  return { rows, total: count?.total ?? 0 }
}

export async function getPanelAsset(
  db: Db,
  input: { id: string; land: string; colony: string; panelId: string },
): Promise<PanelAssetRow | null> {
  await ensurePanelAssetTable(db)
  const row = await db.get<PanelAssetRow>(sql`
    SELECT id, land, colony, panel_id, kind, key, name, mime, size, ext, created_at, updated_at
    FROM _meta_panel_assets
    WHERE id = ${input.id} AND land = ${input.land} AND colony = ${input.colony}
      AND panel_id = ${input.panelId}
  `)
  return row ?? null
}

export async function getPanelAssetById(db: Db, id: string): Promise<PanelAssetRow | null> {
  await ensurePanelAssetTable(db)
  const row = await db.get<PanelAssetRow>(sql`
    SELECT id, land, colony, panel_id, kind, key, name, mime, size, ext, created_at, updated_at
    FROM _meta_panel_assets
    WHERE id = ${id}
  `)
  return row ?? null
}

export async function createPanelAsset(
  db: Db,
  input: {
    id: string
    land: string
    colony: string
    panelId: string
    kind: PanelAssetKind
    key: string
    name: string
    mime: string
    size: number
    ext: string
  },
): Promise<PanelAssetRow> {
  await ensurePanelAssetTable(db)
  await db.run(sql`
    INSERT INTO _meta_panel_assets
      (id, land, colony, panel_id, kind, key, name, mime, size, ext)
    VALUES (${input.id}, ${input.land}, ${input.colony}, ${input.panelId}, ${input.kind}, ${input.key}, ${input.name}, ${input.mime}, ${input.size}, ${input.ext})
  `)
  const row = await getPanelAsset(db, {
    id: input.id,
    land: input.land,
    colony: input.colony,
    panelId: input.panelId,
  })
  if (!row) throw notFound('Panel asset not found')
  return row
}

export async function deletePanelAsset(
  db: Db,
  input: { id: string; land: string; colony: string; panelId: string },
): Promise<PanelAssetRow> {
  await ensurePanelAssetTable(db)
  const row = await getPanelAsset(db, input)
  if (!row) throw notFound('Panel asset not found')
  await db.run(sql`
    DELETE FROM _meta_panel_assets
    WHERE id = ${input.id} AND land = ${input.land} AND colony = ${input.colony}
      AND panel_id = ${input.panelId}
  `)
  return row
}

export async function deletePanelAssetsForPanel(
  db: Db,
  input: { land: string; colony: string; panelId: string },
): Promise<PanelAssetRow[]> {
  await ensurePanelAssetTable(db)
  const rows = await db.all<PanelAssetRow>(
    sql`SELECT * FROM _meta_panel_assets
      WHERE land = ${input.land} AND colony = ${input.colony} AND panel_id = ${input.panelId}`,
  )
  if (rows.length > 0) {
    await db.run(sql`
      DELETE FROM _meta_panel_assets
      WHERE land = ${input.land} AND colony = ${input.colony} AND panel_id = ${input.panelId}
    `)
  }
  return rows
}

/** Drop every panel asset of one colony; the caller purges the returned R2 keys. */
export async function deletePanelAssetsForColony(
  db: Db,
  land: string,
  colony: string,
): Promise<PanelAssetRow[]> {
  await ensurePanelAssetTable(db)
  const rows = await db.all<PanelAssetRow>(
    sql`SELECT * FROM _meta_panel_assets WHERE land = ${land} AND colony = ${colony}`,
  )
  if (rows.length > 0) {
    await db.run(sql`DELETE FROM _meta_panel_assets WHERE land = ${land} AND colony = ${colony}`)
  }
  return rows
}

export async function deletePanelAssetsForLand(db: Db, land: string): Promise<PanelAssetRow[]> {
  await ensurePanelAssetTable(db)
  const rows = await db.all<PanelAssetRow>(sql`SELECT * FROM _meta_panel_assets WHERE land = ${land}`)
  if (rows.length > 0) {
    await db.run(sql`DELETE FROM _meta_panel_assets WHERE land = ${land}`)
  }
  return rows
}

export function extOf(name: string): string {
  return (name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? 'bin').toLowerCase()
}

export function panelAssetKey(input: { land: string; panelId: string; id: string; ext: string }): string {
  return `panels/${input.land}/${input.panelId}/${input.id}.${input.ext}`
}

const b64 = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes)
  let value = ''
  for (const byte of view) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const unb64 = (value: string): Uint8Array | null => {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const decoded = atob(padded)
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  return b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
}

export async function panelAssetUrl(input: {
  baseUrl: string
  secret: string
  row: PanelAssetRow
  ttlSeconds?: number
  download?: boolean
}): Promise<{ url: string; downloadUrl: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 900)
  const signature = await sign(input.secret, `${input.row.id}:${expiresAt}`)
  const make = (download: boolean): string => {
    const url = new URL(`/panel-assets/${encodeURIComponent(input.row.id)}`, input.baseUrl)
    url.searchParams.set('expires', String(expiresAt))
    url.searchParams.set('sig', signature)
    if (download) url.searchParams.set('download', '1')
    return url.toString()
  }
  return { url: make(false), downloadUrl: make(true), expiresAt }
}

export async function verifyPanelAssetSignature(input: {
  secret: string
  id: string
  expires: string | null
  signature: string | null
}): Promise<boolean> {
  if (!input.expires || !input.signature || !/^\d+$/.test(input.expires)) return false
  const expires = Number(input.expires)
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false
  const signature = unb64(input.signature)
  if (!signature) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`${input.id}:${expires}`))
}

export function panelAssetToObject(
  row: PanelAssetRow,
  urls: { url: string; downloadUrl: string; expiresAt: number },
): PanelAssetObject {
  return {
    id: row.id,
    panelId: row.panel_id,
    kind: row.kind,
    name: row.name,
    mime: row.mime,
    size: row.size,
    ext: row.ext,
    url: urls.url,
    downloadUrl: urls.downloadUrl,
    expiresAt: urls.expiresAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
