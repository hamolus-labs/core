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
 * Land/colony access check for the key/value configuration endpoints.
 *
 * Why this exists: a `_configs` row is identified by `(land, colony, key)`, so
 * `GET`/`PUT`/`DELETE /api/_config` all have to answer "which colony is this?" before
 * they touch SQL. The `?land=` / `?colony=` query that drives the console's selector is
 * a *request*, and the mistake it invites is treating it as a grant — a land admin
 * naming another land's colony, or a colony admin naming its sibling. Either one is a
 * silent cross-tenant write, and neither shows up in a typecheck.
 *
 * What it pins:
 *   1. no query returns exactly what the session may see (a colony admin sees one
 *      colony, a land admin sees its whole land) — never the platform,
 *   2. `?colony=` narrows to that colony, `?land=` widens to that land's colonies,
 *   3. the same key in two colonies is two rows, not an upsert into the wrong one,
 *   4. a land admin is refused another land, and its colonies, by name,
 *   5. a colony admin is refused a sibling colony, and cannot widen with `?land=`,
 *   6. a land admin must NAME a colony for a single-entry read or write — a land owns
 *      colonies rather than being one, so guessing would write into an unmentioned one,
 *   7. a colony that is not registered is refused rather than silently created.
 *
 *   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me \
 *     node packages/core/scripts/check-config-scope-acl.mjs
 *
 * Self-cleaning: it registers its own stamped land, colonies, users and rows, and
 * removes all of them again.
 */
