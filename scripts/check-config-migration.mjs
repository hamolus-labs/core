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
 */

/**
 * Runs the real `_configs` rebuild against a *legacy-shaped* table, on a scratch D1, and
 * boots the actual core to confirm the migration survives contact with a real request.
 *
 * Why this is not a unit test on the SQL string: the migration's hard part is not the
 * statements, it is the data already in someone's database. The old primary key was
 * `(scope, key)`, so the same key under two scopes was two ordinary rows — and they now
 * collide. A plain `INSERT` aborts there, on the databases most likely to be affected,
 * and a thrown migration is a 500 on every config request. Only running the real worker
 * against a real legacy table catches that.
 *
 * Node's own `node:sqlite` seeds the legacy table; the assertions all go over HTTP, so
 * what is checked is the shipped behaviour, not a paraphrase of it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PORT = Number(process.env.MIGRATION_PORT ?? 8799)
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
const CORE_DIR = new URL('..', import.meta.url).pathname
const persistDir = mkdtempSync(join(tmpdir(), 'hamolus-config-migration-'))
const sqlFile = join(persistDir, 'legacy.sql')
let passed = 0
let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * A table as `ensureConfigTable()` would have found it before this change: no `land`,
 * no `colony`, a `scope` column, and a `(scope, key)` primary key. `theme.mode` appears
 * under two scopes with different ages, which is the collision the rebuild has to
 * resolve; `only.old` exists in one scope only.
 */
const LEGACY_SCHEMA = `
  CREATE TABLE _configs (
    key TEXT NOT NULL COLLATE NOCASE,
    value TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'core',
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (scope, key)
  );
  INSERT INTO _configs (key, value, scope, description, updated_at) VALUES
    ('theme.mode',  '"stale"',  'core',  'older',  '2026-01-01T00:00:00.000Z'),
    ('theme.mode',  '"fresh"',  'site',  'newer',  '2026-06-01T00:00:00.000Z'),
    ('only.old',    '{"a":1}',  'site',  NULL,     '2026-02-01T00:00:00.000Z');
`
writeFileSync(sqlFile, LEGACY_SCHEMA)

const d1Args = ['wrangler', 'd1', 'execute', 'hamolus', '--local', '--persist-to', persistDir, '--file', sqlFile]
const seeded = spawnSync('pnpm', d1Args, { cwd: CORE_DIR, encoding: 'utf8' })
if (seeded.status !== 0) {
  console.error(seeded.stdout ?? '', seeded.stderr ?? '')
  throw new Error('could not seed the scratch D1')
}
// bootstrap.sql is applied after, so the core boots against a complete schema; the legacy
// `_configs` above is left alone because bootstrap does not create that table.
const boot = spawnSync('pnpm', ['wrangler', 'd1', 'execute', 'hamolus', '--local', '--persist-to', persistDir, '--file', 'scripts/bootstrap.sql'], { cwd: CORE_DIR, encoding: 'utf8' })
if (boot.status !== 0) {
  console.error(boot.stdout ?? '', boot.stderr ?? '')
  throw new Error('could not apply bootstrap.sql')
}

const dev = spawn(
  'pnpm',
  ['wrangler', 'dev', '--port', String(PORT), '--persist-to', persistDir, '--local'],
  { cwd: CORE_DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] },
)
const devLog = []
dev.stdout.on('data', (d) => devLog.push(String(d)))
dev.stderr.on('data', (d) => devLog.push(String(d)))

const cleanup = () => {
  dev.kill('SIGTERM')
  try {
    rmSync(persistDir, { recursive: true, force: true })
  } catch {
    /* the scratch dir is under the OS temp dir; a leftover is not worth failing over */
  }
}
process.on('exit', cleanup)

const waitForCore = async () => {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

try {
  if (!(await waitForCore())) {
    console.error(devLog.join(''))
    throw new Error(`the core never came up on ${BASE}`)
  }
  const token = await (
    await fetch(`${BASE}/api/_auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ADMIN_KEY }),
    })
  ).json()
  const auth = { authorization: `Bearer ${token?.data?.token}`, 'content-type': 'application/json' }

  const list = await fetch(`${BASE}/api/_config`, { headers: auth })
  const listBody = await list.json()
  ok('a legacy table does not take the core down', list.ok, `${list.status} ${JSON.stringify(listBody).slice(0, 200)}`)
  const rows = listBody?.data ?? []
  ok('every distinct key survived', rows.length === 2, JSON.stringify(rows.map((r) => r.key)))

  const theme = rows.find((r) => r.key === 'theme.mode')
  ok('the newer of two colliding rows is the one kept', theme?.value === 'fresh', JSON.stringify(theme))
  ok('a row that collided lost its label, not its place', theme?.description === 'newer', JSON.stringify(theme?.description))
  ok('the row unique to one scope came across', rows.some((r) => r.key === 'only.old'))
  ok('rows now report a land and a colony', rows.every((r) => r.land && r.colony), JSON.stringify(rows[0]))
  ok('no row reports a scope', rows.every((r) => r.scope === undefined))

  // A write must land in the migrated table rather than a stale definition of it.
  const put = await fetch(`${BASE}/api/_config/after.migration`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ value: { ok: true } }),
  })
  ok('the migrated table accepts a write', put.ok, `${put.status}`)
  const reread = await (await fetch(`${BASE}/api/_config`, { headers: auth })).json()
  ok('the new write is readable', (reread?.data ?? []).some((r) => r.key === 'after.migration'))
  const stillTwo = (reread?.data ?? []).filter((r) => r.key === 'theme.mode')
  ok('the collision did not merge unrelated keys', stillTwo.length === 1, JSON.stringify(stillTwo))
} finally {
  cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
