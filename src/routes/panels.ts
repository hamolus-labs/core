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
import { Hono } from 'hono'
import type { Context } from 'hono'
import type {
  AuthTokenPayload,
  CollectionDefinition,
  FieldDefinition,
  PanelDefinition,
  PanelFormViewDefinition,
  PanelMember,
  PanelMetricResult,
  PanelOperation,
  PanelRoleDefinition,
  PanelTableViewDefinition,
  PanelViewDefinition,
  PanelAssetKind,
} from '@hamolus/types'
import {
  buildEntitySchema,
  buildPaginationMeta,
  panelCreateInputSchema,
  panelDefinitionSchema,
  panelFieldNameSchema,
  panelIdInputSchema,
  panelIdSchema,
  panelQuerySchema,
  panelUpdateInputSchema,
  panelAssetQuerySchema,
} from '@hamolus/types'
import { getPrivilegeById } from '../auth/privileges'
import { requireSession } from '../auth/session'
import { getSuperRowById } from '../auth/super'
import { getUserRowById } from '../auth/users'
import { createDb, type Db } from '../db/client'
import { pkField, physicalTableName, quoteIdentifier } from '../db/table'
import { effectiveLocaleCodes } from '../config'
import {
  buildScopedWhereClause,
  createRecord,
  deleteRecord,
  deleteScopedRecord,
  getScopedRawRecord,
  listScopedRecords,
  projectScopedRow,
  updateScopedRecord,
  type ScopedFilterRule,
} from '../db/queries'
import type { Env } from '../env'
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../errors'
import { deletePanel, getPanel, listPanels, putPanel } from '../meta/panels'
import { getSettings } from '../meta/settings'
import { getCollection } from '../meta/store'
import { isCodePanel } from '../definitions'
import {
  createPanelAsset,
  deletePanelAsset,
  deletePanelAssetsForPanel,
  extOf,
  getPanelAsset,
  listPanelAssets,
  panelAssetKey,
  panelAssetToObject,
  panelAssetUrl,
} from '../media/panel-assets'
import { resolveRequestScope } from '../scope'

export const panelRoutes = new Hono<{ Bindings: Env }>()

type PanelCollectionView = PanelTableViewDefinition | PanelFormViewDefinition

interface PanelRuntimeUser {
  id: string
  username: string
  name: string | null
}

interface PanelRuntimeActor {
  user: PanelRuntimeUser
  attributes: Record<string, string | number | boolean | null>
  member: PanelMember | null
  role: PanelRoleDefinition
  global: boolean
}

interface ViewAccess {
  operations: Set<PanelOperation>
  readFields: string[]
  writeFields: string[]
}

function formatZodIssues(issues: { message: string; path?: unknown }[]): string {
  return issues.map((issue) => `${String(issue.path ?? 'input')}: ${issue.message}`).join('; ')
}

function parseObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(message)
  }
  return value as Record<string, unknown>
}

function parsePanelId(value: string): string {
  const parsed = panelIdInputSchema.safeParse({ id: value })
  if (!parsed.success) {
    throw badRequest(formatZodIssues(parsed.error.issues), 'INVALID_PANEL_ID')
  }
  return parsed.data.id
}

function parseSafeId(value: string, kind: 'view' | 'field'): string {
  const schema = kind === 'view' ? panelIdSchema : panelFieldNameSchema
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw badRequest(formatZodIssues(parsed.error.issues), `INVALID_PANEL_${kind.toUpperCase()}_ID`)
  }
  return parsed.data
}

function requiredParam(c: Context<{ Bindings: Env }>, name: string): string {
  const value = c.req.param(name)
  if (!value) throw badRequest(`Missing path parameter '${name}'`)
  return value
}

