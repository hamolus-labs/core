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
 * Localization HTTP contract regression check.
 *
 * Why this is separate from `check-localization.mjs`: that one is pure and offline —
 * schemas, resolvers, merge rules and the two generated `*.config.ts` templates, all
 * exercised in-process with no server. It cannot see the half of the contract that
 * only exists over HTTP: who may read the endpoint, what shape it answers in, and
 * whose locales those are when a project is running several lands at once.
 *
 * Those are exactly the parts a console depends on before it has a session, so they
 * are pinned here:
 *
 *   1. the endpoint is readable anonymously — the console renders its language
 *      switcher from the *unauthenticated* response, and the whole point of the
 *      config floor is that a visitor is never shown a bare "en" while the core is
 *      still loading. `requireRead` allows anonymous reads, and this assertion is
 *      what stops someone "hardening" that into a login wall,
 *   2. a session that lacks `settings.read` is refused (403), so the public read is
 *      deliberate rather than a missing check,
 *   3. the response shape is `{ data: { defaultLocale, locales: [{ code, … }] } }`,
 *      and `data` is `null` — not `{}`, not a 404 — for a project that configures
 *      no locales, because that is the single-locale case a console must render,
 *   4. locales are per scope: two colonies of the same land answer with their own
 *      list, and an unconfigured colony stays `null` while its sibling is set,
 *   5. the legacy `{ languages: [...] }` settings shape still resolves through the
 *      endpoint, so an existing project does not lose its switcher on upgrade,
 *   6. localized validation is enforced per scope over HTTP: every declared locale
 *      key is required, an undeclared one is dropped rather than stored, and a scope
 *      with no locales configured still accepts a plain string.
 *
 *   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me \
 *     node packages/core/scripts/check-localization-api.mjs
 *
 * Self-cleaning and non-destructive: it registers its own land, two colonies, a
 * collection and a throwaway user, and removes all of them again. Settings are
 * written only into its own colonies, so no shared project state is touched.
 */
const BASE = process.env.BASE ?? 'http://localhost:8787'
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
const STAMP = process.env.LOCALIZATION_CHECK_STAMP ?? `locapi_${Date.now().toString(36)}`
const LAND = `${STAMP}_lnd`
const COLONY_CONFIGURED = `${STAMP}_cfg_cny`
const COLONY_EMPTY = `${STAMP}_empty_cny`
const COLONY_PLAIN = `${STAMP}_plain_cny`
const COLLECTION = `${STAMP}_notes`
const USER = `${STAMP}_u`

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
const anon = (path) => fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' } })

const putJson = async (path, body, headers = {}) => {
  const res = await areq(path, { method: 'PUT', body: JSON.stringify(body), headers })
  return [res.status, await json(res)]
}
const getJson = async (path, headers = {}) => {
  const res = await areq(path, { headers })
  return [res.status, await json(res)]
}

const A = { 'x-colony': COLONY_CONFIGURED }
const B = { 'x-colony': COLONY_EMPTY }
// A scope that never receives settings — the only honest way to assert the
// "no locales configured" case, since B is deliberately configured below.
const P = { 'x-colony': COLONY_PLAIN }

// A valid response, judged by shape rather than by equality with a literal: the
// endpoint must not grow fields a console has to tolerate, but pinning the whole
// object would make every additive change a red test.
const isLocalization = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.defaultLocale === 'string' &&
  Array.isArray(value.locales) &&
  value.locales.every((l) => typeof l?.code === 'string')

