#!/usr/bin/env node
/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 *
 * Sample Panel seed — creates a set of demo Panels against the collections that
 * exist in the target scope, plus one `panel_user` account per Panel so the
 * runtime (manifest-as-ACL) path can actually be exercised.
 *
 * Self-cleaning: every Panel and demo user it owns is deleted first, so re-running
 * is safe. Panels are addressed by their own ids, and a user is only removed when
 * the script created it in a previous run (tracked by the `_sample` name suffix).
 *
 *   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me node scripts/seed-panels.mjs
 *
 * Optional:
 *   LAND / COLONY  target a specific scope (default = the default scope)
 *   PANEL_PASSWORD password for the generated demo users (default: panel-demo-123)
 */

const BASE = (process.env.BASE || 'http://localhost:8787').replace(/\/$/, '')
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key-change-me'
const LAND = process.env.LAND || ''
const COLONY = process.env.COLONY || ''
const PASSWORD = process.env.PANEL_PASSWORD || 'panel-demo-123'
const SAMPLE_PASSWORD = 'panel-demo-123'

function scopeHeaders() {
  const headers = {}
  if (LAND) headers['x-land'] = LAND
  if (COLONY) headers['x-colony'] = COLONY
  return headers
}

async function api(path, { method = 'GET', body, token, raw } = {}) {
  const headers = { ...scopeHeaders() }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined && !raw) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { error: { code: 'NON_JSON', message: text.slice(0, 200) } }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${parsed?.error?.code ?? ''} ${parsed?.error?.message ?? text.slice(0, 200)}`)
    err.status = res.status
    err.body = parsed
    throw err
  }
  return parsed
}

/* ------------------------------------------------------------------ panels */

const PANELS = [
  {
    id: 'shop_ops',
    name: 'Shop Operations',
    description: 'Stock, pricing and rating triage for the product catalog.',
    icon: 'box',
    theme: { mode: 'dark', palette: 'blue' },
    views: [
      {
        kind: 'dashboard',
        id: 'overview',
        label: 'Overview',
        path: '/overview',
        icon: 'grid',
        description: 'Catalog health at a glance.',
        fields: { read: [], write: [] },
        operations: ['read'],
        metrics: [
          { id: 'products', label: 'Products', collection: 'products', operation: 'count' },
          { id: 'units', label: 'Units in stock', collection: 'products', operation: 'sum', field: 'stock_quantity', format: 'compact' },
          { id: 'avg_rating', label: 'Average rating', collection: 'products', operation: 'avg', field: 'rating' },
          { id: 'by_status', label: 'By status', collection: 'products', operation: 'count', groupBy: 'status' },
        ],
      },
      {
        kind: 'table',
        id: 'inventory',
        label: 'Inventory',
        path: '/inventory',
        icon: 'list',
        description: 'Live SKUs. Archived products are out of scope for this view.',
        collection: 'products',
        operations: ['read', 'update'],
        searchable: true,
        pageSize: 25,
        // `status` is readable but deliberately NOT writable: the view is filtered on
        // it, and the scoped-update rule refuses a write that would drift the record
        // out of the caller's own scope.
        filters: [{ field: 'status', op: 'neq', value: 'archived' }],
        fields: {
          read: ['id', 'name', 'sku', 'price', 'compare_at_price', 'stock_quantity', 'low_stock_threshold', 'in_stock', 'status', 'rating', 'review_count'],
          write: ['stock_quantity', 'low_stock_threshold', 'in_stock'],
        },
        defaultSort: { field: 'stock_quantity', direction: 'asc' },
      },
      {
        kind: 'form',
        id: 'new_product',
        label: 'Add product',
        path: '/products/new',
        icon: 'plus',
        collection: 'products',
        operations: ['create'],
        submitLabel: 'Create product',
        fields: {
          read: ['id', 'name', 'slug', 'sku', 'price', 'stock_quantity', 'status'],
          write: ['name', 'slug', 'sku', 'price', 'compare_at_price', 'stock_quantity', 'status', 'description'],
        },
      },
    ],
    menu: [
      { id: 'overview', label: 'Overview', path: '/overview', viewId: 'overview', icon: 'grid' },
      { id: 'inventory', label: 'Inventory', path: '/inventory', viewId: 'inventory', icon: 'list' },
      { id: 'new_product', label: 'Add product', path: '/products/new', viewId: 'new_product', icon: 'plus' },
    ],
    roles: [
      {
        id: 'operator',
        label: 'Operator',
        description: 'Adjusts stock levels; cannot archive or delete products.',
        views: [
          { viewId: 'overview', operations: ['read'] },
          {
            viewId: 'inventory',
            operations: ['read', 'update'],
            readFields: ['id', 'name', 'sku', 'stock_quantity', 'low_stock_threshold', 'in_stock', 'status', 'rating'],
            writeFields: ['stock_quantity', 'low_stock_threshold', 'in_stock'],
          },
          {
            viewId: 'new_product',
            operations: ['create'],
            readFields: ['id', 'name', 'sku', 'price', 'stock_quantity', 'status'],
            writeFields: ['name', 'slug', 'sku', 'price', 'compare_at_price', 'stock_quantity', 'status', 'description'],
          },
        ],
      },
      {
        id: 'viewer',
        label: 'Viewer',
        description: 'Read-only access to the dashboard and inventory list.',
        views: [
          { viewId: 'overview', operations: ['read'] },
          { viewId: 'inventory', operations: ['read'], readFields: ['id', 'name', 'sku', 'stock_quantity', 'in_stock', 'status', 'rating'] },
        ],
      },
    ],
    members: [{ userId: '@shop_operator', roleId: 'operator' }, { userId: '@shop_viewer', roleId: 'viewer' }],
    defaultRoleId: 'operator',
  },

  {
    id: 'inbox_desk',
    name: 'Inbox Desk',
    description: 'Lead triage for website enquiries.',
    icon: 'mail',
    theme: { mode: 'light', palette: 'amber' },
    views: [
      {
        kind: 'dashboard',
        id: 'triage',
        label: 'Triage',
        path: '/triage',
        icon: 'grid',
        fields: { read: [], write: [] },
        operations: ['read'],
        metrics: [
          { id: 'leads', label: 'Leads', collection: 'contacts', operation: 'count' },
          { id: 'by_source', label: 'By source', collection: 'contacts', operation: 'count', groupBy: 'source' },
          { id: 'by_status', label: 'By status', collection: 'contacts', operation: 'count', groupBy: 'status' },
        ],
      },
      {
        kind: 'table',
        id: 'messages',
        label: 'Website enquiries',
        path: '/messages',
        icon: 'mail',
        description: 'Scoped to website enquiries — other channels are refused, not hidden.',
        collection: 'contacts',
        operations: ['read', 'update', 'delete'],
        searchable: true,
        pageSize: 25,
        filters: [{ field: 'source', op: 'eq', value: 'website' }],
        fields: {
          read: ['id', 'name', 'email', 'subject', 'status', 'source', 'submitted_at', 'processed'],
          write: ['status', 'processed'],
        },
        defaultSort: { field: 'submitted_at', direction: 'desc' },
      },
      {
        kind: 'form',
        id: 'new_lead',
        label: 'Log lead',
        path: '/leads/new',
        collection: 'contacts',
        operations: ['create'],
        submitLabel: 'Log lead',
        fields: {
          read: ['id', 'name', 'email', 'subject', 'message', 'status', 'source'],
          write: ['name', 'email', 'subject', 'message', 'source', 'status'],
        },
      },
    ],
    menu: [
      { id: 'triage', label: 'Triage', path: '/triage', viewId: 'triage', icon: 'grid' },
      { id: 'messages', label: 'Enquiries', path: '/messages', viewId: 'messages', icon: 'mail' },
      { id: 'new_lead', label: 'Log lead', path: '/leads/new', viewId: 'new_lead' },
    ],
    roles: [
      {
        id: 'agent',
        label: 'Agent',
        views: [
          { viewId: 'triage', operations: ['read'] },
          {
            viewId: 'messages',
            operations: ['read', 'update'],
            readFields: ['id', 'name', 'email', 'subject', 'status', 'source', 'submitted_at', 'processed'],
            writeFields: ['status', 'processed'],
          },
          {
            viewId: 'new_lead',
            operations: ['create'],
            readFields: ['id', 'name', 'email', 'subject', 'message', 'status', 'source'],
            writeFields: ['name', 'email', 'subject', 'message', 'source', 'status'],
          },
        ],
      },
      {
        id: 'supervisor',
        label: 'Supervisor',
        description: 'Everything the agent can do, plus deletion.',
        views: [
          { viewId: 'triage', operations: ['read'] },
          { viewId: 'messages', operations: ['read', 'update', 'delete'] },
          { viewId: 'new_lead', operations: ['create'] },
        ],
      },
    ],
    members: [{ userId: '@inbox_agent', roleId: 'agent' }, { userId: '@inbox_supervisor', roleId: 'supervisor' }],
    defaultRoleId: 'agent',
  },

  {
    id: 'events_desk',
    name: 'Events Desk',
    description: 'Capacity and venue management, with per-member city scoping.',
    icon: 'calendar',
    theme: { mode: 'dark', palette: 'green' },
    views: [
      {
        kind: 'dashboard',
        id: 'stats',
        label: 'Stats',
        path: '/stats',
        icon: 'grid',
        fields: { read: [], write: [] },
        operations: ['read'],
        metrics: [
          { id: 'events', label: 'Events', collection: 'events', operation: 'count' },
          { id: 'capacity', label: 'Total capacity', collection: 'events', operation: 'sum', field: 'capacity' },
          { id: 'registered', label: 'Registered', collection: 'events', operation: 'sum', field: 'registered_count' },
          { id: 'by_status', label: 'By status', collection: 'events', operation: 'count', groupBy: 'status' },
        ],
      },
      {
        kind: 'table',
        id: 'my_city_events',
        label: 'My city',
        path: '/events',
        icon: 'calendar',
        description: 'Scoped by the member attribute `city` — the filter comes from the session, not the client.',
        collection: 'events',
        operations: ['read', 'update'],
        searchable: true,
        pageSize: 50,
        filters: [{ field: 'venue_city', op: 'eq', source: 'member.attributes.city' }],
        fields: {
          read: ['id', 'title', 'slug', 'status', 'capacity', 'registered_count', 'is_online', 'start_at', 'venue_name', 'venue_city'],
          write: ['capacity', 'venue_name'],
        },
        defaultSort: { field: 'start_at', direction: 'desc' },
      },
      {
        kind: 'table',
        id: 'all_events',
        label: 'All events',
        path: '/events/all',
        icon: 'grid',
        collection: 'events',
        operations: ['read', 'update'],
        searchable: true,
        pageSize: 50,
        filters: [],
        fields: {
          read: ['id', 'title', 'slug', 'status', 'capacity', 'registered_count', 'is_online', 'start_at', 'venue_name', 'venue_city'],
          write: ['capacity', 'venue_name', 'status'],
        },
        defaultSort: { field: 'start_at', direction: 'desc' },
      },
      {
        kind: 'form',
        id: 'new_event',
        label: 'Schedule event',
        path: '/events/new',
        collection: 'events',
        operations: ['create'],
        submitLabel: 'Schedule',
        fields: {
          read: ['id', 'title', 'slug', 'status', 'capacity', 'venue_name', 'venue_city', 'start_at'],
          write: ['title', 'slug', 'description', 'status', 'capacity', 'venue_name', 'venue_city', 'start_at'],
        },
      },
    ],
    menu: [
      { id: 'stats', label: 'Stats', path: '/stats', viewId: 'stats', icon: 'grid' },
      { id: 'my_city_events', label: 'My city', path: '/events', viewId: 'my_city_events', icon: 'calendar' },
      { id: 'all_events', label: 'All events', path: '/events/all', viewId: 'all_events' },
      { id: 'new_event', label: 'Schedule', path: '/events/new', viewId: 'new_event' },
    ],
    roles: [
      {
        id: 'coordinator',
        label: 'Coordinator',
        description: 'Sees only the events in their own city, via the member `city` attribute.',
        views: [
          { viewId: 'stats', operations: ['read'] },
          {
            viewId: 'my_city_events',
            operations: ['read', 'update'],
            readFields: ['id', 'title', 'status', 'capacity', 'registered_count', 'venue_name', 'venue_city', 'start_at'],
            writeFields: ['capacity', 'venue_name'],
          },
          {
            viewId: 'new_event',
            operations: ['create'],
            readFields: ['id', 'title', 'status', 'capacity', 'venue_name', 'venue_city', 'start_at'],
            writeFields: ['title', 'slug', 'description', 'status', 'capacity', 'venue_name', 'venue_city', 'start_at'],
          },
        ],
      },
      {
        id: 'regional',
        label: 'Regional manager',
        description: 'Every event, and may change a status.',
        views: [
          { viewId: 'stats', operations: ['read'] },
          { viewId: 'all_events', operations: ['read', 'update'] },
          { viewId: 'new_event', operations: ['create'] },
        ],
      },
      {
        id: 'auditor',
        label: 'Auditor',
        description: 'Read-only across every event.',
        views: [{ viewId: 'stats', operations: ['read'] }, { viewId: 'all_events', operations: ['read'] }],
      },
    ],
    // `city` drives the `my_city_events` view filter; a member without it would get
    // 400 PANEL_ATTRIBUTE_MISSING.
    members: [
      { userId: '@events_coordinator', roleId: 'coordinator', attributes: { city: 'Jakarta' } },
      { userId: '@events_regional', roleId: 'regional' },
    ],
    defaultRoleId: 'coordinator',
  },

  {
    id: 'showcase',
    name: 'Showcase',
    description: 'A read-only panel: featured work and customer voices.',
    icon: 'star',
    theme: { mode: 'dark', palette: 'violet' },
    views: [
      {
        kind: 'dashboard',
        id: 'highlights',
        label: 'Highlights',
        path: '/highlights',
        icon: 'grid',
        fields: { read: [], write: [] },
        operations: ['read'],
        metrics: [
          { id: 'projects', label: 'Featured projects', collection: 'projects', operation: 'count' },
          { id: 'latest_year', label: 'Latest year', collection: 'projects', operation: 'max', field: 'year' },
          { id: 'voices', label: 'Testimonials', collection: 'testimonials', operation: 'count' },
          { id: 'avg_rating', label: 'Average rating', collection: 'testimonials', operation: 'avg', field: 'rating' },
        ],
      },
      {
        kind: 'table',
        id: 'projects',
        label: 'Projects',
        path: '/projects',
        icon: 'star',
        collection: 'projects',
        operations: ['read'],
        searchable: true,
        pageSize: 20,
        filters: [{ field: 'is_featured', op: 'eq', value: true }],
        fields: { read: ['id', 'title', 'client', 'year', 'status', 'summary'], write: [] },
        defaultSort: { field: 'year', direction: 'desc' },
      },
      {
        kind: 'table',
        id: 'voices',
        label: 'Testimonials',
        path: '/testimonials',
        icon: 'heart',
        collection: 'testimonials',
        operations: ['read'],
        pageSize: 20,
        filters: [{ field: 'is_featured', op: 'eq', value: true }],
        fields: { read: ['id', 'author_name', 'role', 'company_name', 'quote', 'rating'], write: [] },
        defaultSort: { field: 'rating', direction: 'desc' },
      },
    ],
    menu: [
      { id: 'highlights', label: 'Highlights', path: '/highlights', viewId: 'highlights', icon: 'grid' },
      { id: 'projects', label: 'Projects', path: '/projects', viewId: 'projects', icon: 'star' },
      { id: 'voices', label: 'Testimonials', path: '/testimonials', viewId: 'voices', icon: 'heart' },
    ],
    roles: [
      {
        id: 'curator',
        label: 'Curator',
        views: [
          { viewId: 'highlights', operations: ['read'] },
          { viewId: 'projects', operations: ['read'] },
          { viewId: 'voices', operations: ['read'] },
        ],
      },
      { id: 'visitor', label: 'Visitor', views: [{ viewId: 'projects', operations: ['read'] }] },
    ],
    members: [{ userId: '@showcase_curator', roleId: 'curator' }, { userId: '@showcase_visitor', roleId: 'visitor' }],
    defaultRoleId: 'curator',
  },
]

/* -------------------------------------------------------------------- users */

const USERS = [
  { username: 'shop_operator', name: 'Shop Operator (sample)' },
  { username: 'shop_viewer', name: 'Shop Viewer (sample)' },
  { username: 'inbox_agent', name: 'Inbox Agent (sample)' },
  { username: 'inbox_supervisor', name: 'Inbox Supervisor (sample)' },
  { username: 'events_coordinator', name: 'Events Coordinator (sample)' },
  { username: 'events_regional', name: 'Events Regional (sample)' },
  { username: 'showcase_curator', name: 'Showcase Curator (sample)' },
  { username: 'showcase_visitor', name: 'Showcase Visitor (sample)' },
]

/* --------------------------------------------------------------------- main */

async function main() {
  const scope = `${LAND || 'default land'}${COLONY ? ` / ${COLONY}` : ''}`
  console.log(`Seeding sample panels against ${BASE} (${scope})`)

  const { data: session } = await api('/_auth/token', { method: 'POST', body: { key: ADMIN_KEY } })
  const admin = session.token

  const { data: privileges } = await api('/privileges?pageSize=100', { token: admin })
  const panelUser = privileges.find((p) => p.name === 'panel_user')
  if (!panelUser) throw new Error('The panel_user privilege is missing — bootstrap a land first')

  const { data: existingPanels } = await api('/_panels?pageSize=100', { token: admin })
  for (const panel of existingPanels) {
    if (!PANELS.some((p) => p.id === panel.id)) continue
    await api(`/_panels/${panel.id}`, { method: 'DELETE', token: admin })
    console.log(`  removed existing panel ${panel.id}`)
  }

  const { data: existingUsers } = await api('/_auth/users?pageSize=200', { token: admin })
  for (const user of existingUsers) {
    if (!user.name?.endsWith('(sample)')) continue
    await api(`/_auth/users/${user.id}`, { method: 'DELETE', token: admin })
    console.log(`  removed existing user ${user.username}`)
  }

  const userIds = {}
  for (const user of USERS) {
    const { data: created } = await api('/_auth/users', {
      method: 'POST',
      token: admin,
      body: { username: user.username, name: user.name, password: SAMPLE_PASSWORD, privilegeId: panelUser.id, isActive: true },
    })
    userIds[`@${user.username}`] = created.id
  }
  console.log(`  created ${USERS.length} panel_user accounts`)

  const created = []
  for (const panel of PANELS) {
    const definition = {
      ...panel,
      members: panel.members.map((member) => ({ ...member, userId: userIds[member.userId] })),
    }
    const { data } = await api('/_panels', { method: 'POST', token: admin, body: { definition } })
    const views = data.views.length
    const roles = data.roles.length
    const members = data.members.length
    console.log(`  created ${data.id.padEnd(12)} ${views} views · ${roles} roles · ${members} members · ${data.name}`)
    created.push(data)
  }

  console.log(`\n${created.length} panels ready. Demo users (password: ${SAMPLE_PASSWORD}):`)
  for (const user of USERS) console.log(`  ${user.username}`)

  const sample = await api('/_auth/login', {
    method: 'POST',
    body: { username: USERS[0].username, password: SAMPLE_PASSWORD },
  })
  console.log('\nGenerated-app env (mint your own token per user, never reuse the admin key):')
  console.log(`  VITE_PANEL_API_URL=${BASE}/api`)
  console.log(`  VITE_PANEL_API_TOKEN=${sample.data.token}`)
  console.log(`  VITE_PANEL_LAND=${LAND || '(default scope)'}`)
  console.log(`  VITE_PANEL_COLONY=${COLONY || '(default colony)'}`)
  console.log(`  VITE_PANEL_DEFAULT_VIEW=${created[0]?.views[0]?.id ?? ''}`)
}

main().catch((error) => {
  console.error(`\nSeed failed: ${error.message}`)
  process.exit(1)
})