function parseQuery(c: { req: { url: string } }): ReturnType<typeof panelQuerySchema.parse> {
  const values = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  const parsed = panelQuerySchema.safeParse(values)
  if (!parsed.success) {
    throw badRequest('Invalid query: ' + formatZodIssues(parsed.error.issues), 'INVALID_QUERY')
  }
  return parsed.data
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function findView(panel: PanelDefinition, id: string): PanelViewDefinition {
  const view = panel.views.find((entry) => entry.id === id)
  if (!view) throw notFound(`Panel view '${id}' not found`, 'PANEL_VIEW_NOT_FOUND')
  return view
}

function findField(def: CollectionDefinition, name: string): FieldDefinition | undefined {
  const declared = def.fields.find((field) => field.name === name)
  if (declared) return declared
  // Mirrors `meta/panels`: the primary key exists on the table and on every record even
  // when it is not declared in `fields`, so a view may reference it.
  const pk = pkField(def)
  return pk.name === name ? pk : undefined
}

function panelAssetKind(field: FieldDefinition): PanelAssetKind {
  if (field.type === 'media' || field.type === 'document' || field.type === 'attachment') return field.type
  throw badRequest(`Field '${field.name}' does not accept Panel assets`, 'PANEL_ASSET_FIELD_INVALID')
}

function panelAssetSecret(env: Env): string {
  return env.PANEL_ASSET_SECRET || env.JWT_SECRET
}

function parseAssetQuery(c: { req: { url: string } }): ReturnType<typeof panelAssetQuerySchema.parse> {
  const values = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  const parsed = panelAssetQuerySchema.safeParse(values)
  if (!parsed.success) {
    throw badRequest('Invalid asset query: ' + formatZodIssues(parsed.error.issues), 'INVALID_QUERY')
  }
  return parsed.data
}

async function loadRuntimeActor(
  db: Db,
  payload: AuthTokenPayload,
  land: string,
  colony: string,
  panel: PanelDefinition,
): Promise<PanelRuntimeActor> {
  if (payload.sub === 'admin') {
    const role = panel.roles.find((entry) => entry.id === panel.defaultRoleId) ?? panel.roles[0]!
    return {
      user: { id: 'admin', username: payload.username ?? 'admin', name: null },
      attributes: {},
      member: null,
      role,
      global: true,
    }
  }

  if (payload.sub.startsWith('super:')) {
    const row = await getSuperRowById(db, payload.sub.slice('super:'.length)).catch(() => null)
    if (!row) throw unauthorized('Session user no longer exists')
    if (row.is_active !== 1) throw unauthorized('Session account is disabled', 'ACCOUNT_DISABLED')
    const role = panel.roles.find((entry) => entry.id === panel.defaultRoleId) ?? panel.roles[0]!
    return {
      user: { id: row.id, username: row.username, name: row.name },
      attributes: {},
      member: null,
      role,
      global: true,
    }
  }

  // The colony is part of the lookup key: a `panel_user` who lives in a
  // non-default colony is stored under (land, colony), so omitting it fell back
  // to the default colony, missed the row, and refused the holder of a panel
  // they were legitimately assigned to.
  const row = await getUserRowById(db, payload.sub, land, colony).catch(() => null)
  if (!row) throw unauthorized('Session user no longer exists')
  if (row.is_active !== 1) throw unauthorized('Session account is disabled', 'ACCOUNT_DISABLED')
  const privilege = await getPrivilegeById(db, row.privilege_id, land, colony)
  if (!privilege) throw forbidden('Session privilege no longer exists', 'PANEL_ACCESS_DENIED')
  if (privilege.name === 'admin') {
    const role = panel.roles.find((entry) => entry.id === panel.defaultRoleId) ?? panel.roles[0]!
    return {
      user: { id: row.id, username: row.username, name: row.name },
      attributes: {},
      member: null,
      role,
      global: true,
    }
  }

  const member = panel.members.find((entry) => entry.userId === row.id) ?? null
  if (!member) throw forbidden('You are not assigned to this panel', 'PANEL_MEMBERSHIP_REQUIRED')
  const role = panel.roles.find((entry) => entry.id === member.roleId)
  if (!role) throw forbidden('Your panel role no longer exists', 'PANEL_ACCESS_DENIED')

  return {
    user: { id: row.id, username: row.username, name: row.name },
    attributes: member.attributes,
    member,
    role,
    global: false,
  }
}

function viewAccess(
  view: PanelViewDefinition,
  role: PanelRoleDefinition,
  global: boolean,
): ViewAccess {
  const viewOperations = new Set(view.operations)
  if (global) {
    return {
      operations: new Set(viewOperations),
      readFields: unique(view.fields.read),
      writeFields: unique(view.fields.write),
    }
  }
  const access = role.views.find((entry) => entry.viewId === view.id)
  if (!access) return { operations: new Set(), readFields: [], writeFields: [] }
  const read = new Set(view.fields.read)
  const write = new Set(view.fields.write)
  return {
    operations: new Set(access.operations.filter((operation) => viewOperations.has(operation))),
    readFields: unique((access.readFields ?? view.fields.read).filter((field) => read.has(field))),
    writeFields: unique((access.writeFields ?? view.fields.write).filter((field) => write.has(field))),
  }
}

function requireViewOperation(access: ViewAccess, operation: PanelOperation): void {
  if (!access.operations.has(operation)) {
    throw forbidden(`Panel view does not allow ${operation}`, 'PANEL_OPERATION_FORBIDDEN')
  }
}

function assertReadable(def: CollectionDefinition, name: string, access: ViewAccess): FieldDefinition {
  if (!access.readFields.includes(name)) {
    throw forbidden(`Field '${name}' is not readable in this panel view`, 'PANEL_FIELD_FORBIDDEN')
  }
  const field = findField(def, name)
  if (!field || field.hidden) {
    throw forbidden(`Field '${name}' is not readable in this panel view`, 'PANEL_FIELD_FORBIDDEN')
  }
  return field
}

function assertWritable(def: CollectionDefinition, name: string, access: ViewAccess): FieldDefinition {
  if (!access.writeFields.includes(name)) {
    throw forbidden(`Field '${name}' is not writable in this panel view`, 'PANEL_FIELD_FORBIDDEN')
  }
  const field = findField(def, name)
  if (!field || field.hidden) {
    throw forbidden(`Field '${name}' is not writable in this panel view`, 'PANEL_FIELD_FORBIDDEN')
  }
  return field
}

function resolveFilters(
  view: Extract<PanelViewDefinition, { filters: PanelViewDefinition['filters'] }>,
  attributes: Record<string, string | number | boolean | null>,
): ScopedFilterRule[] {
  return view.filters.map((rule) => {
    if (!rule.source) return { field: rule.field, op: rule.op, value: rule.value }
    const name = rule.source.slice('member.attributes.'.length)
    if (!Object.prototype.hasOwnProperty.call(attributes, name)) {
      throw forbidden(`Panel attribute '${name}' is missing`, 'PANEL_ATTRIBUTE_MISSING')
    }
    return { field: rule.field, op: rule.op, value: attributes[name] }
  })
}

function injectSourceFilters(
  view: Extract<PanelViewDefinition, { filters: PanelViewDefinition['filters'] }>,
  actor: PanelRuntimeActor,
  values: Record<string, unknown>,
): Set<string> {
  const injectedFields = new Set<string>()
  for (const rule of view.filters) {
    if (!rule.source) continue
    const attributeName = rule.source.slice('member.attributes.'.length)
    if (!Object.prototype.hasOwnProperty.call(actor.attributes, attributeName)) {
      throw forbidden(`Panel attribute '${attributeName}' is missing`, 'PANEL_ATTRIBUTE_MISSING')
    }
    values[rule.field] = actor.attributes[attributeName]
    injectedFields.add(rule.field)
  }
  return injectedFields
}

function assertWriteFields(
  def: CollectionDefinition,
  input: Record<string, unknown>,
  access: ViewAccess,
  injectedFields: ReadonlySet<string>,
): void {
  for (const name of Object.keys(input)) {
    if (injectedFields.has(name)) continue
    assertWritable(def, name, access)
  }
}

async function validateEntityInput(
  env: Env,
  land: string,
  colony: string,
  def: CollectionDefinition,
  input: Record<string, unknown>,
  access: ViewAccess,
  partial: boolean,
  injectedFields: ReadonlySet<string> = new Set(),
): Promise<Record<string, unknown>> {
  assertWriteFields(def, input, access, injectedFields)
  if (partial && Object.keys(input).length === 0) {
    throw badRequest('No writable fields supplied')
  }
  const settings = await getSettings(env.SETTINGS, land)
  const schema = buildEntitySchema(def, effectiveLocaleCodes(settings))
  const parsed = (partial ? schema.partial() : schema).safeParse(input)
  if (!parsed.success) {
    throw badRequest('Validation failed: ' + formatZodIssues(parsed.error.issues), 'VALIDATION')
  }
  return parsed.data as Record<string, unknown>
}

function readLocale(c: { req: { query(name: string): string | undefined } }): string | undefined {
  const locale = c.req.query('locale') || undefined
  if (locale && locale.length > 20) throw badRequest('Locale is too long', 'INVALID_QUERY')
  return locale
}

function effectiveQuery(
  query: ReturnType<typeof panelQuerySchema.parse>,
  view: Extract<PanelViewDefinition, { pageSize: number }>,
  raw: URLSearchParams,
): ReturnType<typeof panelQuerySchema.parse> {
  return {
    ...query,
    pageSize: raw.has('pageSize') ? query.pageSize : view.pageSize,
  }
}

interface PanelTargetScope {
  view: PanelCollectionView
  access: ViewAccess
  filters: ScopedFilterRule[]
}

function targetScopeForCollection(
  panel: PanelDefinition,
  collection: string,
  actor: PanelRuntimeActor,
): PanelTargetScope | undefined {
  const candidates: PanelTargetScope[] = []
  for (const view of panel.views) {
    if (view.kind === 'dashboard' || view.collection !== collection) continue
    const access = viewAccess(view, actor.role, actor.global)
    if (!access.operations.has('read')) continue
    candidates.push({ view, access, filters: resolveFilters(view, actor.attributes) })
  }
  const primary = candidates[0]
  if (!primary) return undefined
  const filters = candidates.flatMap((candidate) => candidate.filters)
  return {
    view: primary.view,
    access: {
      operations: new Set(primary.access.operations),
      readFields: unique(candidates.flatMap((candidate) => candidate.access.readFields)),
      writeFields: unique(primary.access.writeFields),
    },
    filters,
  }
}

function relationLabelField(def: CollectionDefinition, access: ViewAccess): string | undefined {
  const candidates = ['label', 'title', 'name']
  for (const name of candidates) {
    const field = findField(def, name)
    if (field && !field.hidden && access.readFields.includes(name) && ['string', 'text', 'slug'].includes(field.type)) {
      return name
    }
  }
  return access.readFields.find((name) => {
    const field = findField(def, name)
    return !!field && !field.hidden && ['string', 'text', 'slug'].includes(field.type)
  })
}

function optionValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function metricGroupValue(value: unknown): string | null {
  return optionValue(value)
}

panelRoutes.get('/', async (c) => {
  requireSession(c.get('jwtPayload') as AuthTokenPayload | undefined, 'panels.read')
  const scope = await resolveRequestScope(c)
  const panels = await listPanels(createDb(c.env.DB), scope.land, scope.colony)
  return c.json({ data: panels })
})

panelRoutes.post('/', async (c) => {
  requireSession(c.get('jwtPayload') as AuthTokenPayload | undefined, 'panels.write')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const body = await c.req.json().catch(() => null)
  const parsed = panelCreateInputSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid panel: ' + formatZodIssues(parsed.error.issues), 'INVALID_PANEL')
  }
  if (isCodePanel(parsed.data.definition.id)) {
    throw forbidden(
      `The '${parsed.data.definition.id}' panel is declared in code (src/panels) and is read-only. Edit the file and redeploy to change it.`,
      'CODE_DEFINED_PANEL',
    )
  }
  if ((await listPanels(db, scope.land, scope.colony)).some((panel) => panel.id === parsed.data.definition.id)) {
    throw new HttpError(409, 'PANEL_EXISTS', `Panel '${parsed.data.definition.id}' already exists`)
  }
  const panel = await putPanel(db, parsed.data.definition, scope.land, scope.colony)
  return c.json({ data: panel }, 201)
})

