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
import type { AuthTokenPayload, MediaObject, MediaUpdate } from '@hamolus/types'
import {
  mediaUpdateSchema,
  mediaUploadMetaSchema,
  mediaVariantsMetaSchema,
  taxonomyActionSchema,
} from '@hamolus/types'
import { badRequest, notFound } from '../errors'
import { createDb } from '../db/client'
import { requireRead, requireWrite } from '../auth/session'
import { resolveRequestScope } from '../scope'
import {
  applyTaxonomyChange,
  createMedia,
  deleteMedia as storeDeleteMedia,
  getMedia,
  listMedia,
  mediaTaxonomy,
  mediaTaxonomyDetail,
  replaceMedia,
  updateMedia,
  type StoredVariant,
} from '../media/store'
import { imageSize } from '../media/size'

export const mediaRoutes = new Hono<{ Bindings: Env }>()

function baseUrl(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin
}

function formField(form: FormData, key: string): string | undefined {
  const v = form.get(key)
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** Turn a crop label ("2:1", "1:1 · 640") into an R2-key-safe slug. */
function sanitizeVariantLabel(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'v'
}

/** Parse the optional metadata fields from an upload/replace multipart body. */
function parseUploadMeta(form: FormData): {
  name?: string
  title?: string | null
  alt?: string | null
  description?: string | null
  caption?: string | null
  group?: string | null
  category?: string | null
  tags?: string[] | null
  focusX?: number | null
  focusY?: number | null
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
  const focusX = form.get('focusX')
  const focusY = form.get('focusY')
  const parsed = mediaUploadMetaSchema.safeParse({
    name,
    title: formField(form, 'title'),
    alt: formField(form, 'alt'),
    description: formField(form, 'description'),
    caption: formField(form, 'caption'),
    group: formField(form, 'group'),
    category: formField(form, 'category'),
    tags,
    focusX: focusX !== null && focusX !== '' ? Number(focusX) : undefined,
    focusY: focusY !== null && focusY !== '' ? Number(focusY) : undefined,
  })
  if (!parsed.success) {
    throw badRequest(
      'Invalid upload metadata: ' + parsed.error.issues.map((i) => i.message).join('; '),
      'INVALID_MEDIA',
    )
  }
  const m = parsed.data
  return {
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.title !== undefined ? { title: m.title ?? null } : {}),
    ...(m.alt !== undefined ? { alt: m.alt ?? null } : {}),
    ...(m.description !== undefined ? { description: m.description ?? null } : {}),
    ...(m.caption !== undefined ? { caption: m.caption ?? null } : {}),
    ...(m.group !== undefined ? { group: m.group ?? null } : {}),
    ...(m.category !== undefined ? { category: m.category ?? null } : {}),
    ...(m.tags !== undefined ? { tags: m.tags ?? null } : {}),
    ...(m.focusX !== undefined && m.focusX !== null ? { focusX: m.focusX } : {}),
    ...(m.focusY !== undefined && m.focusY !== null ? { focusY: m.focusY } : {}),
  }
}

/** List media assets (paginated; `search` + taxonomy filters). */
mediaRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'media.read')
  const scope = await resolveRequestScope(c, db)
  const page = Number(c.req.query('page') ?? 1)
  const pageSize = Number(c.req.query('pageSize') ?? 20)
  const result = await listMedia(db, baseUrl(c), {
    page,
    pageSize,
    search: c.req.query('search') ?? undefined,
    group: c.req.query('group') || undefined,
    category: c.req.query('category') || undefined,
    tag: c.req.query('tag') || undefined,
  }, scope.land, scope.colony)
  return c.json(result)
})

/** Distinct group / category / tag values (for console filters + suggestions). */
mediaRoutes.get('/taxonomy', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'media.read')
  const scope = await resolveRequestScope(c, db)
  const taxonomy = await mediaTaxonomy(db, scope.land, scope.colony)
  return c.json({ data: taxonomy })
})

/** Taxonomy values with per-value usage counts (for the console management panel). */
mediaRoutes.get('/taxonomy/detail', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'media.read')
  const scope = await resolveRequestScope(c, db)
  const detail = await mediaTaxonomyDetail(db, scope.land, scope.colony)
  return c.json({ data: detail })
})

