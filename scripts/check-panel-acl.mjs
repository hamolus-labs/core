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
 * Panel ACL regression check — verifies a panel user can neither read nor write
 * records outside its view's filters, and cannot change a filter field to slip
 * into scope.
 *
 *   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me node packages/core/scripts/check-panel-acl.mjs
 *
 * Self-cleaning and non-destructive: every record, panel and user it creates is
 * deleted at the end, and when the default land has no collection able to drive
 * the checks it provisions a throwaway one and drops that too. It never modifies
 * or deletes a collection it did not create.
 *
 * Point it at real seeded data with `COLLECTION=<name>`. Otherwise it uses
 * `contacts` when that collection can drive the checks, and provisions its own
 * `acl_probe_<stamp>` collection when it cannot. Exits non-zero on the first
 * failed expectation.
 */
const BASE = process.env.BASE ?? 'http://localhost:8787'
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
/** Reassigned to a throwaway collection when the configured one cannot drive the checks. */
let COLLECTION = process.env.COLLECTION ?? 'contacts'
/** True only for a collection this script created, so cleanup never drops user data. */
let ownedCollection = false

let pass = 0
const failures = []
const ok = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const json = async (res) => res.json().catch(() => ({}))
const admin = await json(
  await fetch(`${BASE}/api/_auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: ADMIN_KEY }),
  }),
)
if (!admin?.data?.token) {
  console.error(`Could not mint an admin token from ${BASE} — is the core running and ADMIN_KEY correct?`)
  process.exit(1)
}
const AH = { authorization: `Bearer ${admin.data.token}`, 'content-type': 'application/json' }
const areq = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...AH, ...(init.headers || {}) } })

const stamp = Date.now()
const panelId = `acl_check_${stamp}`
const username = `acl_check_${stamp}`
const created = { record: null, control: null, user: null, panel: null }

const cleanup = async () => {
  if (created.record) await areq(`/api/${COLLECTION}/${created.record}`, { method: 'DELETE' })
  if (created.control) await areq(`/api/${COLLECTION}/${created.control}`, { method: 'DELETE' })
  if (created.panel) await areq(`/api/_panels/${created.panel}`, { method: 'DELETE' })
  if (created.user) await areq(`/api/_auth/users/${created.user}`, { method: 'DELETE' })
  if (ownedCollection) await areq(`/api/_meta/collections/${COLLECTION}`, { method: 'DELETE' })
}

/**
 * Whether a collection can drive the checks: it needs a field to filter on (an
 * enum, or a string), a second string field to mutate for the drift test, and no
 * required belongsTo relation, which the script has no value for.
 */
const usable = (fields) => {
  const filter = fields.find((f) => f.enumValues?.length) ?? fields.find((f) => f.type === 'string')
  if (!filter) return 'no enum or string field to filter on'
  if (!fields.some((f) => f.name !== filter.name && f.type === 'string')) {
    return 'needs a second string field to mutate in the drift test'
  }
  const relation = fields.find((f) => f.required && f.type === 'relation' && f.relation?.kind === 'belongsTo')
  if (relation) return `has a required belongsTo relation (${relation.name})`
  return null
}

try {
  const privileges = (await json(await areq('/api/privileges?pageSize=100'))).data ?? []
  const panelUser = privileges.find((p) => p.name === 'panel_user')
  if (!panelUser) throw new Error('The `panel_user` role is missing from the default land')

  const user = await json(
    await areq('/api/_auth/users', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'Sup3rSecret!', privilegeId: panelUser.id, name: 'ACL Check' }),
    }),
  )
  created.user = user?.data?.id ?? null
  const login = await json(
    await fetch(`${BASE}/api/_auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'Sup3rSecret!' }),
    }),
  )
  const UH = { authorization: `Bearer ${login?.data?.token}`, 'content-type': 'application/json' }
  const ureq = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...UH, ...(init.headers || {}) } })

  // Pick a field to filter on (prefer an enum, fall back to the first string-ish
  // field) and derive a fixture that satisfies every required field of the
  // collection, so the check works against any seeded collection.
  // Prefer a real collection (so the check runs against seeded data); fall back to
  // provisioning a throwaway one, which cleanup drops again.
  let definition = (await json(await areq(`/api/_meta/collections/${COLLECTION}`))).data
  let unusable = usable(definition?.fields ?? [])
  if (unusable) {
    if (process.env.COLLECTION) {
      throw new Error(`COLLECTION=${process.env.COLLECTION} ${unusable} — it was requested explicitly, so no fallback is used`)
    }
    COLLECTION = `acl_probe_${stamp}`
    ownedCollection = true
    await areq(`/api/_meta/collections/${COLLECTION}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: COLLECTION,
        label: 'ACL Check probe',
        description: 'Throwaway collection for check-panel-acl; safe to delete.',
        fields: [
          { name: 'subject', type: 'string', label: 'Subject', required: true },
          { name: 'body', type: 'string', label: 'Body' },
          { name: 'lane', type: 'enum', label: 'Lane', enumValues: ['in-scope', `out-of-scope-${stamp}`] },
        ],
      }),
    })
    definition = (await json(await areq(`/api/_meta/collections/${COLLECTION}`))).data
    unusable = usable(definition?.fields ?? [])
    if (unusable) throw new Error(`the provisioned ${COLLECTION} ${unusable}`)
    ok(`provisioned a throwaway ${COLLECTION} collection to drive the checks`, true)
  }

  const fields = definition?.fields ?? []
  const value = {
    string: 'Out of scope row',
    text: 'Out of scope row',
    email: 'acl-check@example.com',
    url: 'https://example.com',
    slug: `acl-check-${stamp}`,
    number: 1,
    price: 1000,
    boolean: false,
    date: '2026-01-01',
    datetime: '2026-01-01T00:00:00.000Z',
  }
  const fixture = {}
  for (const f of fields) {
    if (!f.required || !(f.type in value)) {
      if (f.required && f.type === 'enum' && f.enumValues?.length) fixture[f.name] = f.enumValues[0]
      continue
    }
    fixture[f.name] = value[f.type]
  }
  const unsupported = fields.filter((f) => f.required && f.type === 'relation' && f.relation?.kind === 'belongsTo')
  if (unsupported.length) {
    throw new Error(`${COLLECTION} has required relation field(s) (${unsupported.map((f) => f.name).join(', ')}) — point COLLECTION at another collection`)
  }
  const filterField = fields.find((f) => f.enumValues?.length)?.name ?? fields.find((f) => f.type === 'string')?.name
  if (!filterField) throw new Error(`${COLLECTION} has no enum or string field to filter on`)
  const inScope = fields.find((f) => f.name === filterField)?.enumValues?.[0] ?? 'in-scope'
  const outOfScope = fields.find((f) => f.name === filterField)?.enumValues?.[1] ?? `out-of-scope-${stamp}`
  const driftField = fields.find((f) => f.name !== filterField && f.type === 'string')?.name ?? filterField
  if (driftField === filterField) throw new Error(`${COLLECTION} needs a second string field to mutate in the drift test`)

  const record = await json(
    await areq(`/api/${COLLECTION}`, {
      method: 'POST',
      body: JSON.stringify({ ...fixture, [filterField]: outOfScope }),
    }),
  )
  created.record = record?.data?.id ?? null
  if (!created.record) throw new Error(`Could not create the fixture record: ${JSON.stringify(record).slice(0, 200)}`)

  // Control record that IS in scope, so the refusals below cannot pass just
  // because the view is broken.
  const control = await json(
    await areq(`/api/${COLLECTION}`, {
      method: 'POST',
      body: JSON.stringify({ ...fixture, [filterField]: inScope, [driftField]: `${fixture[driftField]} (in scope)` }),
    }),
  )
  created.control = control?.data?.id ?? null
  if (!created.control) throw new Error(`Could not create the control record: ${JSON.stringify(control).slice(0, 200)}`)

  const readFields = ['id', filterField, driftField]
  const writeFields = [filterField, driftField]
  const view = {
    id: 'inbox',
    kind: 'table',
    label: 'Inbox',
    path: `/${COLLECTION}`,
    collection: COLLECTION,
    searchable: true,
    pageSize: 20,
    form: true,
    fields: { read: readFields, write: writeFields },
    operations: ['read', 'update'],
    filters: [{ field: filterField, op: 'eq', value: inScope }],
  }
  const manifest = {
    id: panelId,
    name: 'ACL Check',
    views: [view],
    menu: [{ id: 'inbox', label: 'Inbox', path: `/${COLLECTION}`, viewId: 'inbox' }],
    roles: [{ id: 'staff', label: 'Staff', views: [{ viewId: 'inbox', operations: ['read', 'update'], readFields, writeFields }] }],
    members: [{ userId: created.user, roleId: 'staff', attributes: { source: 'email' } }],
    defaultRoleId: 'staff',
  }
  const put = await areq(`/api/_panels/${panelId}`, { method: 'PUT', body: JSON.stringify({ definition: manifest }) })
  ok('panel manifest is accepted', put.status === 200, `status=${put.status} ${(await put.text()).slice(0, 200)}`)
  if (put.status !== 200) throw new Error('Panel manifest rejected — cannot continue')
  created.panel = panelId

  const listed = await json(await ureq(`/api/_panels/${panelId}/views/inbox/records`))
  const rows = listed.data ?? []
  ok('the in-scope control record is listed', rows.some((r) => r.id === created.control), `total=${listed.meta?.total}`)
  ok('out-of-scope record is not listed', !rows.some((r) => r.id === created.record), `total=${listed.meta?.total}`)
  ok(
    'only permitted fields are returned',
    rows.every((r) => Object.keys(r).every((k) => readFields.includes(k))),
    `unexpected keys: ${[...new Set(rows.flatMap((r) => Object.keys(r)).filter((k) => !readFields.includes(k)))].join(', ') || 'none'}`,
  )

  const patchControl = await ureq(`/api/_panels/${panelId}/views/inbox/records/${created.control}`, {
    method: 'PATCH',
    body: JSON.stringify({ [driftField]: 'Updated in scope' }),
  })
  ok('update of the in-scope record is allowed', patchControl.status === 200, `status=${patchControl.status}`)

  const readDirect = await ureq(`/api/_panels/${panelId}/views/inbox/records/${created.record}`)
  ok('direct read of an out-of-scope record is refused', readDirect.status === 404, `status=${readDirect.status}`)

  const patchOut = await ureq(`/api/_panels/${panelId}/views/inbox/records/${created.record}`, {
    method: 'PATCH',
    body: JSON.stringify({ [driftField]: 'PWNED by panel user' }),
  })
  ok('update of an out-of-scope record is refused', patchOut.status === 404, `status=${patchOut.status}`)

  const patchDrift = await ureq(`/api/_panels/${panelId}/views/inbox/records/${created.control}`, {
    method: 'PATCH',
    body: JSON.stringify({ [filterField]: outOfScope }),
  })
  ok(
    'drifting an in-scope record out of the filter is refused',
    patchDrift.status === 403,
    `status=${patchDrift.status} ${JSON.stringify(await patchDrift.json()).slice(0, 160)}`,
  )

  const afterControl = await json(await areq(`/api/${COLLECTION}/${created.control}`))
  ok('the in-scope record kept its filter value', afterControl?.data?.[filterField] === inScope, JSON.stringify({ [filterField]: afterControl?.data?.[filterField] }))

  const patchDriftOos = await ureq(`/api/_panels/${panelId}/views/inbox/records/${created.record}`, {
    method: 'PATCH',
    body: JSON.stringify({ [filterField]: inScope }),
  })
  ok(
    'claiming scope by supplying the filter value is refused',
    !patchDriftOos.ok,
    `status=${patchDriftOos.status} ${JSON.stringify(await patchDriftOos.json()).slice(0, 160)}`,
  )

  const after = await json(await areq(`/api/${COLLECTION}/${created.record}`))
  ok(
    'the stored record is untouched',
    after?.data?.[filterField] === outOfScope && after?.data?.[driftField] === fixture[driftField],
    JSON.stringify({ [driftField]: after?.data?.[driftField], [filterField]: after?.data?.[filterField] }),
  )

  const deleteOos = await ureq(`/api/_panels/${panelId}/views/inbox/records/${created.record}`, { method: 'DELETE' })
  ok('delete of an out-of-scope record is refused', !deleteOos.ok, `status=${deleteOos.status}`)
  const still = await areq(`/api/${COLLECTION}/${created.record}`)
  ok('the record still exists after the refused delete', still.status === 200, `status=${still.status}`)
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`)
  failures.push('unexpected error')
} finally {
  await cleanup()
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