panelRoutes.get('/:id', async (c) => {
  requireSession(c.get('jwtPayload') as AuthTokenPayload | undefined, 'panels.read')
  const scope = await resolveRequestScope(c)
  const panel = await getPanel(createDb(c.env.DB), parsePanelId(c.req.param('id')), scope.land, scope.colony)
  return c.json({ data: panel })
})

async function replacePanel(c: Context<{ Bindings: Env }>, mustExist: boolean): Promise<Response> {
  requireSession(c.get('jwtPayload') as AuthTokenPayload | undefined, 'panels.write')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const id = parsePanelId(requiredParam(c, 'id'))
  const body = await c.req.json().catch(() => null)
  if (isCodePanel(id)) {
    throw forbidden(
      `The '${id}' panel is declared in code (src/panels) and is read-only. Edit the file and redeploy to change it.`,
      'CODE_DEFINED_PANEL',
    )
  }
  const parsed = panelUpdateInputSchema.safeParse(body)
  if (!parsed.success) {
    throw badRequest('Invalid panel: ' + formatZodIssues(parsed.error.issues), 'INVALID_PANEL')
  }
  if (parsed.data.definition.id !== id) {
    throw badRequest('Body panel id must match the path parameter', 'INVALID_PANEL_ID')
  }
  if (mustExist) await getPanel(db, id, scope.land, scope.colony)
  const panel = await putPanel(db, parsed.data.definition, scope.land, scope.colony)
  return c.json({ data: panel })
}