/** Rename or remove a taxonomy value across every asset (`to` omitted = remove). */
mediaRoutes.post('/taxonomy', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'media.write')
  const scope = await resolveRequestScope(c, db)
  const body = (await c.req.json().catch(() => null)) as unknown
  const parsed = taxonomyActionSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest(
      'Invalid taxonomy action: ' + parsed.error.issues.map((i) => i.message).join('; '),
      'INVALID_MEDIA',
    )
  }
  const detail = await applyTaxonomyChange(db, {
    type: parsed.data.type,
    from: parsed.data.from,
    to: parsed.data.to,
  }, scope.land, scope.colony)
  return c.json({ data: detail })
})

mediaRoutes.get('/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'media.read')
  const scope = await resolveRequestScope(c, db)
  const media = await getMedia(db, c.req.param('id'), baseUrl(c), scope.land, scope.colony)
  return c.json({ data: media })
})

/** Upload an image file (multipart `file` field) into R2 + metadata row. */
mediaRoutes.post('/', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'media.write')
  const form = await c.req.formData().catch(() => null)
  if (!form) throw badRequest('Expected multipart form data')
  const file = form.get('file')
  if (!(file instanceof File)) throw badRequest('Missing `file` field')
  if (!file.type.startsWith('image/')) throw badRequest('Only image files are allowed', 'UNSUPPORTED_MEDIA')
  if (file.size <= 0) throw badRequest('Empty file')

  const id = crypto.randomUUID()
  const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? 'bin').toLowerCase()
  const key = `${id}.${ext}`
  const bytes = await file.arrayBuffer()
  const dims = imageSize(new Uint8Array(bytes))
  const meta = parseUploadMeta(form)
  const scope = await resolveRequestScope(c, db)

  // Optional companion thumbnail (small WebP, generated client-side for lazy loading).
  let thumbKey: string | null = null
  const thumbFile = form.get('thumb')
  if (thumbFile instanceof File && thumbFile.size > 0) {
    if (!thumbFile.type.startsWith('image/')) {
      throw badRequest('Thumbnail must be an image', 'UNSUPPORTED_MEDIA')
    }
    const thumbBytes = await thumbFile.arrayBuffer()
    const thumbExt = (thumbFile.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? 'bin').toLowerCase()
    thumbKey = `${id}.thumb.${thumbExt}`
    await c.env.MEDIA.put(thumbKey, thumbBytes, {
      httpMetadata: {
        contentType: thumbFile.type,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })
  }

  // Optional crop variants: repeated `variant` file parts + one `variantMeta` JSON
  // array (`[{label, focusX, focusY}]`) paired index-wise, each its own R2 object.
  const variants: StoredVariant[] = []
  const variantFiles = form
    .getAll('variant')
    .filter((x): x is File => x instanceof File && x.size > 0)
  if (variantFiles.length > 0) {
    const rawMeta = form.get('variantMeta')
    if (typeof rawMeta !== 'string') {
      throw badRequest('Variant files require a `variantMeta` JSON field', 'INVALID_MEDIA')
    }
    let metaList: Array<{ label: string; focusX: number; focusY: number }> = []
    try {
      const parsed = mediaVariantsMetaSchema.safeParse(JSON.parse(rawMeta))
      if (!parsed.success) throw new Error('invalid metadata')
      metaList = parsed.data
    } catch {
      throw badRequest('Invalid variant metadata', 'INVALID_MEDIA')
    }
    if (metaList.length !== variantFiles.length) {
      throw badRequest('variantMeta must match the number of variant files', 'INVALID_MEDIA')
    }
    const seen = new Set<string>()
    for (let i = 0; i < variantFiles.length; i++) {
      const vf = variantFiles[i]
      if (!vf.type.startsWith('image/')) {
        throw badRequest('Variant files must be images', 'UNSUPPORTED_MEDIA')
      }
      const vmeta = metaList[i]
      const label = sanitizeVariantLabel(vmeta.label)
      if (seen.has(label)) throw badRequest(`Duplicate variant label: ${vmeta.label}`, 'INVALID_MEDIA')
      seen.add(label)
      const vext = (vf.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? 'bin').toLowerCase()
      const vkey = `${id}.${label}.${vext}`
      const vbytes = await vf.arrayBuffer()
      const vdims = imageSize(new Uint8Array(vbytes))
      await c.env.MEDIA.put(vkey, vbytes, {
        httpMetadata: {
          contentType: vf.type,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      })
      variants.push({
        label: vmeta.label,
        key: vkey,
        width: vdims?.width ?? null,
        height: vdims?.height ?? null,
        focusX: vmeta.focusX,
        focusY: vmeta.focusY,
      })
    }
  }

  await c.env.MEDIA.put(key, bytes, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  try {
    await createMedia(db, {
      id,
      key,
      name: meta.name ?? file.name,
      mime: file.type,
      size: bytes.byteLength,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      title: meta.title ?? null,
      alt: meta.alt ?? null,
      description: meta.description ?? null,
      caption: meta.caption ?? null,
      group: meta.group ?? null,
      category: meta.category ?? null,
      tags: meta.tags ?? null,
      focusX: meta.focusX ?? null,
      focusY: meta.focusY ?? null,
      thumbKey,
      variants,
    }, scope.land, scope.colony)
  } catch (err) {
    // Rollback R2 objects if the metadata insert failed.
    await c.env.MEDIA.delete(key)
    if (thumbKey) await c.env.MEDIA.delete(thumbKey)
    for (const v of variants) await c.env.MEDIA.delete(v.key)
    throw err
  }

  const media = await getMedia(db, id, baseUrl(c), scope.land, scope.colony)
  return c.json({ data: media }, 201)
})

/** Edit asset metadata: rename + SEO fields (name, title, alt, description). */
mediaRoutes.patch('/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'media.write')
  const body = await c.req.json().catch(() => null)
  const parsed = mediaUpdateSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest(
      'Invalid media update: ' + parsed.error.issues.map((i) => i.message).join('; '),
      'INVALID_MEDIA',
    )
  }
  const patch: MediaUpdate = { ...parsed.data }
  // Allow clearing fields by sending "" (normalize to null).
  if (patch.title === '') patch.title = null
  if (patch.alt === '') patch.alt = null
  if (patch.description === '') patch.description = null
  if (patch.caption === '') patch.caption = null
  if (patch.group === '') patch.group = null
  if (patch.category === '') patch.category = null
  if (patch.tags?.length === 0) patch.tags = null
  const scope = await resolveRequestScope(c, db)
  const media = await updateMedia(db, c.req.param('id'), patch, baseUrl(c), scope.land, scope.colony)
  return c.json({ data: media })
})

