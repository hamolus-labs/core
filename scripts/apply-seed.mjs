/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

// Restore a core from a seed snapshot JSON file (optionally wiping first).
//
// Usage:
//   BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me \
//     node scripts/apply-seed.mjs ./seed-default-2026-09-24.json [wipe]
//
//   wipe: 'true' (default) wipes existing collections/media/records first,
//         'false' upserts on top of the current data.
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'

const file = process.argv[2]
if (!file) {
  console.error('Usage: node scripts/apply-seed.mjs <snapshot.json> [wipe]')
  process.exit(1)
}
const wipe = process.argv[3] !== 'false'

const raw = readFileSync(file, 'utf8')
const snap = JSON.parse(raw)
if (!snap || snap.kind !== 'hamolus-seed') {
  throw new Error(`"${file}" is not a hamolus seed snapshot (kind="${snap?.kind}")`)
}

const login = await fetch(`${BASE}/api/_auth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: KEY }),
})
if (!login.ok) throw new Error(`Login failed (${login.status}) — is core running at ${BASE}?`)
const { data: { token } } = await login.json()

const qs = wipe ? '?wipe=true' : '?wipe=false'
const res = await fetch(`${BASE}/api/_meta/seed/apply${qs}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: raw,
})
if (!res.ok) throw new Error(`POST /api/_meta/seed/apply → ${res.status} ${await res.text()}`)
const { data } = await res.json()

console.log(`Applied snapshot from ${data.sourceLand || 'default'} (${data.sourceOrigin || 'unknown origin'}):`)
console.log(`  - ${data.collections.length} collection(s), ${data.records} record(s)`)
console.log(`  - ${data.groups} group(s), settings ${data.settings ? 'restored' : 'unchanged'}`)
console.log(`  - ${data.media} media asset(s), ${data.mediaObjects} R2 object(s)`)