panelRoutes.put('/:id', (c) => replacePanel(c, false))
panelRoutes.patch('/:id', (c) => replacePanel(c, true))

panelRoutes.delete('/:id', async (c) => {
  requireSession(c.get('jwtPayload') as AuthTokenPayload | undefined, 'panels.write')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const id = parsePanelId(c.req.param('id'))
  if (isCodePanel(id)) {
    throw forbidden(
      `The '${id}' panel is declared in code (src/panels) and is read-only. Edit the file and redeploy to change it.`,
      'CODE_DEFINED_PANEL',
    )
  }
  await getPanel(db, id, scope.land, scope.colony)
  const assets = await deletePanelAssetsForPanel(db, {
    land: scope.land,
    colony: scope.colony,
    panelId: id,
  })
  for (const asset of assets) await c.env.MEDIA.delete(asset.key)
  await deletePanel(db, id, scope.land, scope.colony)
  return c.body(null, 204)
})

panelRoutes.get('/:id/bootstrap', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(c.req.param('id')), scope.land, scope.colony)
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const allowed: Array<{ view: PanelViewDefinition; access: ViewAccess }> = []

  for (const view of panel.views) {
    const access = viewAccess(view, actor.role, actor.global)
    if (access.operations.size === 0) continue
    if (view.kind !== 'dashboard') resolveFilters(view, actor.attributes)
    allowed.push({ view, access })
  }
  if (allowed.length === 0) throw forbidden('No panel views are available', 'PANEL_ACCESS_DENIED')

  const allowedIds = new Set(allowed.map((entry) => entry.view.id))
  const roleAccess = allowed.map(({ view, access }) => ({
    viewId: view.id,
    operations: [...access.operations],
    readFields: access.readFields,
    writeFields: access.writeFields,
  }))
  const effectiveRole: PanelRoleDefinition = {
    id: actor.role.id,
    label: actor.role.label,
    description: actor.role.description,
    views: roleAccess,
  }
  const filtered = panelDefinitionSchema.parse({
    ...panel,
    views: allowed.map(({ view, access }) => ({
      ...view,
      fields: {
        read: access.readFields,
        write: access.writeFields,
      },
      operations: [...access.operations],
    })),
    menu: panel.menu.filter((item) => allowedIds.has(item.viewId)),
    roles: [effectiveRole],
    members: actor.member ? [actor.member] : [],
    defaultRoleId: effectiveRole.id,
  })
  return c.json({
    data: {
      panel: filtered,
      role: effectiveRole,
      user: actor.user,
      attributes: actor.attributes,
    },
  })
})