/** Replace the bytes under an existing asset (multipart `file`); same URL stays valid. */
mediaRoutes.put('/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'media.write')
  const id = c.req.param('id')
  const scope = await resolveRequestScope(c, db)
  const existing = await getMedia(db, id, baseUrl(c), scope.land, scope.colony)

  const form = await c.req.formData().catch(() => null)
  if (!form) throw badRequest('Expected multipart form data')
  const file = form.get('file')
  if (!(file instanceof File)) throw badRequest('Missing `file` field')
  if (!file.type.startsWith('image/')) throw badRequest('Only image files are allowed', 'UNSUPPORTED_MEDIA')
  if (file.size <= 0) throw badRequest('Empty file')

  const bytes = await file.arrayBuffer()
  const dims = imageSize(new Uint8Array(bytes))

  // Optional companion thumbnail: store fresh bytes and refresh the row's thumb key.
  let thumbKey: string | null = null
  const thumbFile = form.get('thumb')
  if (thumbFile instanceof File && thumbFile.size > 0) {
    if (!thumbFile.type.startsWith('image/')) {
      throw badRequest('Thumbnail must be an image', 'UNSUPPORTED_MEDIA')
    }
    const thumbBytes = await thumbFile.arrayBuffer()
    const thumbExt = (thumbFile.name.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? 'bin').toLowerCase()
    thumbKey = `${id}.thumb.${thumbExt}`
    await c.env.MEDIA.put(thumbKey, thumbBytes, {
      httpMetadata: {
        contentType: thumbFile.type,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })
    // Drop the previous thumbnail object if the new one uses a different key.
    if (existing.thumbKey && existing.thumbKey !== thumbKey) {
      await c.env.MEDIA.delete(existing.thumbKey)
    }
  }

  await c.env.MEDIA.put(existing.key, bytes, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  const media = await replaceMedia(db, id, {
    mime: file.type,
    size: bytes.byteLength,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    thumbKey: thumbFile instanceof File && thumbFile.size > 0 ? thumbKey : undefined,
  }, baseUrl(c), scope.land, scope.colony)
  return c.json({ data: media })
})

/** Delete a media asset (R2 objects: default + thumbnail + variants + metadata row). */
mediaRoutes.delete('/:id', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'media.write')
  const scope = await resolveRequestScope(c, db)
  const { key, thumbKey, variantKeys } = await storeDeleteMedia(
    db,
    c.req.param('id'),
    scope.land,
    scope.colony,
  )
  await c.env.MEDIA.delete(key)
  if (thumbKey) await c.env.MEDIA.delete(thumbKey)
  for (const v of variantKeys) await c.env.MEDIA.delete(v)
  return c.body(null, 204)
})