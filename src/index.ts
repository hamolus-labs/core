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
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { jwt } from 'hono/jwt'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AuthTokenPayload } from '@hamolus/types'
import type { Env } from './env'
import { publicGetsEnabled } from './env'
import { createDb } from './db/client'
import { HttpError } from './errors'
import { ensurePrivileges } from './auth/privileges'
import { ensureCodeDefinitions, type CodeDefinitions } from './definitions'
import { createScopeRewrite, resolveRequestScope } from './scope'
import type { ScopeContext } from './scope'
import { authRoutes } from './routes/auth'
import { seedRoutes } from './routes/seed'
import { configRoutes } from './routes/config'
import { mcpRoutes } from './routes/mcp'
import { mcpMachineRoutes } from './routes/mcp-machine'
import { pluginRoutes } from './routes/plugins'
import { panelRoutes } from './routes/panels'
import { dynamicRoutes } from './routes/dynamic'
import { metaRoutes } from './routes/meta'
import { colonyRoutes, landRoutes } from './routes/lands'
import { mediaRoutes } from './routes/media'
import { attachmentRoutes, documentRoutes } from './routes/files'
import { getMediaRowByKey } from './media/store'
import { rowToMedia } from './media/store'
import type { MediaObject } from '@hamolus/types'
import type { FileObject } from '@hamolus/types'
import type { CoreConfig } from '@hamolus/types'
import { getFileRowByBasename } from './files/store'
import { rowToFile } from './files/store'
import { getPanelAssetById, verifyPanelAssetSignature } from './media/panel-assets'
import { ensureLandsRegistry } from './meta/lands'

// Re-exported so a project's own Worker entry can declare its build-time config
// (`import app, { setCoreConfig } from '@hamolus/core'`) without reaching into the
// package's internals. The default export below stays the Worker entry.
export { setCoreConfig, getCoreConfig } from './config'
export type { CoreConfig }
export { getCodeDefinitions, setCodeDefinitions } from './definitions'
export type { CodeDefinitions }
const AUTH_SKIP = new Set(['/api/_auth/token', '/api/_auth/login', '/api/_auth/setup', '/api/_auth/super', '/api/health'])

type AppEnv = {
  Bindings: Env
  Variables: {
    scope: ScopeContext
    land: string
    colony: string
    jwtPayload?: AuthTokenPayload
  }
}

const app = new Hono<AppEnv>()

app.use('/api/*', cors())

// Worker-facing MCP routes, mounted here on purpose: above the scope rewrite and
// above the JWT middleware, so an instance id is the only credential involved.
//
// They are NOT in AUTH_SKIP. That set's skipped branch still runs
// `applyScope` → `resolveRequestScope`, which rejects a request carrying no
// `x-land`/`x-colony` on a `centralized` core — and a worker holding only an
// instance id cannot know its own scope, which is what it is asking for here.
//
// Registration order is load-bearing in Hono: a handler registered before
// `app.use('/api/*', jwt)` runs without it. If these ever move down, the
// instance id silently starts being checked against a session JWT and every
// worker 401s. The `check:mcp-instance-acl` gate covers the behaviour; this
// comment covers the reason it is written this way.
app.route('/api/_mcp', mcpMachineRoutes)

// Pre-auth scope path rewrite: `/api/{land}[/{colony}]/…` is stripped into the
// `/api/…` scope with `x-land`/`x-colony` headers and re-dispatched (guarded
// by `x-scope-rewritten`). No-op when the first segment isn't a registered land.
app.use(
  '/api/*',
  createScopeRewrite((req, bindings, executionCtx) => app.fetch(req, bindings, executionCtx)),
)

// Semua route /api/* diproteksi JWT, kecuali login token & (opsional) GET publik.
app.use('/api/*', async (c, next) => {
  // The privileges collection is always bootstrapped so setup/login can resolve roles.
  const db = createDb(c.env.DB)
  await ensurePrivileges(db)
  const isPublicGet = c.req.method === 'GET' && publicGetsEnabled(c.env)
  const skipAuth = AUTH_SKIP.has(c.req.path) || (isPublicGet && !c.req.header('Authorization')?.startsWith('Bearer '))
  if (skipAuth) {
    await applyScope(c, db)
    return next()
  }
  // On a successful JWT the scope is re-resolved so the token's `land`/`colony`
  // claims are honoured and a header/claim mismatch raises SCOPE_MISMATCH.
  return jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' })(c, async () => {
    await applyScope(c, db)
    return next()
  })
})

