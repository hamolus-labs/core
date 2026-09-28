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
 * Colony-header resolution regression check.
 *
 * Why this exists: `resolveRequestScope(c)` takes an optional `Db` handle, and
 * when it was absent the registry lookup was skipped entirely — the colony
 * header was trusted verbatim and the parent land fell back to the default.
 * The auth middleware resolves with a handle, so the *same request* produced two
 * different scopes: a land-scoped one for the middleware and a default-land one
 * for the route. A write then used the route's value, so a panel created with
 * `x-colony` owned by another land was stored in the default land's namespace
 * (`land=root_lnd, colony=<other land's colony>`) while the collection it
 * referenced was registered under the owning land. Land isolation was void.
 *
 * The resolver now builds a handle from the binding when the caller has none.
 * This check pins that behavior:
 *   1. a colony header with no land header resolves to the colony's OWNING land,
 *   2. the write actually lands in that land (not the default land),
 *   3. an unregistered colony is rejected instead of inventing a scope,
 *   4. a colony cannot be paired with a land that does not own it,
 *   5. a land-scoped token cannot be used to reach another land.
 *
 *   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me \
 *     node packages/core/scripts/check-scope-colony-resolution.mjs
 *
 * Self-cleaning and non-destructive: it creates its own land/colony/collection
 * and removes them again, touching no shared state.
 */
const BASE = process.env.BASE ?? 'http://localhost:8787'
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
const STAMP = process.env.SCOPE_CHECK_STAMP ?? `scope_chk_${Date.now().toString(36)}`
const LAND_A = `${STAMP}_a_lnd`
const LAND_B = `${STAMP}_b_lnd`
const COLONY_A = `${STAMP}_a_cny`
const COLONY_B = `${STAMP}_b_cny`
const PANEL = `${STAMP}_panel`
const COLLECTION = `${STAMP}_notes`

let pass = 0
const failures = []
const ok = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`)
  }
}
const json = async (res) => res.json().catch(() => ({}))

if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(BASE).hostname)) {
  console.error('ERROR  Refusing to run against a non-loopback BASE.')
  process.exit(1)
}

const bootstrap = await json(
  await fetch(`${BASE}/api/_auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: ADMIN_KEY }),
  }),
)
const admin = bootstrap.data?.token
if (!admin) {
  console.error(`ERROR  Could not mint an admin token from ${BASE} — is the core running and ADMIN_KEY correct?`)
  process.exit(1)
}
const areq = (path, init = {}, token = admin) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })
const putJson = async (path, body, headers = {}) => {
  const res = await areq(path, { method: 'PUT', body: JSON.stringify(body), headers })
  return [res.status, await json(res)]
}

// An admin-key session carries no land claim, so `x-colony` alone decides the
// scope — exactly the case that used to fall back to the default land.
const manifest = (collection, members = []) => ({
  id: PANEL,
  name: 'Scope Check',
  views: [
    {
      id: 'rows',
      label: 'Rows',
      path: '/rows',
      kind: 'table',
      collection,
      operations: ['read'],
      fields: { read: ['name'], write: [] },
    },
  ],
  roles: [{ id: 'role', label: 'Role', views: [{ viewId: 'rows', operations: ['read'] }] }],
  defaultRoleId: 'role',
  members,
  menu: [],
})
const collection = { name: COLLECTION, label: 'Notes', fields: [{ name: 'name', label: 'Name', type: 'string', required: true }] }

