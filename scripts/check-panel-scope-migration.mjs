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
 * `_meta_panels` scope-migration regression check.
 *
 * Why this exists: `putPanel()` upserts with `ON CONFLICT (land, colony, id)`.
 * A database created by an earlier build carries a narrower primary key
 * (`(id)` pre-scope, `(land, id)` before the colony column landed) that SQLite
 * can never match, so every write died with "ON CONFLICT clause does not match
 * any PRIMARY KEY or UNIQUE constraint" and surfaced to the caller as a bare
 * 500 INTERNAL. A repair pass already existed but rebuilt into the *stale*
 * `(land, id)` shape and gated on "is the key more than one column wide", so
 * `(land, id)` itself passed as acceptable and the table was never fixed.
 *
 * This check installs the legacy shape, restarts the worker so the bootstrap
 * migration runs, and asserts:
 *   1. a panel row that predates the migration survived the rebuild,
 *   2. its pre-scope `default` land was folded into the current default land,
 *   3. the primary key is exactly (land, colony, id),
 *   4. an upsert now succeeds (the operation that used to 500),
 *   5. the same panel id in another colony does not collide,
 *   6. the pre-existing manifests are still there afterwards.
 *
 *   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me \
 *     node packages/core/scripts/check-panel-scope-migration.mjs
 *
 * DESTRUCTIVE and LOCAL-ONLY: it replaces `_meta_panels` and restarts the local
 * worker, so it refuses to run against a non-loopback BASE. The existing
 * manifests are read out first and restored in a `finally` block, so even a
 * crashed run hands the panels back.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
const PORT = new URL(BASE).port || '8787'
const CORE_DIR = resolve(import.meta.dirname, '..')
const D1_DIR = join(CORE_DIR, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fatal = (message) => {
  console.error(`\nERROR  ${message}`)
  process.exit(1)
}

if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(BASE).hostname)) {
  fatal('Refusing to run: BASE is not loopback. This check replaces _meta_panels and restarts the worker.')
}
const dataFile = existsSync(D1_DIR)
  ? readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'))
  : undefined
if (!dataFile) fatal(`No local D1 database file under ${D1_DIR} — run \`wrangler dev\` first.`)
const DB_FILE = join(D1_DIR, dataFile)