async function applyScope(c: Context<AppEnv>, db: ReturnType<typeof createDb>): Promise<void> {
  const scope = await resolveRequestScope(c, db)
  c.set('scope', scope)
  c.set('land', scope.land)
  c.set('colony', scope.colony)
  await bootstrapScope(db, scope.land, scope.colony, c.env.SETTINGS)
}

/**
 * A colony bootstraps its own `privileges` collection (roles + permissions) the
 * first time it is used, otherwise `GET /api/privileges` 404s for that scope and no
 * user or role can be created in it. Gated on a registered scope so a request
 * carrying an unknown `x-land`/`x-colony` header cannot mint privileges for a
 * scope that does not exist.
 *
 * Code-defined collections and panels are applied in the same pass, so every
 * registered scope starts from the baseline checked into the repository rather
 * than only the default one.
 */
async function bootstrapScope(
  db: ReturnType<typeof createDb>,
  land: string,
  colony: string,
  kv: KVNamespace,
): Promise<void> {
  const registry = await ensureLandsRegistry(db, kv)
  if (!registry.lands.has(land)) return
  if (!registry.colonies.get(land)?.has(colony)) return
  if (registry.ownerOf.get(colony) !== land) return
  await ensurePrivileges(db, land, colony)
  await ensureCodeDefinitions(db, land, colony)
}

app.get('/', (c) => c.json({ ok: true, service: 'core' }))
app.get('/api/health', (c) => c.json({ ok: true, service: 'core' }))

// Public media file serving (outside /api, no JWT; used by console + site <img>).
// Direct image requests (<img>, fetch) get the raw bytes; a browser navigation
// (Accept: text/html) gets an HTML metadata viewer page for this asset.

const MEDIA_KEY_RE = /^[a-zA-Z0-9._-]+$/