try {
  const created = async (label, path, body, headers) => {
    const [status, body_] = await putJson(path, body, headers)
    ok(label, [200, 201].includes(status), `status ${status} ${JSON.stringify(body_)}`)
  }
  await created('land A is registered', `/api/_meta/universe/lands/${LAND_A}`, { label: 'Scope Check A' })
  await created('land B is registered', `/api/_meta/universe/lands/${LAND_B}`, { label: 'Scope Check B' })
  await created('colony A is registered under land A', `/api/_meta/universe/colonies/${COLONY_A}`, { landId: LAND_A, label: 'A' })
  await created('colony B is registered under land B', `/api/_meta/universe/colonies/${COLONY_B}`, { landId: LAND_B, label: 'B' })
  await created('the target collection is registered in colony A', `/api/_meta/collections/${COLLECTION}`, collection, { 'x-colony': COLONY_A })

  // A `panel_user` in colony A gets a token scoped to land A: it may read the
  // panel in its own colony, and must be refused when it names another colony.
  const privileges = await json(await areq('/api/privileges', { headers: { 'x-colony': COLONY_A } }))
  const panelUser = (privileges.data ?? []).find((p) => p.name === 'panel_user')
  ok('the panel_user privilege is bootstrapped in colony A', Boolean(panelUser), JSON.stringify(privileges).slice(0, 120))

  const userRes = await areq(
    '/api/_auth/users',
    {
      method: 'POST',
      headers: { 'x-colony': COLONY_A },
      body: JSON.stringify({
        username: `${STAMP}_u`,
        name: 'Scope Check User',
        password: 'ScopeCheck!123',
        privilegeId: panelUser?.id,
      }),
    },
  )
  const userBody = await json(userRes)
  ok('a panel user is created in colony A', userRes.status === 201 || userRes.status === 200, `status ${userRes.status} ${JSON.stringify(userBody).slice(0, 120)}`)
  // members[].userId is the user row id, which the runtime matches against the
  // token subject — not the username.
  const userId = userBody.data?.id
  ok('the created user has an id to reference', typeof userId === 'string' && userId.length > 0, JSON.stringify(userBody).slice(0, 120))

  const login = await json(
    await fetch(`${BASE}/api/_auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `${STAMP}_u`, password: 'ScopeCheck!123' }),
    }),
  )
  const scopedToken = login.data?.token
  ok('a scoped panel session can be minted', Boolean(scopedToken), JSON.stringify(login).slice(0, 160))

  /* -- 1 + 2. the colony header alone must resolve to its owning land -------- */
  const [status, body] = await putJson(
    `/api/_panels/${PANEL}`,
    { definition: manifest(COLLECTION, [{ userId, roleId: 'role' }]) },
    { 'x-colony': COLONY_A },
  )
  ok(
    'the panel is accepted in the colony scope',
    status === 200,
    `status ${status} ${JSON.stringify(body).slice(0, 160)}`,
  )

  const allowed = await areq(`/api/_panels/${PANEL}/views/rows/records`, { headers: { 'x-colony': COLONY_A } }, scopedToken)
  ok(
    'that session reads its own colony scope',
    allowed.status === 200,
    `status ${allowed.status} ${JSON.stringify(await json(allowed)).slice(0, 120)}`,
  )

  const denied = await areq(`/api/_panels/${PANEL}/views/rows/records`, { headers: { 'x-colony': COLONY_B } }, scopedToken)
  const deniedBody = await json(denied)
  ok(
    'that session is refused when it names another land\'s colony',
    denied.status === 403,
    `status ${denied.status} ${JSON.stringify(deniedBody).slice(0, 120)}`,
  )

  /* -- 3. an unregistered colony must not invent a scope ------------------- */
  const phantom = await areq(`/api/_panels/${PANEL}`, { headers: { 'x-colony': `${STAMP}_nope_cny` } })
  const phantomBody = await json(phantom)
  ok(
    'an unregistered colony header is rejected',
    phantom.status === 404,
    `status ${phantom.status} ${JSON.stringify(phantomBody).slice(0, 120)}`,
  )

  /* -- 4. a colony cannot be paired with a land that does not own it -------- */
  const crossed = await areq(`/api/_panels/${PANEL}`, { headers: { 'x-colony': COLONY_A, 'x-land': LAND_B } })
  const crossedBody = await json(crossed)
  ok(
    "colony A cannot be addressed with land B's header",
    crossed.status === 400 || crossed.status === 403,
    `status ${crossed.status} ${JSON.stringify(crossedBody).slice(0, 120)}`,
  )

  /* -- 5. an explicit land header is honoured and cross-checked ------------- */
  const explicit = await areq(`/api/_panels/${PANEL}`, { headers: { 'x-land': LAND_A, 'x-colony': COLONY_A } })
  ok(
    'the matching land+colony pair still resolves',
    explicit.status === 200,
    `status ${explicit.status} ${JSON.stringify(await json(explicit)).slice(0, 120)}`,
  )
} catch (error) {
  ok(`the run completed without throwing (${error.message})`, false, error.stack)
} finally {
  await areq(`/api/_panels/${PANEL}`, { method: 'DELETE', headers: { 'x-colony': COLONY_A } }).catch(() => {})
  await areq(`/api/_meta/collections/${COLLECTION}`, { method: 'DELETE', headers: { 'x-colony': COLONY_A } }).catch(() => {})
  await areq(`/api/_auth/users/${STAMP}_u`, { method: 'DELETE', headers: { 'x-colony': COLONY_A } }).catch(() => {})
  for (const colony of [COLONY_A, COLONY_B]) {
    await areq(`/api/_meta/universe/colonies/${colony}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const land of [LAND_A, LAND_B]) {
    await areq(`/api/_meta/universe/lands/${land}`, { method: 'DELETE' }).catch(() => {})
  }
  const lands = await json(await areq('/api/_meta/universe/lands'))
  const colonies = await json(await areq('/api/_meta/universe/colonies'))
  ok(
    'the probe land/colony/user are gone',
    ![...lands.data, ...colonies.data].some((x) => x.id.startsWith(STAMP)),
    `${lands.data?.map?.((x) => x.id).join(',')} | ${colonies.data?.map?.((x) => x.id).join(',')}`,
  )
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
