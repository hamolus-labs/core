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
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Collection definition metadata (managed by Drizzle + auto-bootstrap). */
export const metaCollections = sqliteTable(
  '_meta_collections',
  {
    land: text('land').notNull().default('root_lnd'),
    colony: text('colony').notNull().default('root_cny'),
    name: text('name').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    group: text('group'),
    icon: text('icon'),
    timestamps: integer('timestamps', { mode: 'boolean' }).notNull().default(false),
    softDelete: integer('soft_delete', { mode: 'boolean' }).notNull().default(false),
    primaryKey: text('primary_key').notNull().default('id'),
    /** MCP exposure: 'read' (default), 'write' or 'hide'; null means read. */
    mcp: text('mcp'),
    /** JSON string of FieldDefinition[] */
    fields: text('fields').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [primaryKey({ columns: [t.land, t.colony, t.name] })],
)

export type MetaCollectionRow = typeof metaCollections.$inferSelect

/** Registered navigation groups with self-parenting (nesting). */
export const metaGroups = sqliteTable(
  '_meta_groups',
  {
    land: text('land').notNull().default('root_lnd'),
    colony: text('colony').notNull().default('root_cny'),
    id: text('id').notNull(),
    label: text('label').notNull(),
    /** References another _meta_groups.id (nesting). */
    parent: text('parent'),
    icon: text('icon'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [primaryKey({ columns: [t.land, t.colony, t.id] })],
)

export type MetaGroupRow = typeof metaGroups.$inferSelect

export const metaPanels = sqliteTable(
  '_meta_panels',
  {
    land: text('land').notNull().default('root_lnd'),
    colony: text('colony').notNull().default('root_cny'),
    id: text('id').notNull(),
    definition: text('definition').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [primaryKey({ columns: [t.land, t.colony, t.id] })],
)

export type MetaPanelRow = typeof metaPanels.$inferSelect

/** Top-level land registry (mirror of the raw _meta_lands table). */
export const metaLands = sqliteTable('_meta_lands', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  description: text('description'),
  /** User id of the land_admin who owns this land. */
  ownerUserId: text('owner_user_id'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
})

export type MetaLandRow = typeof metaLands.$inferSelect

/** Colony registry (labels for a land's sub-units; mirrors _meta_colonies). */
export const metaColonies = sqliteTable('_meta_colonies', {
  id: text('id').primaryKey(),
  landId: text('land_id').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  /** User id of the land_admin who owns this colony. */
  ownerUserId: text('owner_user_id'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
})

export type MetaColonyRow = typeof metaColonies.$inferSelect

/** Media asset metadata (bytes live in R2; this mirrors each object for listing). */
export const metaMedia = sqliteTable('_meta_media', {
  id: text('id').primaryKey(),
  /** Scope the asset belongs to (rows are filtered by land+colony; keys stay global UUIDs). */
  land: text('land').notNull().default('root_lnd'),
  colony: text('colony').notNull().default('root_cny'),
  /** R2 object key (matches the stored object) */
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  title: text('title'),
  alt: text('alt'),
  description: text('description'),
  group: text('group'),
  category: text('category'),
  /** JSON array of freeform tag labels */
  tags: text('tags'),
  /** Focus point, percent (0–100); null = center. */
  focusX: real('focus_x'),
  focusY: real('focus_y'),
  /** R2 key of the auto-generated thumbnail (small WebP for lazy loading). */
  thumbKey: text('thumb_key'),
  /** Short caption/attribution surfaced in the SEO viewer. */
  caption: text('caption'),
  /** JSON array of crop variants (each keyed `<id>.<label>.<ext>`). */
  variants: text('variants'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
})

export type MetaMediaRow = typeof metaMedia.$inferSelect

/** Shared shape of document / attachment file-library rows. */
export type MetaFileRow = {
  id: string
  land: string
  colony: string
  key: string
  name: string
  mime: string
  size: number
  ext: string
  title: string | null
  description: string | null
  group: string | null
  category: string | null
  tags: string | null
  createdAt: string
  updatedAt: string
}

function metaFileColumns(tableName: string) {
  return sqliteTable(tableName, {
    id: text('id').primaryKey(),
    land: text('land').notNull().default('root_lnd'),
    colony: text('colony').notNull().default('root_cny'),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    ext: text('ext').notNull(),
    title: text('title'),
    description: text('description'),
    group: text('group'),
    category: text('category'),
    tags: text('tags'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  })
}

/** Document library metadata (bytes in R2 under the `doc/` key prefix). */
export const metaDocuments = metaFileColumns('_meta_documents')

/** Attachment library metadata (bytes in R2 under the `att/` key prefix). */
export const metaAttachments = metaFileColumns('_meta_attachments')