panelRoutes.get('/:id/views/:viewId/assets', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(requiredParam(c, 'id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(requiredParam(c, 'viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not expose assets', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  requireViewOperation(access, 'read')
  const def = await getCollection(db, view.collection, scope.land, scope.colony)
  const query = parseAssetQuery(c)
  const field = assertReadable(def, query.field, access)
  const kind = panelAssetKind(field)
  const result = await listPanelAssets(db, {
    land: scope.land,
    colony: scope.colony,
    panelId: panel.id,
    kind,
    page: query.page,
    pageSize: query.pageSize,
    search: query.search,
  })
  const baseUrl = new URL(c.req.url).origin
  const data = await Promise.all(
    result.rows.map(async (row) => {
      const urls = await panelAssetUrl({ baseUrl, secret: panelAssetSecret(c.env), row })
      return panelAssetToObject(row, urls)
    }),
  )
  return c.json({
    data,
    meta: buildPaginationMeta(query.page, query.pageSize, result.total),
  })
})

panelRoutes.post('/:id/views/:viewId/assets', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(requiredParam(c, 'id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(requiredParam(c, 'viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not accept assets', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  if (!access.operations.has('create') && !access.operations.has('update')) {
    throw forbidden('Panel view does not allow asset uploads', 'PANEL_OPERATION_FORBIDDEN')
  }
  const def = await getCollection(db, view.collection, scope.land, scope.colony)
  const query = parseAssetQuery(c)
  const field = assertWritable(def, query.field, access)
  const kind = panelAssetKind(field)
  const form = await c.req.formData().catch(() => null)
  if (!form) throw badRequest('Expected multipart form data')
  const file = form.get('file')
  if (!(file instanceof File) || file.size <= 0) throw badRequest('Missing or empty file')
  if (kind === 'media' && !file.type.startsWith('image/')) {
    throw badRequest('Only image files are allowed for media fields', 'UNSUPPORTED_MEDIA')
  }
  const rawName = typeof form.get('name') === 'string' ? String(form.get('name')).trim() : file.name
  const name = (rawName || file.name).slice(0, 255)
  const ext = extOf(name)
  const id = crypto.randomUUID()
  const key = panelAssetKey({ land: scope.land, panelId: panel.id, id, ext })
  const bytes = await file.arrayBuffer()
  await c.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  })
  try {
    const row = await createPanelAsset(db, {
      id,
      land: scope.land,
      colony: scope.colony,
      panelId: panel.id,
      kind,
      key,
      name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      ext,
    })
    const urls = await panelAssetUrl({
      baseUrl: new URL(c.req.url).origin,
      secret: panelAssetSecret(c.env),
      row,
    })
    return c.json({ data: panelAssetToObject(row, urls) }, 201)
  } catch (error) {
    await c.env.MEDIA.delete(key)
    throw error
  }
})

