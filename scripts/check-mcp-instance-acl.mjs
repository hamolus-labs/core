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
 * Access check for the console-managed MCP surface.
 *
 * Why this exists: MCP moves the enforcement boundary. Everything else in the
 * product is a session token over a permission the core checks; MCP adds a
 * deployment that authenticates with an *instance id* and a caller who
 * authenticates with a per-user token, and the whole feature is the claim that
 * those two never widen what an operator's account already allows. That claim is
 * made in two directions at once, and neither direction shows up in a typecheck:
 *
 *   - the instance id is looked up with **no scope in the request**, because a
 *     worker does not know its own land/colony — that is what it is asking for. So
 *     `WHERE id = ?` has to be safe on its own, and a shared id space across
 *     colonies is the bug this pins.
 *   - `?land=`/`?colony=` on the operator routes is a *request* for a scope the
 *     session may already own, never a grant, exactly as on `/_config`.
 *
 * What it pins:
 *   1. an unknown or malformed instance id is 401, and never enumerates,
 *   2. a disabled instance is 403, not 401 — a different problem, different fix,
 *   3. the machine routes work with no `x-land`/`x-colony` header at all,
 *   4. a token is only ever accepted for its own instance, and a token's own
 *      permission list can narrow the instance but never widen it,
 *   5. a read-only instance mints a session with no `*.write` at all — so the core,
 *      not the worker's own check, is what refuses the write,
 *   6. the operator routes follow the config rules: a colony admin cannot reach a
 *      sibling, a land admin must name a colony, and an unregistered one is refused,
 *   7. `mcp.read` alone cannot create, and `mcp.write` cannot escape its colony,
 *   8. a machine call records the deployment's version and last-seen time, and
 *      **nothing an operator sends can write either** — the reported version is what
 *      the console shows, so an operator-supplied one would let the console certify a
 *      release that is not deployed.
 *
 *   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me \
 *     node packages/core/scripts/check-mcp-instance-acl.mjs
 *
 * Self-cleaning: it registers its own stamped land, colonies, users, instances and
 * tokens, and removes all of them again.
 */

const BASE = process.env.BASE ?? 'http://localhost:8787'
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
const STAMP = process.env.MCP_ACL_STAMP ?? `mcpacl_${Date.now().toString(36)}`
const LAND_A = `${STAMP}_a_lnd`
const LAND_B = `${STAMP}_b_lnd`
const COLONY_A = `${STAMP}_a_cny`
const COLONY_SIB = `${STAMP}_as_cny`
const COLONY_B = `${STAMP}_b_cny`
const UNREGISTERED = `${STAMP}_ghost_cny`
const PASSWORD = 'McpAcl!123'

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

/** Operator call: session JWT, the way the console makes it. */
const areq = (path, init = {}, token = admin) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })
const postJson = async (path, body, token = admin) => {
  const res = await areq(path, { method: 'POST', body: JSON.stringify(body) }, token)
  return [res.status, await json(res)]
}
const getJson = async (path, token = admin) => {
  const res = await areq(path, { method: 'GET' }, token)
  return [res.status, await json(res)]
}
const putJson = async (path, body, token = admin) => {
  const res = await areq(path, { method: 'PUT', body: JSON.stringify(body) }, token)
  return [res.status, await json(res)]
}

/** Machine call: the instance id and nothing else. No scope headers, by design. */
const mreq = (path, instanceId, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(instanceId ? { authorization: `Bearer ${instanceId}` } : {}),
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  })

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

/** Every instance and token this run creates, so cleanup can find them. */
const createdInstances = []
const createdTokens = []