try {
  // -- scope fixtures --------------------------------------------------------
  for (const [label, path, body] of [
    ['the probe land is registered', `/api/_meta/universe/lands/${LAND}`, { label: 'Localization API Check' }],
    ['the configured colony is registered', `/api/_meta/universe/colonies/${COLONY_CONFIGURED}`, { landId: LAND, label: 'Configured' }],
    ['the unconfigured colony is registered', `/api/_meta/universe/colonies/${COLONY_EMPTY}`, { landId: LAND, label: 'Empty' }],
    ['the never-configured colony is registered', `/api/_meta/universe/colonies/${COLONY_PLAIN}`, { landId: LAND, label: 'Plain' }],
  ]) {
    const [status, body_] = await putJson(path, body)
    ok(label, [200, 201].includes(status), `status ${status} ${JSON.stringify(body_)}`)
  }

  // -- 1 + 3. the anonymous read is the contract the console boots against ----
  const anonRes = await anon('/api/_meta/localization')
  const anonBody = await json(anonRes)
  ok(
    'localization is readable without a session',
    anonRes.status === 200,
    `status ${anonRes.status} ${JSON.stringify(anonBody)}`,
  )
  ok(
    'the anonymous read uses the same envelope as the authenticated one',
    'data' in anonBody && (anonBody.data === null || isLocalization(anonBody.data)),
    JSON.stringify(anonBody),
  )

  const [emptyStatus, emptyBody] = await getJson('/api/_meta/localization', B)
  ok('an unconfigured scope answers 200', emptyStatus === 200, `status ${emptyStatus} ${JSON.stringify(emptyBody)}`)
  ok(
    'an unconfigured scope answers data: null (not {} and not 404)',
    'data' in emptyBody && emptyBody.data === null,
    JSON.stringify(emptyBody),
  )

  // -- 2. a session without settings.read is refused -------------------------
  const privileges = await json(await areq('/api/privileges', { headers: A }))
  const panelUser = (privileges.data ?? []).find((p) => p.name === 'panel_user')
  ok('the panel_user privilege is bootstrapped in the probe scope', Boolean(panelUser), JSON.stringify(privileges).slice(0, 120))

  const userRes = await areq('/api/_auth/users', {
    method: 'POST',
    headers: A,
    body: JSON.stringify({ username: USER, name: 'Localization Check', password: 'LocalizationCheck!123', privilegeId: panelUser?.id }),
  })
  const userBody = await json(userRes)
  ok('a throwaway low-privilege user is created', userRes.status === 200 || userRes.status === 201, `status ${userRes.status} ${JSON.stringify(userBody).slice(0, 160)}`)

  const login = await json(
    await fetch(`${BASE}/api/_auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: 'LocalizationCheck!123' }),
    }),
  )
  const lowToken = login.data?.token
  ok('a low-privilege session can be minted', Boolean(lowToken), JSON.stringify(login).slice(0, 160))

  if (lowToken) {
    const denied = await areq('/api/_meta/localization', { headers: A }, lowToken)
    const deniedBody = await json(denied)
    ok(
      'a session without settings.read is refused with 403',
      denied.status === 403,
      `status ${denied.status} ${JSON.stringify(deniedBody)}`,
    )
    ok('the refusal names the missing permission', /settings\.read/.test(JSON.stringify(deniedBody)), JSON.stringify(deniedBody))
  }

  // -- 4 + 5. settings decide the answer, per scope, in either shape ---------
  const configured = { defaultLocale: 'ja', locales: [{ code: 'en' }, { code: 'ja', label: '日本語', direction: 'rtl' }, { code: 'id' }] }
  const [putStatus, putBody] = await putJson('/api/_meta/settings', { localization: configured }, A)
  ok('localization can be written to settings', [200, 201].includes(putStatus), `status ${putStatus} ${JSON.stringify(putBody)}`)

  const [readStatus, readBody] = await getJson('/api/_meta/localization', A)
  ok('the configured scope reads back 200', readStatus === 200, `status ${readStatus} ${JSON.stringify(readBody)}`)
  ok('the configured scope answers its own localization', isLocalization(readBody.data), JSON.stringify(readBody))
  ok(
    'the locale list survives the round trip',
    JSON.stringify(readBody.data?.locales?.map((l) => l.code)) === JSON.stringify(['en', 'ja', 'id']),
    JSON.stringify(readBody.data?.locales),
  )
  ok('the default locale survives the round trip', readBody.data?.defaultLocale === 'ja', String(readBody.data?.defaultLocale))
  ok(
    'an optional locale label survives the round trip',
    readBody.data?.locales?.[1]?.label === '日本語',
    JSON.stringify(readBody.data?.locales?.[1]),
  )
  ok(
    'an optional locale direction survives the round trip',
    readBody.data?.locales?.[1]?.direction === 'rtl',
    JSON.stringify(readBody.data?.locales?.[1]),
  )
  ok('the answer is multilingual', readBody.data?.multilingual === true, String(readBody.data?.multilingual))

  // The sibling colony shares a land but not a settings key: it must not inherit.
  const [siblingStatus, siblingBody] = await getJson('/api/_meta/localization', B)
  ok(
    'a sibling colony in the same land does not inherit the locales',
    siblingStatus === 200 && siblingBody.data === null,
    `status ${siblingStatus} ${JSON.stringify(siblingBody)}`,
  )

  const [legacyStatus] = await putJson('/api/_meta/settings', { localization: { languages: ['en', 'id'], defaultLocale: 'id' } }, B)
  ok('the legacy settings shape is accepted', [200, 201].includes(legacyStatus), `status ${legacyStatus}`)
  const [, legacyBody] = await getJson('/api/_meta/localization', B)
  ok(
    'the legacy settings shape still resolves to a locale list',
    isLocalization(legacyBody.data) && JSON.stringify(legacyBody.data.locales.map((l) => l.code)) === JSON.stringify(['en', 'id']),
    JSON.stringify(legacyBody),
  )
  ok('the legacy default locale is honoured', legacyBody.data?.defaultLocale === 'id', String(legacyBody.data?.defaultLocale))

  // -- 6. localized validation, enforced per scope over HTTP -----------------
  const definition = {
    name: COLLECTION,
    label: 'Notes',
    fields: [
      { name: 'title', label: 'Title', type: 'string', localized: true, required: true },
      { name: 'note', label: 'Note', type: 'string' },
    ],
  }
  for (const [label, headers] of [
    ['the collection is registered in the configured scope', A],
    ['the collection is registered in the never-configured scope', P],
  ]) {
    const [status, body_] = await putJson(`/api/_meta/collections/${COLLECTION}`, definition, headers)
    ok(label, [200, 201].includes(status), `status ${status} ${JSON.stringify(body_)}`)
  }

  const postRecord = async (label, record, headers) => {
    const res = await areq(`/api/${COLLECTION}`, { method: 'POST', headers, body: JSON.stringify(record) }, admin)
    const body_ = await json(res)
    ok(label, res.status === 200 || res.status === 201, `status ${res.status} ${JSON.stringify(body_)}`)
    return body_
  }

  const created = await postRecord(
    'a fully localized record is accepted where locales are configured',
    { title: { en: 'Hello', ja: 'こんにちは', id: 'Halo' }, note: 'plain' },
    A,
  )
  const recordId = created.data?.id

  const missingLocale = await areq(`/api/${COLLECTION}`, { method: 'POST', headers: A, body: JSON.stringify({ title: { en: 'Hello', ja: 'こんにちは' } }) }, admin)
  const missingBody = await json(missingLocale)
  ok(
    'a record missing a declared locale is rejected',
    missingLocale.status === 400,
    `status ${missingLocale.status} ${JSON.stringify(missingBody)}`,
  )
  ok('the rejection names the offending field', /title/.test(JSON.stringify(missingBody)), JSON.stringify(missingBody))

  await postRecord(
    'a record carrying an undeclared locale key is accepted',
    { title: { en: 'Hello', ja: 'こんにちは', id: 'Halo', fr: 'Bonjour' } },
    A,
  )
  if (recordId) {
    const [readRecordStatus, readRecordBody] = await getJson(`/api/${COLLECTION}/${recordId}`, A)
    ok('the stored record reads back 200', readRecordStatus === 200, `status ${readRecordStatus}`)
    ok(
      'an undeclared locale key is dropped, not stored',
      readRecordBody.data?.title !== undefined && readRecordBody.data.title.fr === undefined,
      JSON.stringify(readRecordBody.data?.title),
    )
    ok(
      'the declared locales are returned as an object when no locale is requested',
      typeof readRecordBody.data?.title === 'object' && readRecordBody.data.title.en === 'Hello',
      JSON.stringify(readRecordBody.data?.title),
    )
  }

  await postRecord(
    'a plain string is accepted where no locales are configured',
    { title: 'Just a string', note: 'plain' },
    P,
  )
  const missingLocaleUnconfigured = await areq(
    `/api/${COLLECTION}`,
    { method: 'POST', headers: P, body: JSON.stringify({ title: { en: 'Hello' } }) },
    admin,
  )
  ok(
    'a localized object is still rejected where no locales are configured',
    missingLocaleUnconfigured.status === 400,
    `status ${missingLocaleUnconfigured.status}`,
  )
} finally {
  for (const headers of [A, P]) {
    await areq(`/api/_meta/collections/${COLLECTION}`, { method: 'DELETE', headers }).catch(() => {})
  }
  await areq(`/api/_auth/users/${USER}`, { method: 'DELETE', headers: A }).catch(() => {})
  for (const colony of [COLONY_CONFIGURED, COLONY_EMPTY, COLONY_PLAIN]) {
    await areq(`/api/_meta/universe/colonies/${colony}`, { method: 'DELETE' }).catch(() => {})
  }
  await areq(`/api/_meta/universe/lands/${LAND}`, { method: 'DELETE' }).catch(() => {})
  const lands = await json(await areq('/api/_meta/universe/lands'))
  const colonies = await json(await areq('/api/_meta/universe/colonies'))
  ok(
    'the probe land and colonies are gone',
    ![...(lands.data ?? []), ...(colonies.data ?? [])].some((x) => String(x?.id).startsWith(STAMP)),
    `${(lands.data ?? []).map((x) => x.id).join(',')} | ${(colonies.data ?? []).map((x) => x.id).join(',')}`,
  )
  const leftovers = await getJson(`/api/_meta/collections/${COLLECTION}`)
  ok('the probe collection is gone', leftovers[0] === 404, `status ${leftovers[0]}`)
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
