/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

// Dump the current core state into a reproducible seed snapshot JSON file.
//
// Usage:
//   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me \
//     node scripts/dump-seed.mjs [scope] [media]
//
//   scope: 'all' (default) or a single collection name
//   media: 'none' (default) or 'bytes' to embed media assets as base64
//
// Output: seed-{land}-{date}.json in the current directory.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
const __dirname = dirname(fileURLToPath(import.meta.url))

const scope = process.argv[2] ?? 'all'
const media = process.argv[3] ?? 'none'

const login = await fetch(`${BASE}/api/_auth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: KEY }),
})
if (!login.ok) throw new Error(`Login failed (${login.status}) — is core running at ${BASE}?`)
const { data: { token } } = await login.json()

const qs = new URLSearchParams({ scope, media: media === 'bytes' ? 'bytes' : 'none' })
const res = await fetch(`${BASE}/api/_meta/seed/export?${qs}`, {
  headers: { authorization: `Bearer ${token}` },
})
if (!res.ok) throw new Error(`GET /api/_meta/seed/export → ${res.status} ${await res.text()}`)
const snap = await res.json()

const date = new Date().toISOString().slice(0, 10)
const out = join(process.cwd(), `seed-${snap.land || 'default'}-${date}.json`)
const raw = JSON.stringify(snap, null, 2)
writeFileSync(out, raw)

const records = Object.values(snap.records ?? {}).reduce((n, rows) => n + (rows?.length ?? 0), 0)
console.log(`Exported ${snap.collections.length} collection(s), ${records} record(s), ` +
  `${(snap.media ?? []).length} media asset(s)` +
  `${snap.mediaObjects ? ` (${Object.keys(snap.mediaObjects).length} R2 objects)` : ''}`)
console.log(`Wrote ${out} (${raw.length.toLocaleString()} bytes)`)