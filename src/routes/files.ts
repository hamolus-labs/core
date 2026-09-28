/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import type { AuthTokenPayload, FileKind, FilePatch } from '@hamolus/types'
import { DOCUMENT_MIMES, filePatchSchema } from '@hamolus/types'
import { badRequest } from '../errors'
import { createDb } from '../db/client'
import { requireRead, requireWrite } from '../auth/session'
import { resolveRequestScope } from '../scope'
import {
  createFile,
  deleteFile as storeDeleteFile,
  fileTaxonomy,
  getFile,
  listFiles,
  updateFile,
} from '../files/store'

function baseUrl(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin
}

function formField(form: FormData, key: string): string | undefined {
  const v = form.get(key)
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** Parse the optional metadata/taxonomy fields from an upload multipart body. */
function parseUploadMeta(form: FormData): {
  name?: string
  title?: string | null
  description?: string | null
  group?: string | null
  category?: string | null
  tags?: string[] | null
} {
  const name = formField(form, 'name')
  const rawTags = formField(form, 'tags')
  let tags: string[] | undefined
  if (rawTags !== undefined) {
    try {
      const parsed = JSON.parse(rawTags) as unknown
      if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === 'string')) {
        throw new Error('tags must be a JSON array of strings')
      }
      tags = parsed as string[]
    } catch {
      tags = rawTags.split(',').map((t) => t.trim()).filter(Boolean)
    }
  }
  const parsed = filePatchSchema.safeParse({
    name,
    title: formField(form, 'title'),
    description: formField(form, 'description'),
    group: formField(form, 'group'),
    category: formField(form, 'category'),
    tags,
  })
  if (!parsed.success) {
    throw badRequest(
      'Invalid upload metadata: ' + parsed.error.issues.map((i) => i.message).join('; '),
      'INVALID_FILE',
    )
  }
  const m = parsed.data
  return {
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.title !== undefined ? { title: m.title ?? null } : {}),
    ...(m.description !== undefined ? { description: m.description ?? null } : {}),
    ...(m.group !== undefined ? { group: m.group ?? null } : {}),
    ...(m.category !== undefined ? { category: m.category ?? null } : {}),
    ...(m.tags !== undefined ? { tags: m.tags ?? null } : {}),
  }
}

/** Build the `/api/_documents` / `/api/_attachments` route tree for a file kind. */
function fileRoutes(kind: FileKind) {
  const routes = new Hono<{ Bindings: Env }>()
  const folder = kind === 'document' ? 'doc' : 'att'
  const noun = kind === 'document' ? 'Document' : 'Attachment'

  routes.get('/', async (c) => {
    const db = createDb(c.env.DB)
    const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
    requireRead(payload, 'media.read')
    const scope = await resolveRequestScope(c)
    const { land, colony } = scope
    const result = await listFiles(db, baseUrl(c), kind, {
      page: Number(c.req.query('page') ?? 1),
      pageSize: Number(c.req.query('pageSize') ?? 20),
      search: c.req.query('search') ?? undefined,
      group: c.req.query('group') || undefined,
      category: c.req.query('category') || undefined,
      tag: c.req.query('tag') || undefined,
    }, land, colony)
    return c.json(result)
  })

  routes.get('/taxonomy', async (c) => {
    const db = createDb(c.env.DB)
    const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
    requireRead(payload, 'media.read')
    const scope = await resolveRequestScope(c)
    return c.json({ data: await fileTaxonomy(db, kind, scope.land, scope.colony) })
  })

  routes.get('/:id', async (c) => {
    const db = createDb(c.env.DB)
    const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
    requireRead(payload, 'media.read')
    const scope = await resolveRequestScope(c)
    const { land, colony } = scope
    return c.json({ data: await getFile(db, kind, c.req.param('id'), baseUrl(c), land, colony) })
  })

  routes.post('/', async (c) => {
    const db = createDb(c.env.DB)
    const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
    requireWrite(payload, 'media.write')
    const form = await c.req.formData().catch(() => null)
    if (!form) throw badRequest('Expected multipart form data')
    const file = form.get('file')
    if (!(file instanceof File)) throw badRequest('Missing `file` field')
    if (file.size <= 0) throw badRequest('Empty file')
    if (kind === 'document' && !(DOCUMENT_MIMES as readonly string[]).includes(file.type)) {
      throw badRequest('Only document files are allowed', 'UNSUPPORTED_MEDIA')
    }

    const id = crypto.randomUUID()
    const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? 'bin').toLowerCase()
    const key = `${folder}/${id}.${ext}`
    const bytes = await file.arrayBuffer()
    const meta = parseUploadMeta(form)
    const scope = await resolveRequestScope(c)
    const { land, colony } = scope

    await c.env.MEDIA.put(key, bytes, {
      httpMetadata: {
        contentType: file.type,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })

    try {
      await createFile(db, kind, {
        id,
        key,
        name: meta.name ?? file.name,
        mime: file.type,
        size: bytes.byteLength,
        ext,
        title: meta.title ?? null,
        description: meta.description ?? null,
        group: meta.group ?? null,
        category: meta.category ?? null,
        tags: meta.tags ?? null,
      }, land, colony)
    } catch (err) {
      // Rollback the R2 object if the metadata insert failed.
      await c.env.MEDIA.delete(key)
      throw err
    }

    return c.json({ data: await getFile(db, kind, id, baseUrl(c), land, colony) }, 201)
  })

  routes.patch('/:id', async (c) => {
    const db = createDb(c.env.DB)
    const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
    requireWrite(payload, 'media.write')
    const body = await c.req.json().catch(() => null)
    const parsed = filePatchSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest(
        'Invalid file update: ' + parsed.error.issues.map((i) => i.message).join('; '),
        'INVALID_FILE',
      )
    }
    const patch: FilePatch = { ...parsed.data }
    // Allow clearing fields by sending "" (normalize to null).
    if (patch.title === '') patch.title = null
    if (patch.description === '') patch.description = null
    if (patch.group === '') patch.group = null
    if (patch.category === '') patch.category = null
    if (patch.tags?.length === 0) patch.tags = null
    const scope = await resolveRequestScope(c)
    const { land, colony } = scope
    return c.json({
      data: await updateFile(db, kind, c.req.param('id'), patch, baseUrl(c), land, colony),
    })
  })

  routes.delete('/:id', async (c) => {
    const db = createDb(c.env.DB)
    const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
    requireWrite(payload, 'media.write')
    const scope = await resolveRequestScope(c)
    const { land, colony } = scope
    const { key } = await storeDeleteFile(db, kind, c.req.param('id'), land, colony)
    await c.env.MEDIA.delete(key)
    return c.body(null, 204)
  })

  return routes
}

export const documentRoutes = fileRoutes('document')
export const attachmentRoutes = fileRoutes('attachment')