function mediaKey(c: { req: { param: (k: string) => string } }): string {
  const key = c.req.param('key')
  if (!MEDIA_KEY_RE.test(key)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid media key')
  return key
}

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function mediaViewerHtml(m: MediaObject, baseUrl: string, requestedKey: string): string {
  const tags = Array.isArray(m.tags) && m.tags.length > 0 ? m.tags.map(escHtml).join(', ') : '—'
  const dims = m.width && m.height ? `${m.width} × ${m.height} px` : '—'
  const sizeKb = m.size < 1024 ? `${m.size} B` : `${(m.size / 1024).toFixed(1)} KB`
  const focus = m.focusX !== null && m.focusY !== null ? `${Math.round(m.focusX)}%, ${Math.round(m.focusY)}%` : 'Center'
  const label = m.title || m.name
  const isThumb = m.key !== requestedKey && m.thumbKey === requestedKey
  const variant = m.variants.find((v) => v.key === requestedKey)
  const display = variant?.url ?? (isThumb ? m.url : (m.thumbUrl || m.url))

  const rows: Array<[string, string]> = [
    ['Name', m.name],
    ['MIME', m.mime],
    ['Dimensions', dims],
    ['Size', sizeKb],
  ]
  if (m.title) rows.push(['Title', m.title])
  if (m.alt) rows.push(['Alt text', m.alt])
  if (m.description) rows.push(['Description', m.description])
  if (m.caption) rows.push(['Caption', m.caption])
  if (m.group) rows.push(['Group', m.group])
  if (m.category) rows.push(['Category', m.category])
  rows.push(['Tags', tags])
  rows.push(['Focus point', focus])
  rows.push(['Created', m.createdAt])
  rows.push(['Updated', m.updatedAt])

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<div class="row"><div class="k">${escHtml(k)}</div><div class="v">${escHtml(v)}</div></div>`,
    )
    .join('')

  const variantsHtml =
    m.variants.length > 0
      ? `<div class="variants"><div class="vh">Variants</div>${m.variants
          .map(
            (v) =>
              `<a class="vchip${variant?.key === v.key ? ' active' : ''}" href="${escHtml(v.url)}" ` +
              `title="${escHtml(v.label)}">${escHtml(v.label)} <span class="vd">${v.width && v.height ? `${v.width}×${v.height}` : ''} · f ${Math.round(v.focusX)}% ${Math.round(v.focusY)}%</span></a>`,
          )
          .join('')}</div>`
      : ''

  const badge =
    isThumb
      ? '<span class="badge thumbs">Thumbnail (WebP)</span>'
      : variant
        ? `<span class="badge variant">Variant · ${escHtml(variant.label)}</span>`
        : '<span class="badge">Media</span>'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta property="og:type" content="image"/>
<meta property="og:title" content="${escHtml(label)}"/>
<meta property="og:description" content="${escHtml(m.caption || m.description || m.alt || '')}"/>
<meta property="og:image" content="${escHtml(m.url)}"/>
<title>${escHtml(label)} — ${escHtml(m.name)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 32px 16px;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #11141d;
    color: #e6eaf3;
  }
  .card {
    width: 100%;
    max-width: 720px;
    background: #1a1f2c;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0,0,0,0.45);
  }
  .stage { background: #0d0f16; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .stage img { max-width: 100%; max-height: 46vh; object-fit: contain; border-radius: 6px; display: block; }
  .badge {
    display: inline-block;
    margin: 18px 18px 0;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #ffffff;
    background: #4c6fff;
    border-radius: 999px;
  }
  .badge.thumbs { background: #2a6f4f; }
  .badge.variant { background: #7a4cff; }
  .head { padding: 14px 18px 8px; }
  .head h1 { margin: 0; font-size: 20px; font-weight: 700; line-height: 1.25; }
  .head .sub { color: #9aa3b5; font-size: 13px; margin-top: 4px; }
  .caption { padding: 2px 18px 6px; color: #b9c1d2; font-size: 13.5px; }
  .meta { padding: 8px 18px 18px; }
  .row { display: flex; gap: 16px; padding: 9px 0; border-top: 1px solid rgba(255,255,255,0.06); }
  .row .k { flex: 0 0 128px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #8b95a9; }
  .row .v { flex: 1; font-size: 13.5px; word-break: break-word; }
  .variants { padding: 0 18px 14px; }
  .variants .vh { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #8b95a9; margin-bottom: 8px; }
  .variants .vchip {
    display: inline-flex; align-items: baseline; gap: 8px;
    margin: 0 8px 8px 0; padding: 7px 11px;
    font-size: 12.5px; font-weight: 600; text-decoration: none; color: #cfd6e4;
    background: #262c3d; border-radius: 8px; transition: background-color .15s ease;
  }
  .variants .vchip:hover { background: #333b51; color: #fff; }
  .variants .vchip.active { background: #4c6fff; color: #fff; }
  .variants .vchip .vd { font-weight: 500; color: #8b95a9; font-size: 11px; }
  .variants .vchip.active .vd { color: #dcd7ff; }
  .links { display: flex; gap: 10px; padding: 14px 18px 18px; flex-wrap: wrap; }
  .links a {
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    color: #cfd6e4;
    background: #262c3d;
    border-radius: 8px;
    transition: background-color .15s ease;
  }
  .links a:hover { background: #333b51; color: #fff; }
</style>
</head>
<body>
  <div class="card">
    <div class="stage"><img src="${escHtml(display)}" alt="${escHtml(m.alt ?? '')}"/></div>
    ${badge}
    <div class="head">
      <h1>${escHtml(label)}</h1>
      <div class="sub">${escHtml(m.name)} · served by the worker core${variant ? ` · ${escHtml(variant.label)}` : ''}</div>
    </div>
    ${m.caption ? `<div class="caption">${escHtml(m.caption)}</div>` : ''}
    <div class="meta">${rowsHtml}</div>
    ${variantsHtml}
    <div class="links">
      <a href="${escHtml(m.url)}" target="_blank" rel="noopener">Open original file</a>
      <a href="${escHtml(baseUrl)}/media/${escHtml(m.key)}/meta" target="_blank" rel="noopener">JSON metadata</a>
      <a href="${escHtml(baseUrl)}">Core home</a>
    </div>
  </div>
</body>
</html>`
}

app.get('/media/:key/meta', async (c) => {
  const key = mediaKey(c)
  const db = createDb(c.env.DB)
  const row = await getMediaRowByKey(db, key)
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Media not found')
  const baseUrl = new URL(c.req.url).origin
  return c.json({ data: rowToMedia(row, baseUrl) })
})

app.get('/media/:key', async (c) => {
  const key = mediaKey(c)
  const obj = await c.env.MEDIA.get(key)
  if (!obj) throw new HttpError(404, 'NOT_FOUND', 'Media not found')

  // <img> / fetch / media fetchers request image/* — send the raw bytes.
  const accept = c.req.header('Accept') ?? '*/*'
  if (accept.includes('image/')) {
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('etag', obj.httpEtag)
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    if (obj.body) return new Response(obj.body, { headers })
    return c.body(null, 204)
  }

  // Browser navigation → HTML metadata viewer.
  const db = createDb(c.env.DB)
  const row = await getMediaRowByKey(db, key)
  const baseUrl = new URL(c.req.url).origin
  if (!row) {
    // Metadata row missing (legacy object) — serve the bytes anyway.
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('etag', obj.httpEtag)
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    if (obj.body) return new Response(obj.body, { headers })
    return c.body(null, 204)
  }
  const m = rowToMedia(row, baseUrl)
  return c.html(mediaViewerHtml(m, baseUrl, key))
})

// Public file serving (documents + attachments live in the MEDIA R2 bucket under
// a `doc/` / `att/` key prefix; the public URL uses just the basename).

const FILE_KEY_RE = /^[a-zA-Z0-9._-]+$/

/** File name safe for a Content-Disposition header value. */
function safeFilename(name: string): string {
  const clean = name
    .replace(/[\\/\r\n]/g, '_')
    .replace(/"/g, "'")
    .replace(/\u0000/g, '')
  return clean.trim() || 'file'
}

function fileViewerHtml(f: FileObject, baseUrl: string): string {
  const tags = Array.isArray(f.tags) && f.tags.length > 0 ? f.tags.map(escHtml).join(', ') : '—'
  const sizeKb = f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`
  const label = f.title || f.name

  const rows: Array<[string, string]> = [
    ['Name', f.name],
    ['MIME', f.mime],
    ['Size', sizeKb],
  ]
  if (f.title) rows.push(['Title', f.title])
  if (f.description) rows.push(['Description', f.description])
  if (f.group) rows.push(['Group', f.group])
  if (f.category) rows.push(['Category', f.category])
  rows.push(['Tags', tags])
  rows.push(['Created', f.createdAt])
  rows.push(['Updated', f.updatedAt])

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<div class="row"><div class="k">${escHtml(k)}</div><div class="v">${escHtml(v)}</div></div>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${escHtml(label)}"/>
<meta property="og:description" content="${escHtml(f.description || '')}"/>
<title>${escHtml(label)} — ${escHtml(f.name)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 32px 16px;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #11141d;
    color: #e6eaf3;
  }
  .card {
    width: 100%;
    max-width: 720px;
    background: #1a1f2c;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0,0,0,0.45);
  }
  .file-stage {
    background: #0d0f16;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 26px 20px;
  }
  .file-stage .doc {
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-size: 13px; color: #9aa3b5;
  }
  .file-stage .doc .tile {
    width: 64px; height: 84px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 15px; letter-spacing: 0.06em; text-transform: uppercase;
    color: #cfe0ff;
    background: linear-gradient(160deg, #26314f, #1a2237);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
  }
  .badge {
    display: inline-block;
    margin: 18px 18px 0;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #ffffff;
    background: #4c6fff;
    border-radius: 999px;
  }
  .head { padding: 14px 18px 8px; }
  .head h1 { margin: 0; font-size: 20px; font-weight: 700; line-height: 1.25; word-break: break-word; }
  .head .sub { color: #9aa3b5; font-size: 13px; margin-top: 4px; }
  .meta { padding: 8px 18px 8px; }
  .row { display: flex; gap: 16px; padding: 9px 0; border-top: 1px solid rgba(255,255,255,0.06); }
  .row .k { flex: 0 0 128px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #8b95a9; }
  .row .v { flex: 1; font-size: 13.5px; word-break: break-word; }
  .links { display: flex; gap: 10px; padding: 14px 18px 18px; flex-wrap: wrap; }
  .links a {
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    color: #cfd6e4;
    background: #262c3d;
    border-radius: 8px;
    transition: background-color .15s ease;
  }
  .links a:hover { background: #333b51; color: #fff; }
  .links a.primary { background: #4c6fff; color: #fff; }
  .links a.primary:hover { background: #6382ff; }
</style>
</head>
<body>
  <div class="card">
    <div class="file-stage">
      <div class="doc">
        <div class="tile">${escHtml(f.ext.slice(0, 5) || 'file')}</div>
        <div>${escHtml(f.mime)}</div>
      </div>
    </div>
    <span class="badge">${escHtml(f.title || f.name)}</span>
    <div class="head">
      <h1>${escHtml(f.title || f.name)}</h1>
      <div class="sub">${escHtml(f.name)} · served by the worker core</div>
    </div>
    <div class="meta">${rowsHtml}</div>
    <div class="links">
      <a class="primary" href="${escHtml(f.downloadUrl ?? f.url)}" target="_blank" rel="noopener">Download file</a>
      <a href="${escHtml(f.url)}" target="_blank" rel="noopener">Open raw file</a>
      <a href="${escHtml(baseUrl)}">Core home</a>
    </div>
  </div>
</body>
</html>`
}

app.get('/documents/:key', async (c) => {
  const key = c.req.param('key')
  if (!FILE_KEY_RE.test(key)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid document key')
  const obj = await c.env.MEDIA.get(`doc/${key}`)
  if (!obj) throw new HttpError(404, 'NOT_FOUND', 'Document not found')

  const accept = c.req.header('Accept') ?? '*/*'
  if (!accept.includes('text/html')) {
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('etag', obj.httpEtag)
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    return new Response(obj.body, { headers })
  }

  const db = createDb(c.env.DB)
  const row = await getFileRowByBasename(db, 'document', key)
  const baseUrl = new URL(c.req.url).origin
  if (!row) {
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('etag', obj.httpEtag)
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    return new Response(obj.body, { headers })
  }
  const file = rowToFile(row, baseUrl, 'document')
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('content-disposition', `inline; filename="${safeFilename(file.name)}"`)
  const html = fileViewerHtml(file, baseUrl)
  const header: Record<string, string> = {}
  headers.forEach((v, k) => {
    header[k] = v
  })
  return c.html(html, 200, header)
})

app.get('/documents/:key/download', async (c) => {
  const key = c.req.param('key')
  if (!FILE_KEY_RE.test(key)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid document key')
  const obj = await c.env.MEDIA.get(`doc/${key}`)
  if (!obj) throw new HttpError(404, 'NOT_FOUND', 'Document not found')
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('etag', obj.httpEtag)
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  const db = createDb(c.env.DB)
  const row = await getFileRowByBasename(db, 'document', key)
  if (row) headers.set('content-disposition', `attachment; filename="${safeFilename(row.name)}"`)
  return new Response(obj.body, { headers })
})

app.get('/attachments/:key', async (c) => {
  const key = c.req.param('key')
  if (!FILE_KEY_RE.test(key)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid attachment key')
  const obj = await c.env.MEDIA.get(`att/${key}`)
  if (!obj) throw new HttpError(404, 'NOT_FOUND', 'Attachment not found')
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('etag', obj.httpEtag)
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  const db = createDb(c.env.DB)
  const row = await getFileRowByBasename(db, 'attachment', key)
  if (row) headers.set('content-disposition', `inline; filename="${safeFilename(row.name)}"`)
  return new Response(obj.body, { headers })
})

app.get('/panel-assets/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid Panel asset id')
  const valid = await verifyPanelAssetSignature({
    secret: c.env.PANEL_ASSET_SECRET || c.env.JWT_SECRET,
    id,
    expires: c.req.query('expires') ?? null,
    signature: c.req.query('sig') ?? null,
  })
  if (!valid) throw new HttpError(401, 'PANEL_ASSET_UNAUTHORIZED', 'Panel asset URL is invalid or expired')
  const row = await getPanelAssetById(createDb(c.env.DB), id)
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Panel asset not found')
  const obj = await c.env.MEDIA.get(row.key)
  if (!obj) throw new HttpError(404, 'NOT_FOUND', 'Panel asset not found')
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('etag', obj.httpEtag)
  headers.set('cache-control', 'private, max-age=300')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('content-security-policy', "default-src 'none'; sandbox")
  headers.set('cross-origin-resource-policy', 'same-origin')
  if (c.req.query('download') === '1' || row.kind !== 'media') {
    headers.set('content-disposition', `attachment; filename="${safeFilename(row.name)}"`)
  }
  return new Response(obj.body, { headers })
})

app.route('/api/_auth', authRoutes)
app.route('/api/_meta/seed', seedRoutes)
app.route('/api/_meta', metaRoutes)
app.route('/api/_meta/universe/lands', landRoutes)
app.route('/api/_meta/universe/colonies', colonyRoutes)
app.route('/api/_media', mediaRoutes)
app.route('/api/_documents', documentRoutes)
app.route('/api/_attachments', attachmentRoutes)
app.route('/api/_config', configRoutes)
app.route('/api/_mcp', mcpRoutes)
app.route('/api/_plugins', pluginRoutes)
app.route('/api/_panels', panelRoutes)
app.route('/api', dynamicRoutes)

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    console.error('[core] http', err.status, err.message)
    const status = (err.status ?? 500) as ContentfulStatusCode
    return c.json(
      {
        error: {
          code: status === 401 ? 'UNAUTHORIZED' : 'ERROR',
          message: err.message ?? 'Bad request',
        },
      },
      status,
    )
  }
  if (err instanceof HttpError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.status as ContentfulStatusCode,
    )
  }
  console.error('[core] error:', err)
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500)
})

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404),
)

export default app