const BASE = process.env.BASE ?? 'http://localhost:8787'
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
const STAMP = process.env.CONFIG_SCOPE_STAMP ?? `cfgacl_${Date.now().toString(36)}`
const LAND_A = `${STAMP}_a_lnd`
const LAND_B = `${STAMP}_b_lnd`
const COLONY_A = `${STAMP}_a_cny`
const COLONY_SIB = `${STAMP}_as_cny`
const COLONY_B = `${STAMP}_b_cny`
const UNREGISTERED = `${STAMP}_ghost_cny`
const PASSWORD = 'ConfigAcl!123'
const KEY = `${STAMP}.shared`
const KEY_2 = `${STAMP}.only_a`

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
const putJson = async (path, body, headers = {}, token = admin) => {
  const res = await areq(path, { method: 'PUT', body: JSON.stringify(body), headers }, token)
  return [res.status, await json(res)]
}
const keysOf = (body) => (body.data ?? []).map((e) => e.key).sort()
const login = async (username) => {
  const res = await json(
    await fetch(`${BASE}/api/_auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
  )
  return res.data?.token
}

try {
  const created = async (label, path, body, headers = {}) => {
    const [status, res] = await putJson(path, body, headers)
    ok(label, [200, 201].includes(status), `status ${status} ${JSON.stringify(res)}`)
  }
  await created('land A is registered', `/api/_meta/universe/lands/${LAND_A}`, { label: 'Config ACL A' })
  await created('land B is registered', `/api/_meta/universe/lands/${LAND_B}`, { label: 'Config ACL B' })
  await created('colony A is registered', `/api/_meta/universe/colonies/${COLONY_A}`, { landId: LAND_A, label: 'A' })
  await created('a sibling colony is registered', `/api/_meta/universe/colonies/${COLONY_SIB}`, { landId: LAND_A, label: 'A sibling' })
  await created("colony B is registered under land B", `/api/_meta/universe/colonies/${COLONY_B}`, { landId: LAND_B, label: 'B' })

  // The privilege ids are records, not names, so they have to be read out of the
  // collection the way a console would.
  const privileges = await json(await areq(`/api/privileges?pageSize=100`, { headers: { 'x-colony': COLONY_A } }))
  const landAdmin = (privileges.data ?? []).find((p) => p.name === 'land_admin')
  const colonyAdmin = (privileges.data ?? []).find((p) => p.name === 'admin')
  ok('the land_admin privilege is available', Boolean(landAdmin), JSON.stringify(privileges).slice(0, 140))
  ok('the colony admin privilege is available', Boolean(colonyAdmin), JSON.stringify(privileges).slice(0, 140))

  const mkUser = async (username, privilegeId, colony) => {
    const res = await json(
      await areq('/api/_auth/users', {
        method: 'POST',
        headers: { 'x-colony': colony },
        body: JSON.stringify({ username, name: username, password: PASSWORD, privilegeId }),
      }),
    )
    return res.data?.id
  }
  const landUser = await mkUser(`${STAMP}_land`, landAdmin?.id, COLONY_A)
  const colonyUser = await mkUser(`${STAMP}_colony`, colonyAdmin?.id, COLONY_A)
  const otherLandUser = await mkUser(`${STAMP}_other`, landAdmin?.id, COLONY_B)
  ok('a land admin is created in colony A', typeof landUser === 'string', String(landUser))
  ok('a colony admin is created in colony A', typeof colonyUser === 'string', String(colonyUser))
  ok('a land admin is created in land B', typeof otherLandUser === 'string', String(otherLandUser))

  const landToken = await login(`${STAMP}_land`)
  const colonyToken = await login(`${STAMP}_colony`)
  const otherToken = await login(`${STAMP}_other`)
  ok('a land-scoped session can be minted', Boolean(landToken))
  ok('a colony-scoped session can be minted', Boolean(colonyToken))
  ok('a second land-scoped session can be minted', Boolean(otherToken))

  // Rows, written as the platform admin so the fixture does not depend on the very
  // access rules it is about to assert.
  await putJson(`/api/_config/${KEY}?colony=${COLONY_A}`, { key: KEY, value: 'in-a', description: 'colony A' })
  await putJson(`/api/_config/${KEY}?colony=${COLONY_SIB}`, { key: KEY, value: 'in-sibling', description: 'colony A sibling' })
  await putJson(`/api/_config/${KEY_2}?colony=${COLONY_A}`, { key: KEY_2, value: { only: 'a' } })
  await putJson(`/api/_config/${KEY}?colony=${COLONY_B}`, { key: KEY, value: 'in-b', description: 'land B' })

  /* -- 1. the default read is exactly the session's reach ------------------- */
  const colonyAll = await areq('/api/_config', {}, colonyToken)
  const colonyAllBody = await json(colonyAll)
  ok('a colony admin reads its own colony with no query', colonyAll.status === 200, `status ${colonyAll.status}`)
  ok(
    'a colony admin sees only its own colony\'s rows',
    keysOf(colonyAllBody).join(',') === [KEY, KEY_2].sort().join(','),
    keysOf(colonyAllBody).join(','),
  )
  ok(
    'every row a colony admin gets carries its own colony id',
    (colonyAllBody.data ?? []).every((e) => e.colony === COLONY_A),
    [...new Set((colonyAllBody.data ?? []).map((e) => e.colony))].join(','),
  )

  const landAll = await json(await areq('/api/_config', {}, landToken))
  // Three rows, not two: `KEY` was written into colony A *and* its sibling, and a land
  // admin is supposed to see both copies.
  ok(
    'a land admin sees both colonies\' rows with no query',
    (landAll.data ?? []).length === 3,
    `${(landAll.data ?? []).length} rows: ${keysOf(landAll).join(',')}`,
  )
  const coloniesSeen = [...new Set((landAll.data ?? []).map((e) => e.colony))].sort()
  ok(
    'those rows span the whole land, not one colony',
    coloniesSeen.join(',') === [COLONY_A, COLONY_SIB].sort().join(','),
    coloniesSeen.join(','),
  )

  /* -- 2. ?colony= narrows, ?land= widens ------------------------------------ */
  const narrowed = await json(await areq(`/api/_config?colony=${COLONY_SIB}`, {}, landToken))
  ok('a land admin narrows to one of its colonies', narrowed.data?.length === 1, JSON.stringify(narrowed).slice(0, 140))
  ok('the narrowed row is the sibling\'s own value', narrowed.data?.[0]?.value === 'in-sibling', JSON.stringify(narrowed).slice(0, 140))

  const widened = await json(await areq(`/api/_config?land=${LAND_A}`, {}, landToken))
  ok('a land admin widens to its whole land', (widened.data ?? []).length === 3, `${(widened.data ?? []).length} rows`)

  /* -- 3. the same key in two colonies is two rows --------------------------- */
  const a = await json(await areq(`/api/_config/${KEY}?colony=${COLONY_A}`, {}, landToken))
  const sib = await json(await areq(`/api/_config/${KEY}?colony=${COLONY_SIB}`, {}, landToken))
  ok('the same key holds a different value per colony', a.data?.value === 'in-a' && sib.data?.value === 'in-sibling', `${a.data?.value} / ${sib.data?.value}`)
  ok('a single-entry read reports the colony it came from', a.data?.colony === COLONY_A && a.data?.land === LAND_A, `${a.data?.land}/${a.data?.colony}`)

  /* -- 4. another land is out of reach by name ------------------------------ */
  const crossLand = await areq(`/api/_config?land=${LAND_B}`, {}, landToken)
  ok('a land admin is refused another land by name', crossLand.status === 403, `status ${crossLand.status} ${JSON.stringify(await json(crossLand)).slice(0, 140)}`)
  const crossColony = await areq(`/api/_config?colony=${COLONY_B}`, {}, landToken)
  ok("a land admin is refused another land's colony by name", crossColony.status === 403, `status ${crossColony.status} ${JSON.stringify(await json(crossColony)).slice(0, 140)}`)
  const crossWrite = await putJson(`/api/_config/${KEY}?colony=${COLONY_B}`, { key: KEY, value: 'stolen' }, {}, landToken)
  ok('a land admin cannot write into another land', crossWrite[0] === 403, `status ${crossWrite[0]} ${JSON.stringify(crossWrite[1]).slice(0, 140)}`)

  /* -- 5. a colony admin cannot widen or reach a sibling --------------------- */
  const siblingRead = await areq(`/api/_config?colony=${COLONY_SIB}`, {}, colonyToken)
  ok('a colony admin is refused its sibling colony', siblingRead.status === 403, `status ${siblingRead.status}`)
  const siblingWrite = await putJson(`/api/_config/${KEY}?colony=${COLONY_SIB}`, { key: KEY, value: 'stolen' }, {}, colonyToken)
  ok('a colony admin cannot write into its sibling', siblingWrite[0] === 403, `status ${siblingWrite[0]}`)
  const widenSelf = await json(await areq(`/api/_config?land=${LAND_A}`, {}, colonyToken))
  ok(
    'a colony admin naming its own land still only sees its own colony',
    (widenSelf.data ?? []).every((e) => e.colony === COLONY_A),
    JSON.stringify(widenSelf).slice(0, 160),
  )

  /* -- 6. a land admin must name the colony it writes to --------------------- */
  const ambiguousGet = await areq(`/api/_config/${KEY}`, {}, landToken)
  ok('a land admin gets SCOPE_REQUIRED instead of a guessed colony', ambiguousGet.status === 400, `status ${ambiguousGet.status}`)
  ok('…and the error names the parameter', String((await json(ambiguousGet)).error?.message ?? '').includes('colony='), JSON.stringify(await json(ambiguousGet)).slice(0, 160))
  const ambiguousPut = await putJson(`/api/_config/${KEY}`, { key: KEY, value: 'guessed' }, {}, landToken)
  ok('a land admin cannot upsert without naming a colony', ambiguousPut[0] === 400, `status ${ambiguousPut[0]}`)

  const namedPut = await putJson(`/api/_config/${STAMP}.newname?colony=${COLONY_SIB}`, { key: `${STAMP}.newname`, value: { ok: true } }, {}, landToken)
  ok('a land admin writes once it names a colony of its land', namedPut[0] === 200, `status ${namedPut[0]} ${JSON.stringify(namedPut[1]).slice(0, 140)}`)
  ok('the new row carries the named colony', namedPut[1]?.data?.colony === COLONY_SIB, JSON.stringify(namedPut[1]).slice(0, 140))

  /* -- 7. an unregistered colony is refused ---------------------------------- */
  const ghost = await areq(`/api/_config?colony=${UNREGISTERED}`, {}, landToken)
  ok('an unregistered colony is refused, not invented', ghost.status === 404, `status ${ghost.status} ${JSON.stringify(await json(ghost)).slice(0, 140)}`)

  /* -- a mismatched land/colony pair is refused, not silently trusted --------- */
  const crossed = await areq(`/api/_config?land=${LAND_B}&colony=${COLONY_A}`, {}, admin)
  ok('a colony cannot be paired with a land that does not own it', crossed.status === 400 || crossed.status === 403, `status ${crossed.status} ${JSON.stringify(await json(crossed)).slice(0, 140)}`)

  /* -- the platform admin keeps its reach ------------------------------------ */
  const platform = await json(await areq('/api/_config'))
  const platformColonies = new Set((platform.data ?? []).map((e) => e.colony))
  ok('the platform admin still reads every land', platformColonies.has(COLONY_A) && platformColonies.has(COLONY_B), [...platformColonies].join(','))
  const platformWrite = await putJson(`/api/_config/${STAMP}.platform?colony=${COLONY_B}`, { key: `${STAMP}.platform`, value: 1 })
  ok('the platform admin can write into any colony', platformWrite[0] === 200, `status ${platformWrite[0]}`)

  /* -- the entry shape no longer carries a scope column ---------------------- */
  const sample = platform.data?.[0]
  ok('an entry reports land and colony', typeof sample?.land === 'string' && typeof sample?.colony === 'string', JSON.stringify(sample).slice(0, 160))
  ok('an entry no longer reports a scope', sample !== undefined && !('scope' in sample), JSON.stringify(sample).slice(0, 160))
  const scopeBody = await putJson(`/api/_config/${STAMP}.scoped`, { key: `${STAMP}.scoped`, value: 1, scope: 'site' })
  ok('a body carrying the old scope field is rejected', scopeBody[0] === 400, `status ${scopeBody[0]} ${JSON.stringify(scopeBody[1]).slice(0, 140)}`)
  const badScopeQuery = await areq('/api/_config?scope=site')
  ok('the old ?scope= query is rejected rather than ignored', badScopeQuery.status === 400, `status ${badScopeQuery.status}`)
} catch (error) {
  ok(`the run completed without throwing (${error.message})`, false, error.stack)
} finally {
  for (const colony of [COLONY_A, COLONY_SIB, COLONY_B]) {
    for (const key of [KEY, KEY_2, `${STAMP}.newname`]) {
      await areq(`/api/_config/${key}?colony=${colony}`, { method: 'DELETE' }).catch(() => {})
    }
    await areq(`/api/_config/${STAMP}.platform?colony=${colony}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const user of [`${STAMP}_land`, `${STAMP}_colony`, `${STAMP}_other`]) {
    await areq(`/api/_auth/users/${user}`, { method: 'DELETE', headers: { 'x-colony': COLONY_A } }).catch(() => {})
    await areq(`/api/_auth/users/${user}`, { method: 'DELETE', headers: { 'x-colony': COLONY_B } }).catch(() => {})
  }
  for (const colony of [COLONY_A, COLONY_SIB, COLONY_B]) {
    await areq(`/api/_meta/universe/colonies/${colony}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const land of [LAND_A, LAND_B]) {
    await areq(`/api/_meta/universe/lands/${land}`, { method: 'DELETE' }).catch(() => {})
  }
  const lands = await json(await areq('/api/_meta/universe/lands'))
  const colonies = await json(await areq('/api/_meta/universe/colonies'))
  ok(
    'the probe land/colony/user/rows are gone',
    ![...(lands.data ?? []), ...(colonies.data ?? [])].some((x) => String(x.id).startsWith(STAMP)),
    `${(lands.data ?? []).map((x) => x.id).join(',')} | ${(colonies.data ?? []).map((x) => x.id).join(',')}`,
  )
  const leftover = await json(await areq(`/api/_config?land=${LAND_A}`))
  ok('no probe rows survive', (leftover.data ?? []).length === 0, JSON.stringify(leftover).slice(0, 140))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