panelRoutes.delete('/:id/views/:viewId/assets/:assetId', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(requiredParam(c, 'id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(requiredParam(c, 'viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not accept assets', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  if (!access.operations.has('create') && !access.operations.has('update')) {
    throw forbidden('Panel view does not allow asset deletion', 'PANEL_OPERATION_FORBIDDEN')
  }
  const def = await getCollection(db, view.collection, scope.land, scope.colony)
  const query = parseAssetQuery(c)
  const field = assertWritable(def, query.field, access)
  const assetId = requiredParam(c, 'assetId')
  const existing = await getPanelAsset(db, {
    id: assetId,
    land: scope.land,
    colony: scope.colony,
    panelId: panel.id,
  })
  if (!existing || panelAssetKind(field) !== existing.kind) {
    throw badRequest('Asset does not belong to this field', 'PANEL_ASSET_FIELD_INVALID')
  }
  const row = await deletePanelAsset(db, {
      id: assetId,
      land: scope.land,
      colony: scope.colony,
      panelId: panel.id,
    })
  await c.env.MEDIA.delete(row.key)
  return c.body(null, 204)
})

panelRoutes.get('/:id/views/:viewId/records', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(c.req.param('id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(c.req.param('viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not expose records', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  requireViewOperation(access, 'read')
  const def = await getCollection(db, view.collection, scope.land, scope.colony)
  const rawQuery = new URL(c.req.url).searchParams
  const query = effectiveQuery(parseQuery(c), view, rawQuery)
  const search = query.search?.trim() || undefined
  if (search && !view.searchable) {
    throw forbidden('This panel view is not searchable', 'PANEL_SEARCH_FORBIDDEN')
  }
  const sortBy = query.sortBy ?? view.defaultSort?.field
  const sortDesc = query.sortBy
    ? query.sortDir === 'desc'
    : view.defaultSort?.direction === 'desc'
  if (sortBy) assertReadable(def, sortBy, access)
  const filters = resolveFilters(view, actor.attributes)
  const result = await listScopedRecords(db, def, {
    page: query.page,
    pageSize: query.pageSize,
    filters,
    readFields: access.readFields,
    sortBy,
    sortDesc,
    locale: query.locale,
    search,
  })
  return c.json({
    data: result.rows,
    meta: buildPaginationMeta(query.page, query.pageSize, result.total),
    lastUpdate: result.lastUpdate,
  })
})

panelRoutes.get('/:id/views/:viewId/records/:recordId', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(c.req.param('id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(c.req.param('viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not expose records', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  requireViewOperation(access, 'read')
  const def = await getCollection(db, view.collection, scope.land, scope.colony)
  const raw = await getScopedRawRecord(db, def, c.req.param('recordId'), resolveFilters(view, actor.attributes))
  if (!raw) throw notFound('Record not found in this panel view', 'PANEL_RECORD_NOT_FOUND')
  return c.json({ data: projectScopedRow(def, raw, access.readFields, readLocale(c)) })
})

panelRoutes.post('/:id/views/:viewId/records', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(c.req.param('id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(c.req.param('viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not accept records', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  requireViewOperation(access, 'create')
  const def = await getCollection(db, view.collection, scope.land, scope.colony)
  const input = parseObject(await c.req.json().catch(() => null), 'Body must be a JSON object')
  const values: Record<string, unknown> = { ...input }
  const injectedFields = injectSourceFilters(view, actor, values)
  const parsed = await validateEntityInput(c.env, scope.land, scope.colony, def, values, access, false, injectedFields)
  const created = await createRecord(db, def, parsed, actor.user.username)
  const createdId = String(created.id ?? '')
  const raw = await getScopedRawRecord(db, def, createdId, resolveFilters(view, actor.attributes))
  if (!raw) {
    await deleteRecord(db, def, createdId, actor.user.username)
    throw forbidden('The created record is outside this panel view', 'PANEL_FILTER_MISMATCH')
  }
  return c.json({ data: projectScopedRow(def, raw, access.readFields, readLocale(c)) }, 201)
})

async function updatePanelRecord(c: Context<{ Bindings: Env }>): Promise<Response> {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(requiredParam(c, 'id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(requiredParam(c, 'viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not accept records', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  requireViewOperation(access, 'update')
  const def = await getCollection(db, view.collection, scope.land, scope.colony)
  const input = parseObject(await c.req.json().catch(() => null), 'Body must be a JSON object')
  if (Object.keys(input).length === 0) throw badRequest('No writable fields supplied')
  const values: Record<string, unknown> = { ...input }
  const injectedFields = injectSourceFilters(view, actor, values)
  const parsed = await validateEntityInput(c.env, scope.land, scope.colony, def, values, access, true, injectedFields)
  const raw = await updateScopedRecord(
    db,
    def,
    requiredParam(c, 'recordId'),
    parsed,
    resolveFilters(view, actor.attributes),
    actor.user.username,
  )
  return c.json({ data: projectScopedRow(def, raw, access.readFields, readLocale(c)) })
}

panelRoutes.put('/:id/views/:viewId/records/:recordId', (c) => updatePanelRecord(c))
panelRoutes.patch('/:id/views/:viewId/records/:recordId', (c) => updatePanelRecord(c))

panelRoutes.delete('/:id/views/:viewId/records/:recordId', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(c.req.param('id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(c.req.param('viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not accept records', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  requireViewOperation(access, 'delete')
  const def = await getCollection(db, view.collection, scope.land, scope.colony)
  await deleteScopedRecord(db, def, c.req.param('recordId'), resolveFilters(view, actor.attributes), actor.user.username)
  return c.body(null, 204)
})

panelRoutes.get('/:id/views/:viewId/relations/:field/options', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(c.req.param('id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(c.req.param('viewId'), 'view'))
  if (view.kind === 'dashboard') throw badRequest('Dashboard views do not expose relations', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  if (!access.operations.has('create') && !access.operations.has('update')) {
    throw forbidden('Panel view does not allow relation input', 'PANEL_OPERATION_FORBIDDEN')
  }
  const source = await getCollection(db, view.collection, scope.land, scope.colony)
  const field = assertWritable(source, parseSafeId(c.req.param('field'), 'field'), access)
  if (field.type !== 'relation' || !field.relation) {
    throw new HttpError(501, 'PANEL_RELATIONS_UNSUPPORTED', 'Panel field is not a relation')
  }
  const targetName = panelFieldNameSchema.safeParse(field.relation.collection)
  const targetFieldName = panelFieldNameSchema.safeParse(field.relation.field)
  if (!targetName.success || !targetFieldName.success) {
    throw new HttpError(501, 'PANEL_RELATIONS_UNSUPPORTED', 'Relation target is not safe')
  }
  const target = targetScopeForCollection(panel, targetName.data, actor)
  if (!target) {
    throw new HttpError(501, 'PANEL_RELATIONS_UNSUPPORTED', 'No authorized target view is configured')
  }
  const targetDef = await getCollection(db, targetName.data, scope.land, scope.colony).catch(() => null)
  if (!targetDef) {
    throw new HttpError(501, 'PANEL_RELATIONS_UNSUPPORTED', 'Relation target collection is unavailable')
  }
  const targetAcl = target.access
  assertReadable(targetDef, targetFieldName.data, targetAcl)
  const labelField = relationLabelField(targetDef, targetAcl)
  const rawQuery = new URL(c.req.url).searchParams
  const query = effectiveQuery(parseQuery(c), target.view, rawQuery)
  const search = query.search?.trim() || undefined
  if (search && !target.view.searchable) {
    throw forbidden('The target panel view is not searchable', 'PANEL_SEARCH_FORBIDDEN')
  }
  const sortBy = query.sortBy ?? target.view.defaultSort?.field
  if (sortBy) assertReadable(targetDef, sortBy, targetAcl)
  const result = await listScopedRecords(db, targetDef, {
    page: query.page,
    pageSize: query.pageSize,
    filters: target.filters,
    readFields: targetAcl.readFields,
    sortBy,
    sortDesc: query.sortBy ? query.sortDir === 'desc' : target.view.defaultSort?.direction === 'desc',
    locale: query.locale,
    search,
  })
  const data = result.rows.flatMap((row) => {
    const value = optionValue(row[targetFieldName.data])
    if (value === null) return []
    return [{ value, label: optionValue(labelField ? row[labelField] : value) ?? value }]
  })
  return c.json({ data })
})

panelRoutes.get('/:id/views/:viewId/dashboard', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  if (!payload) throw unauthorized('Authentication required')
  const scope = await resolveRequestScope(c)
  const db = createDb(c.env.DB)
  const panel = await getPanel(db, parsePanelId(c.req.param('id')), scope.land, scope.colony)
  const view = findView(panel, parseSafeId(c.req.param('viewId'), 'view'))
  if (view.kind !== 'dashboard') throw badRequest('Only dashboard views expose metrics', 'PANEL_VIEW_KIND')
  const actor = await loadRuntimeActor(db, payload, scope.land, scope.colony, panel)
  const access = viewAccess(view, actor.role, actor.global)
  requireViewOperation(access, 'read')
  const output: PanelMetricResult[] = []

  for (const metric of view.metrics) {
    const target = targetScopeForCollection(panel, metric.collection, actor)
    if (!target) {
      throw new HttpError(501, 'PANEL_METRICS_UNSUPPORTED', `Metric '${metric.id}' has no authorized target view`)
    }
    const targetDef = await getCollection(db, metric.collection, scope.land, scope.colony).catch(() => null)
    if (!targetDef) {
      throw new HttpError(501, 'PANEL_METRICS_UNSUPPORTED', `Metric '${metric.id}' target is unavailable`)
    }
    const targetAcl = target.access
    let metricField: FieldDefinition | undefined
    if (metric.field) {
      metricField = assertReadable(targetDef, metric.field, targetAcl)
      if (metric.operation !== 'count' && !['number', 'currency', 'custom_currency'].includes(metricField.type)) {
        throw forbidden(`Metric '${metric.id}' requires a numeric readable field`, 'PANEL_METRIC_FORBIDDEN')
      }
    }
    if (metric.groupBy) assertReadable(targetDef, metric.groupBy, targetAcl)
    const table = sql.raw(quoteIdentifier(physicalTableName(targetDef)))
    const where = buildScopedWhereClause(targetDef, target.filters)
    const fieldColumn = metric.field ? sql.raw(quoteIdentifier(metric.field)) : undefined
    const groupColumn = metric.groupBy ? sql.raw(quoteIdentifier(metric.groupBy)) : undefined
    const aggregate = metric.operation === 'count'
      ? fieldColumn
        ? sql`count(${fieldColumn})`
        : sql`count(*)`
      : metric.operation === 'sum'
        ? sql`sum(${fieldColumn})`
        : metric.operation === 'avg'
          ? sql`avg(${fieldColumn})`
          : metric.operation === 'min'
            ? sql`min(${fieldColumn})`
            : sql`max(${fieldColumn})`

    if (groupColumn) {
      const rows = await db.all<{ value: unknown; group: unknown }>(
        sql`SELECT ${aggregate} AS value, ${groupColumn} AS "group" FROM ${table} WHERE ${where} GROUP BY ${groupColumn} ORDER BY ${groupColumn} ASC`,
      )
      for (const row of rows) {
        const value = row.value === null || row.value === undefined ? null : Number(row.value)
        output.push({
          id: metric.id,
          label: metric.label,
          value: value !== null && Number.isFinite(value) ? value : null,
          group: metricGroupValue(row.group),
        })
      }
      continue
    }
    const row = await db.get<{ value: unknown }>(sql`SELECT ${aggregate} AS value FROM ${table} WHERE ${where}`)
    const value = row?.value === null || row?.value === undefined ? null : Number(row.value)
    output.push({
      id: metric.id,
      label: metric.label,
      value: value !== null && Number.isFinite(value) ? value : null,
    })
  }
  return c.json({ data: output })
})