const token = (
  await json(
    await fetch(`${BASE}/api/_auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ADMIN_KEY }),
    }),
  )
).data?.token
if (!token) fatal(`Could not mint an admin token from ${BASE} — is the core running and ADMIN_KEY correct?`)
const areq = (path, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })
const d1 = (sql) => {
  const r = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--command', sql], {
    cwd: CORE_DIR,
    encoding: 'utf8',
  })
  if (r.status !== 0) fatal(`wrangler d1 execute failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`)
}
const sqlite = (sql) => spawnSync('sqlite3', [DB_FILE, sql], { encoding: 'utf8' }).stdout.trim()

// A minimal but *schema-valid* manifest: a view needs a label and a path, the
// panel needs at least one role, and the role must reference a real view.
const probe = (id, name, collection = 'contacts', readFields = ['id', 'name']) => ({
  id,
  name,
  views: [
    {
      id: 'probe_rows',
      label: 'Rows',
      path: '/rows',
      kind: 'table',
      collection,
      operations: ['read'],
      fields: { read: readFields, write: [] },
    },
  ],
  roles: [{ id: 'probe_role', label: 'Probe', views: [{ viewId: 'probe_rows', operations: ['read'] }] }],
  defaultRoleId: 'probe_role',
  members: [],
  menu: [],
})
const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`

const saved = []
try {
  /* -- 1. read the live manifests out so a real dataset survives ----------- */
  const existing = await json(await areq('/api/_panels'))
  for (const item of existing.data ?? []) {
    const full = await json(await areq(`/api/_panels/${item.id}`))
    if (full.data) saved.push(full.data)
  }
  console.log(`Backed up ${saved.length} existing panel manifest(s).`)

  // The probe ids are fixed, so a leftover from an interrupted earlier run
  // would just be backed up and restored again instead of being exercised.
  const stale = saved.filter((p) => p.id === 'upsert_probe' || p.id === 'legacy_kept')
  if (stale.length) {
    fatal(
      `Stale probe fixture(s) already present: ${stale.map((p) => p.id).join(', ')}. ` +
        'Delete them (DELETE /api/_panels/<id>) before re-running.',
    )
  }

  /* -- 2. install the legacy (land, id) shape the bug used to leave behind --- */
  d1('DROP TABLE IF EXISTS _meta_panels')
  d1(
    "CREATE TABLE _meta_panels (land TEXT NOT NULL DEFAULT 'default', id TEXT NOT NULL, definition TEXT NOT NULL, " +
      "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), " +
      "updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (land, id))",
  )
  d1(`INSERT INTO _meta_panels (land, id, definition) VALUES ('default', 'legacy_kept', ${sqlString(JSON.stringify(probe('legacy_kept', 'Legacy Kept')))})`)
  console.log('Installed the legacy PRIMARY KEY (land, id) shape with one row (land=default).\n')

  /* -- 3. restart the worker so the bootstrap migration actually runs ------ */
  await restartWorker()

  /* -- 4. assertions ------------------------------------------------------- */
  const list = await json(await areq('/api/_panels'))
  ok('the panels route answers after the legacy install', Array.isArray(list.data), JSON.stringify(list))

  const kept = await json(await areq('/api/_panels/legacy_kept'))
  ok('the row that predates the migration is still readable', kept.data?.id === 'legacy_kept', JSON.stringify(kept))
  // The check drops the table on purpose, so the only row that can be present is
  // the legacy one; the backed-up manifests come back in the `finally` block.
  ok(
    'the rebuilt table holds exactly the legacy row',
    (list.data ?? []).map((x) => x.id).join(',') === 'legacy_kept',
    (list.data ?? []).map((x) => x.id).join(','),
  )

  const storedLand = sqlite("SELECT land FROM _meta_panels WHERE id = 'legacy_kept'")
  ok(
    "the pre-scope 'default' land was folded into the current default land",
    storedLand === 'root_lnd',
    storedLand,
  )

  const pkCols = sqlite('PRAGMA table_info(_meta_panels)')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'))
    .filter((cols) => Number(cols[5]) > 0)
    .sort((a, b) => Number(a[5]) - Number(b[5]))
    .map((cols) => cols[1])
  ok('the primary key is exactly (land, colony, id)', pkCols.join(',') === 'land,colony,id', pkCols.join(','))

  const created = await areq('/api/_panels', {
    method: 'POST',
    body: JSON.stringify({ definition: probe('upsert_probe', 'Upsert Probe') }),
  })
  ok('an upsert succeeds (previously a 500 INTERNAL)', [200, 201].includes(created.status), `status ${created.status} ${JSON.stringify(await json(created))}`)

  const updated = await areq('/api/_panels/upsert_probe', {
    method: 'PUT',
    body: JSON.stringify({ definition: probe('upsert_probe', 'Upsert Probe v2') }),
  })
  ok('the same id updates instead of colliding', updated.status === 200, `status ${updated.status}`)

  const colony = await areq('/api/_meta/universe/colonies/migration_probe_cny', {
    method: 'PUT',
    body: JSON.stringify({ landId: 'root_lnd', label: 'Migration Probe' }),
  })
  ok('the probe colony is registered', [200, 201].includes(colony.status), `status ${colony.status} ${JSON.stringify(await json(colony))}`)

  const probeCollection = await areq('/api/_meta/collections/migration_probe', {
    method: 'PUT',
    headers: { 'x-colony': 'migration_probe_cny' },
    body: JSON.stringify({
      name: 'migration_probe',
      label: 'Migration Probe',
      fields: [{ name: 'name', label: 'Name', type: 'string', required: true }],
    }),
  })
  ok(
    'the probe colony has a target collection',
    [200, 201].includes(probeCollection.status),
    `status ${probeCollection.status} ${JSON.stringify(await json(probeCollection))}`,
  )

  const otherColony = await areq('/api/_panels', {
    method: 'POST',
    headers: { 'x-colony': 'migration_probe_cny' },
    body: JSON.stringify({ definition: probe('upsert_probe', 'Upsert Probe (colony)', 'migration_probe', ['name']) }),
  })
  ok('the same panel id in another colony does not collide', [200, 201].includes(otherColony.status), `status ${otherColony.status} ${JSON.stringify(await json(otherColony))}`)
} catch (error) {
  ok(`the run completed without throwing (${error.message})`, false, error.stack)
} finally {
  /* -- 5. always clean up the probes and hand the manifests back ----------- */
  for (const headers of [{ 'x-colony': 'migration_probe_cny' }, {}]) {
    await areq('/api/_panels/upsert_probe', { method: 'DELETE', headers }).catch(() => {})
  }
  await areq('/api/_panels/legacy_kept', { method: 'DELETE' }).catch(() => {})
  await areq('/api/_meta/collections/migration_probe', { method: 'DELETE', headers: { 'x-colony': 'migration_probe_cny' } }).catch(() => {})
  await areq('/api/_meta/universe/colonies/migration_probe_cny', { method: 'DELETE' }).catch(() => {})
  let restored = 0
  for (const manifest of saved) {
    const put = await areq(`/api/_panels/${manifest.id}`, { method: 'PUT', body: JSON.stringify({ definition: manifest }) })
    if (put.status === 200) restored += 1
  }
  ok('the pre-existing manifests were restored', restored === saved.length, `${restored}/${saved.length}`)
  const final = await json(await areq('/api/_panels'))
  ok(
    'the panels list is back to its original contents',
    (final.data ?? []).map((x) => x.id).sort().join(',') === saved.map((x) => x.id).sort().join(','),
    (final.data ?? []).map((x) => x.id).join(','),
  )
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)

async function restartWorker() {
  const listening = spawnSync('sh', ['-c', `lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`], { encoding: 'utf8' })
  for (const pid of (listening.stdout || '').trim().split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid))
    } catch {}
  }
  await sleep(3000)
  const child = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', PORT, '--ip', '0.0.0.0'], {
    cwd: CORE_DIR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ADMIN_KEY },
  })
  child.unref()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) {
        console.log('Worker restarted.\n')
        return
      }
    } catch {}
    await sleep(1000)
  }
  fatal(`The worker did not come back up on ${PORT}.`)
}