try {
  // The universe registry is PUT-only (it upserts by id), unlike `/api/<collection>`
  // which takes POST. Getting that wrong is a 404 that reads like a missing feature.
  const created = async (label, path, body) => {
    const [status, res] = await putJson(path, body)
    ok(label, [200, 201].includes(status), `status ${status} ${JSON.stringify(res)}`)
  }
  await created('land A is registered', `/api/_meta/universe/lands/${LAND_A}`, { label: 'MCP ACL A' })
  await created('land B is registered', `/api/_meta/universe/lands/${LAND_B}`, { label: 'MCP ACL B' })
  await created('colony A is registered', `/api/_meta/universe/colonies/${COLONY_A}`, { landId: LAND_A, label: 'A' })
  await created('a sibling colony is registered', `/api/_meta/universe/colonies/${COLONY_SIB}`, { landId: LAND_A, label: 'A sibling' })
  await created('colony B is registered under land B', `/api/_meta/universe/colonies/${COLONY_B}`, { landId: LAND_B, label: 'B' })

  const privileges = await json(await areq(`/api/privileges?pageSize=100`, { headers: { 'x-colony': COLONY_A } }))
  const landAdmin = (privileges.data ?? []).find((p) => p.name === 'land_admin')
  const colonyAdmin = (privileges.data ?? []).find((p) => p.name === 'admin')
  ok('the land_admin privilege is available', Boolean(landAdmin), JSON.stringify(privileges).slice(0, 140))
  ok('the colony admin privilege is available', Boolean(colonyAdmin), JSON.stringify(privileges).slice(0, 140))

  // `mcp.read` without `mcp.write` is a distinct state and the one most likely to be
  // mis-seeded, so the fixture asserts it exists rather than assuming it. The seeded
  // `viewer` is the role that has it: every `*.read` except lands/panels, and no write
  // at all. `privileges` is a protected collection, so the gate reads it the way the
  // console does instead of inventing a role of its own.
  const viewer = (privileges.data ?? []).find((p) => p.name === 'viewer')
  ok('a role holding mcp.read without mcp.write exists', Boolean(viewer), JSON.stringify(privileges.data ?? []).slice(0, 200))
  ok('…and that role really lacks mcp.write', (viewer?.permissions ?? []).includes('mcp.read') && !(viewer?.permissions ?? []).includes('mcp.write'), JSON.stringify(viewer?.permissions ?? []).slice(0, 200))

  const mkUser = async (username, privilegeId, colony) => {
    const res = await json(
      await areq(
        '/api/_auth/users',
        { method: 'POST', headers: { 'x-colony': colony }, body: JSON.stringify({ username, name: username, password: PASSWORD, privilegeId }) },
      ),
    )
    return res.data?.id
  }
  const colonyUser = await mkUser(`${STAMP}_colony`, colonyAdmin?.id, COLONY_A)
  const otherColonyUser = await mkUser(`${STAMP}_other`, colonyAdmin?.id, COLONY_B)
  const readerUser = await mkUser(`${STAMP}_reader`, viewer?.id, COLONY_A)
  const landUser = await mkUser(`${STAMP}_land`, landAdmin?.id, COLONY_A)
  ok('a colony admin is created in colony A', typeof colonyUser === 'string', String(colonyUser))
  ok('a colony admin is created in colony B', typeof otherColonyUser === 'string', String(otherColonyUser))
  ok('an mcp.read-only user is created in colony A', typeof readerUser === 'string', String(readerUser))
  ok('a land admin is created in colony A', typeof landUser === 'string', String(landUser))

  const colonyToken = await login(`${STAMP}_colony`)
  const otherColonyToken = await login(`${STAMP}_other`)
  const readerToken = await login(`${STAMP}_reader`)
  const landToken = await login(`${STAMP}_land`)
  ok('colony A can sign in', Boolean(colonyToken))
  ok('colony B can sign in', Boolean(otherColonyToken))
  ok('the mcp.read-only user can sign in', Boolean(readerToken))
  ok('the land admin can sign in', Boolean(landToken))

  /* -- an instance in colony A, with the default groups ---------------------- */
  const [instStatus, instBody] = await postJson(
    `/api/_mcp/instances?colony=${COLONY_A}`,
    { label: `${STAMP} support`, toolGroups: ['records', 'media'] },
    colonyToken,
  )
  ok('a colony admin creates an instance in its own colony', instStatus === 201, `status ${instStatus} ${JSON.stringify(instBody).slice(0, 200)}`)
  const instanceId = instBody?.data?.id
  createdInstances.push({ id: instanceId, colony: COLONY_A })
  ok('the instance id is generated, not operator-chosen', /^mcp_[0-9A-Za-z]{26}$/.test(String(instanceId)), String(instanceId))
  ok('the instance is read-write and enabled by default', instBody?.data?.readonly === false && instBody?.data?.enabled === true, JSON.stringify(instBody?.data).slice(0, 200))
  ok('the instance is pinned to the colony it was created in', instBody?.data?.colony === COLONY_A, JSON.stringify(instBody?.data).slice(0, 160))

  /* -- 1 & 2: the instance id is a credential, and its refusals are typed ---- */
  const noId = await mreq('/api/_mcp/config', undefined)
  ok('a request with no instance id is 401', noId.status === 401, `status ${noId.status}`)

  const unknownId = await mreq('/api/_mcp/config', 'mcp_0000000000000000000000abcd')
  const unknownIdBody = await json(unknownId)
  ok('an unknown instance id is 401, not 404', unknownId.status === 401, `status ${unknownId.status} ${JSON.stringify(unknownIdBody).slice(0, 160)}`)
  const unknownMsg = String(unknownIdBody.error?.message ?? '')
  ok('an unknown id does not say "not found"', !/not found/i.test(unknownMsg), unknownMsg)

  const goodId = await mreq('/api/_mcp/config', instanceId)
  // Read the body once. A `Response` body is a one-shot stream, so asserting on it and
  // then reading it again for a second assertion silently yields `{}` — which reads as
  // "the field was missing" rather than as the bug it is.
  const goodIdBody = await json(goodId)
  ok('a valid instance id reads its config', goodId.status === 200, `status ${goodId.status} ${JSON.stringify(goodIdBody).slice(0, 200)}`)
  const cfg = goodIdBody.data?.instance
  ok('the config reports the colony the instance serves', cfg?.colony === COLONY_A, JSON.stringify(cfg).slice(0, 200))
  ok('the config reports the tool groups it was created with', JSON.stringify(cfg?.toolGroups) === JSON.stringify(['records', 'media']), JSON.stringify(cfg?.toolGroups))
  // The worker learns its own scope *from* this call, so the response must not need one.
  ok('the config call works with no x-land or x-colony header', goodId.status === 200, `status ${goodId.status}`)

  /* -- 8: the deployment reports itself, and only the deployment may --------- */
  const readInstance = async () => {
    const [, listBody] = await getJson(`/api/_mcp/instances?colony=${COLONY_A}`)
    return (listBody?.data ?? []).find((i) => i.id === instanceId)
  }

  // A heartbeat rides on a call that happens anyway (config is re-read about once a
  // minute), so it is recorded only *after* the credential is accepted. Compared as a
  // before/after rather than against `null`, because the `goodId` read above already
  // made this instance live — an absolute check here would be asserting the state of a
  // call that happened earlier, not the effect of this one.
  const seenBefore = (await readInstance())?.lastSeenAt
  await mreq('/api/_mcp/config', 'mcp_0000000000000000000000abcd', {
    headers: { 'x-hamolus-mcp-version': '9.9.9' },
  })
  ok(
    'a rejected id records no heartbeat',
    (await readInstance())?.lastSeenAt === seenBefore,
    `${seenBefore} -> ${(await readInstance())?.lastSeenAt}`,
  )

  await mreq('/api/_mcp/config', instanceId, { headers: { 'x-hamolus-mcp-version': '0.2.10' } })
  const afterBeat = await readInstance()
  ok('a machine call records the reported version', afterBeat?.reportedVersion === '0.2.10', JSON.stringify(afterBeat).slice(0, 200))
  ok('a machine call records a last-seen time', typeof afterBeat?.lastSeenAt === 'string', JSON.stringify(afterBeat).slice(0, 200))

  // Over-long claims are dropped rather than truncated: a version cut mid-string is a
  // wrong answer, and "did not report" is not.
  await mreq('/api/_mcp/config', instanceId, {
    headers: { 'x-hamolus-mcp-version': 'v'.repeat(64) },
  })
  ok(
    'an implausible reported version is dropped, not truncated',
    (await readInstance())?.reportedVersion === '0.2.10',
    JSON.stringify(await readInstance()).slice(0, 200),
  )

  // A machine call with no header must not erase what the deployment last said: an
  // older worker is alive, it just cannot report.
  await mreq('/api/_mcp/config', instanceId)
  ok(
    'a worker that sends no version keeps the last one it reported',
    (await readInstance())?.reportedVersion === '0.2.10',
    JSON.stringify(await readInstance()).slice(0, 200),
  )

  // The load-bearing one. `mcp.write` may set anything the *operator* controls, and
  // nothing else: a body that names a version is refused by the strict schema, and the
  // stored value is unchanged afterwards. The 400 is the first line of defence; the
  // assertion below is the second — that even a refused write left the row alone.
  const [patchStatus, patched] = await putJson(
    `/api/_mcp/instances/${instanceId}?colony=${COLONY_A}`,
    { label: `${STAMP} renamed`, reportedVersion: '9.9.9' },
  )
  ok('an operator cannot send a reported version at all', patchStatus === 400, `status ${patchStatus} ${JSON.stringify(patched).slice(0, 200)}`)
  ok(
    'and the row still reports what the deployment said',
    (await readInstance())?.reportedVersion === '0.2.10',
    JSON.stringify(await readInstance()).slice(0, 200),
  )

  // The legitimate half of that write still works, or the check above would also pass
  // against a route that rejects every body.
  const [labelStatus] = await putJson(
    `/api/_mcp/instances/${instanceId}?colony=${COLONY_A}`,
    { label: `${STAMP} renamed` },
  )
  ok('an operator can still rename the instance', labelStatus === 200, `status ${labelStatus}`)

  /* -- a second instance, to pin that ids do not collide across colonies ---- */
  const [, instBBody] = await postJson(
    `/api/_mcp/instances?colony=${COLONY_B}`,
    { label: `${STAMP} other` },
    otherColonyToken,
  )
  const instanceB = instBBody?.data?.id
  createdInstances.push({ id: instanceB, colony: COLONY_B })
  ok('a second instance is created in colony B', /^mcp_[0-9A-Za-z]{26}$/.test(String(instanceB)), String(instanceB))
  ok('the two instance ids differ', instanceId !== instanceB, `${instanceId} / ${instanceB}`)

  // The point of the global unique index: colony B's instance must resolve to
  // colony B, not to whichever row a scoped table scan happened to find first.
  const cfgB = await json(await mreq('/api/_mcp/config', instanceB))
  ok('each instance id resolves to its own colony, not the first match', cfgB.data?.instance?.colony === COLONY_B, JSON.stringify(cfgB.data?.instance).slice(0, 200))

  /* -- issue a token and exchange it for a session -------------------------- */
  const [tokStatus, tokBody] = await postJson(
    `/api/_mcp/instances/${instanceId}/tokens?colony=${COLONY_A}`,
    { name: `${STAMP} laptop` },
    colonyToken,
  )
  ok('a token is issued', tokStatus === 201, `status ${tokStatus} ${JSON.stringify(tokBody).slice(0, 200)}`)
  const tokenSecret = tokBody?.data?.token
  const tokenId = tokBody?.data?.id
  createdTokens.push({ tokenId, colony: COLONY_A })
  ok('the plaintext token is returned exactly once, at creation', /^hmcp_[0-9A-Za-z]{12}_[0-9A-Za-z_-]{43}$/.test(String(tokenSecret)), String(tokenSecret).slice(0, 80))

  const listed = await json(await areq(`/api/_mcp/instances/${instanceId}/tokens?colony=${COLONY_A}`, {}, colonyToken))
  ok('the token is listed afterwards', listed.data?.length === 1, JSON.stringify(listed).slice(0, 200))
  ok('the listing never returns the secret', JSON.stringify(listed.data ?? []).includes(tokenSecret) === false, 'the plaintext must not round-trip')

  const session = await json(
    await mreq('/api/_mcp/session', instanceId, { method: 'POST', body: JSON.stringify({ token: tokenSecret }) }),
  )
  const mcpJwt = session.data?.token
  ok('the token is exchanged for a session', Boolean(mcpJwt), JSON.stringify(session).slice(0, 200))
  ok('the session is pinned to the instance colony', session.data?.instance?.colony === COLONY_A, JSON.stringify(session.data?.instance).slice(0, 160))
  ok('the session expires in minutes, not days', new Date(session.data?.expiresAt ?? 0).getTime() - Date.now() <= 16 * 60 * 1000, session.data?.expiresAt)

  const sessionPerms = session.data?.permissions ?? []
  ok('a read-write instance grants its groups\' write permissions', sessionPerms.includes('records.write') && sessionPerms.includes('media.write'), sessionPerms.join(','))
  // Compare the whole set rather than probing single permissions.
  //
  // Probing is treacherous here, because the groups deliberately overlap: `users.*` is
  // in `records` (its `create_record` takes any collection name, and the core maps the
  // protected `users` collection to `users.write`), and `collections.write` is in all
  // three of `records`, `meta` and `admin`. So `records` + `media` legitimately yields
  // `users.write` and `collections.write`, and asserting they are absent would be
  // asserting the feature is broken.
  //
  // An exact set comparison is both directions at once — it proves the session has
  // everything `records` and `media` promise, *and* nothing from the `meta` and `admin`
  // groups this instance never picked — and it fails loudly if a group mapping changes
  // shape, which a hand-written "these three must be missing" list would not.
  const EXPECTED_READ_WRITE = new Set([
    'records.read', 'collections.read', 'users.read', 'records.write', 'collections.write', 'users.write',
    'media.read', 'media.write',
  ])
  const unexpected = sessionPerms.filter((p) => !EXPECTED_READ_WRITE.has(p))
  const missing = [...EXPECTED_READ_WRITE].filter((p) => !sessionPerms.includes(p))
  ok(
    'the session is exactly the two picked groups, no more and no less',
    unexpected.length === 0 && missing.length === 0,
    `unexpected=[${unexpected.join(',')}] missing=[${missing.join(',')}] got=[${sessionPerms.join(',')}]`,
  )
  ok(
    'nothing from the unpicked meta/admin groups leaks in',
    !['settings.write', 'config.write', 'lands.write', 'colonies.write'].some((p) => sessionPerms.includes(p)),
    sessionPerms.join(','),
  )

  /* -- 4: a token belongs to one instance, and can narrow but not widen ----- */
  const crossInstance = await mreq('/api/_mcp/session', instanceB, { method: 'POST', body: JSON.stringify({ token: tokenSecret }) })
  ok("colony A's token is refused by colony B's instance", crossInstance.status === 401, `status ${crossInstance.status}`)

  const [narrowStatus, narrowBody] = await postJson(
    `/api/_mcp/instances/${instanceId}/tokens?colony=${COLONY_A}`,
    { name: `${STAMP} narrow`, permissions: ['records.read', 'lands.write'] },
    colonyToken,
  )
  ok('a token may narrow its permissions', narrowStatus === 201, `status ${narrowStatus} ${JSON.stringify(narrowBody).slice(0, 200)}`)
  createdTokens.push({ tokenId: narrowBody?.data?.id, colony: COLONY_A })
  const narrowSession = await json(
    await mreq('/api/_mcp/session', instanceId, { method: 'POST', body: JSON.stringify({ token: narrowBody?.data?.token }) }),
  )
  const narrowPerms = narrowSession.data?.permissions ?? []
  ok('a narrowing token keeps only what the instance also grants', narrowPerms.includes('records.read') && !narrowPerms.includes('records.write'), narrowPerms.join(','))
  // `lands.write` is in the request and NOT in the instance's groups. A token that
  // could widen would be a privilege escalation with no visible symptom.
  ok('a token cannot widen past its instance', !narrowPerms.includes('lands.write'), narrowPerms.join(','))

  /* -- 5: read-only is enforced by the core, not by the worker -------------- */
  const [roStatus, roBody] = await putJson(
    `/api/_mcp/instances/${instanceId}?colony=${COLONY_A}`,
    { readonly: true },
    colonyToken,
  )
  ok('an instance can be switched to read-only', [200, 204].includes(roStatus), `status ${roStatus} ${JSON.stringify(roBody).slice(0, 200)}`)

  const roSession = await json(
    await mreq('/api/_mcp/session', instanceId, { method: 'POST', body: JSON.stringify({ token: tokenSecret }) }),
  )
  const roPerms = roSession.data?.permissions ?? []
  ok('a read-only instance mints a session with no write permission at all', !roPerms.some((p) => p.endsWith('.write')), roPerms.join(','))
  ok('a read-only instance still grants its read permissions', roPerms.includes('records.read'), roPerms.join(','))

  // The point of the whole design: the core refuses. The worker's own `readonly`
  // check is a friendlier message, not the thing that stops a write.
  const roWrite = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${roSession.data?.token ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'should not be written' }),
  })
  ok('the core refuses a write made through a read-only instance', [403, 404, 400].includes(roWrite.status) && roWrite.status !== 200, `status ${roWrite.status}`)

  // Back to read-write, so the remaining checks run against a live write path.
  await putJson(`/api/_mcp/instances/${instanceId}?colony=${COLONY_A}`, { readonly: false }, colonyToken)

  /* -- revoked and expired tokens are 401, and say which -------------------- */
  await areq(`/api/_mcp/tokens/${tokenId}?colony=${COLONY_A}`, { method: 'DELETE' }, colonyToken)
  const afterRevoke = await mreq('/api/_mcp/session', instanceId, { method: 'POST', body: JSON.stringify({ token: tokenSecret }) })
  const afterRevokeBody = await json(afterRevoke)
  ok('a revoked token is refused', afterRevoke.status === 401, `status ${afterRevoke.status}`)
  ok('a revoked token is distinguishable from a bad one by its code', afterRevokeBody.error?.code === 'TOKEN_REVOKED', JSON.stringify(afterRevokeBody).slice(0, 160))

  const junk = await mreq('/api/_mcp/session', instanceId, { method: 'POST', body: JSON.stringify({ token: 'hmcp_aaaaaaaaaaaa_deadbeef' }) })
  const junkBody = await json(junk)
  ok('a token id that does not exist is refused', junk.status === 401, `status ${junk.status}`)
  ok('an unknown token id is not distinguishable from a wrong secret', junkBody.error?.code === 'INVALID_TOKEN', JSON.stringify(junkBody).slice(0, 160))

  /* -- 2 again: a disabled instance is 403, and stops working --------------- */
  await putJson(`/api/_mcp/instances/${instanceId}?colony=${COLONY_A}`, { enabled: false }, colonyToken)
  const disabled = await mreq('/api/_mcp/config', instanceId)
  const disabledBody = await json(disabled)
  ok('a disabled instance is 403, not 401', disabled.status === 403, `status ${disabled.status} ${JSON.stringify(disabledBody).slice(0, 160)}`)
  ok('the disabled answer names the switch', disabledBody.error?.code === 'MCP_DISABLED', JSON.stringify(disabledBody).slice(0, 160))
  const disabledSession = await mreq('/api/_mcp/session', instanceId, { method: 'POST', body: JSON.stringify({ token: narrowBody?.data?.token }) })
  ok('a disabled instance mints no session either', disabledSession.status === 403, `status ${disabledSession.status}`)
  await putJson(`/api/_mcp/instances/${instanceId}?colony=${COLONY_A}`, { enabled: true }, colonyToken)

  /* -- 6 & 7: the operator routes follow the config rules ------------------- */
  const siblingList = await areq(`/api/_mcp/instances?colony=${COLONY_SIB}`, {}, colonyToken)
  ok('a colony admin is refused a sibling colony\'s instances', siblingList.status === 403, `status ${siblingList.status}`)

  const ownList = await json(await areq(`/api/_mcp/instances`, {}, colonyToken))
  ok('a colony admin lists its own colony with no query', ownList.data?.length === 1, JSON.stringify(ownList).slice(0, 200))
  ok('…and only its own colony', (ownList.data ?? []).every((i) => i.colony === COLONY_A), JSON.stringify(ownList.data).slice(0, 200))

  const crossWrite = await putJson(
    `/api/_mcp/instances/${instanceId}?colony=${COLONY_B}`,
    { label: 'stolen' },
    colonyToken,
  )
  ok('a colony admin cannot retarget another colony\'s instance', crossWrite[0] === 404 || crossWrite[0] === 403, `status ${crossWrite[0]}`)

  const ambiguous = await areq(`/api/_mcp/instances/${instanceId}`, {}, landToken)
  const ambiguousBody = await json(ambiguous)
  ok('a land admin must name a colony for a single-instance read', ambiguous.status === 400, `status ${ambiguous.status} ${JSON.stringify(ambiguousBody).slice(0, 160)}`)

  const ghost = await areq(`/api/_mcp/instances?colony=${UNREGISTERED}`, {}, landToken)
  ok('an unregistered colony is refused, not invented', ghost.status === 404, `status ${ghost.status}`)

  /* -- 7: mcp.read alone cannot mutate -------------------------------------- */
  const readerList = await areq('/api/_mcp/instances', {}, readerToken)
  ok('an mcp.read user can list instances', readerList.status === 200, `status ${readerList.status}`)
  const readerCreate = await postJson('/api/_mcp/instances?colony=' + COLONY_A, { label: 'reader attempt' }, readerToken)
  ok('an mcp.read user cannot create an instance', readerCreate[0] === 403, `status ${readerCreate[0]}`)
  const readerTokenIssue = await postJson(`/api/_mcp/instances/${instanceId}/tokens?colony=${COLONY_A}`, { name: 'reader attempt' }, readerToken)
  ok('an mcp.read user cannot issue a token', readerTokenIssue[0] === 403, `status ${readerTokenIssue[0]}`)

  const noSessionRead = await areq('/api/_mcp/instances', {}, tokenSecret)
  ok('an MCP token is not a console session', [401, 403].includes(noSessionRead.status), `status ${noSessionRead.status}`)

  const platformList = await json(await areq('/api/_mcp/instances'))
  ok('the platform admin sees both instances', (platformList.data ?? []).length >= 2, `${(platformList.data ?? []).length} instances`)
} catch (error) {
  ok(`the run completed without throwing (${error.message})`, false, error.stack)
} finally {
  for (const t of createdTokens) {
    if (t.tokenId) await areq(`/api/_mcp/tokens/${t.tokenId}?colony=${t.colony}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const inst of createdInstances) {
    if (inst.id) await areq(`/api/_mcp/instances/${inst.id}?colony=${inst.colony}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const user of [`${STAMP}_colony`, `${STAMP}_other`, `${STAMP}_reader`, `${STAMP}_land`]) {
    for (const colony of [COLONY_A, COLONY_B]) {
      await areq(`/api/_auth/users/${user}`, { method: 'DELETE', headers: { 'x-colony': colony } }).catch(() => {})
    }
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
    'the probe land/colony/user/role are gone',
    ![...(lands.data ?? []), ...(colonies.data ?? [])].some((x) => String(x.id).startsWith(STAMP)),
    `${(lands.data ?? []).map((x) => x.id).join(',')} | ${(colonies.data ?? []).map((x) => x.id).join(',')}`,
  )
  const leftover = await json(await areq(`/api/_mcp/instances?land=${LAND_A}`))
  ok('no probe instances survive', (leftover.data ?? []).length === 0, JSON.stringify(leftover).slice(0, 160))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
