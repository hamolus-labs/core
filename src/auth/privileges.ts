/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import type { Permission, PrivilegeScope } from '@hamolus/types'
import { COLONY_DEFAULT, LAND_DEFAULT, PRIVILEGE_SEEDS as SEEDS } from '@hamolus/types'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { putCollection, getCollection } from '../meta/store'
import { createRecord, listRecords } from '../db/queries'
import { physicalTable, quoteIdentifier } from '../db/table'

/**
 * The `privileges` collection is a first-class, bootstrapped dynamic collection:
 * its definition is owned by the platform (the definition endpoint refuses to
 * change it) but its records can be edited through the normal record API by
 * anyone holding `users.write`. The five default system roles are seeded on the
 * first boot so user provisioning never has an empty role set.
 */
export const PRIVILEGES_DEF: Record<string, unknown> = {
  name: 'privileges',
  label: 'Privileges',
  description: 'Role definitions that grant console/API capabilities to users.',
  group: 'System',
  icon: 'star',
  timestamps: true,
  fields: [
    { name: 'id', label: 'ID', type: 'id', required: true },
    { name: 'name', label: 'Name', type: 'slug', required: true, unique: true, indexed: true },
    { name: 'label', label: 'Label', type: 'string', required: true },
    {
      name: 'scope',
      label: 'Scope',
      type: 'enum',
      required: true,
      default: 'colony',
      enumValues: ['universe', 'land', 'colony'],
    },
    { name: 'description', label: 'Description', type: 'text' },
    { name: 'permissions', label: 'Permissions', type: 'json', default: [] },
    { name: 'is_system', label: 'System role', type: 'boolean', default: false },
  ],
}

export const PROTECTED_COLLECTION = 'privileges'

export interface PrivilegeRecord {
  id: string
  name: string
  label: string
  /** How far the role reaches; `universe` is reserved for the global superadmin. */
  scope: PrivilegeScope
  description: string | null
  permissions: Permission[]
  is_system: boolean
}

/**
 * Scopes whose privileges have been bootstrapped in this isolate. Holds no
 * promises on purpose — see the note in `ensurePrivileges`.
 */
const privReady = new Set<string>()

/**
 * Deterministic UUID (UUIDv5-ish) for a seed privilege so re-bootstraps never
 * change role ids — existing `_auth_users.privilege_id` references stay valid
 * even if the privileges collection is deleted and recreated by a reseed.
 */
function stableUuid(name: string): string {
  // FNV-1a over the name bytes, expanded to a full 128-bit UUID.
  const bytes = Array.from(new TextEncoder().encode(`privilege:${name}`))
  let a = 0x811c9dc5 ^ 0x1f6304d2
  let b = 0x811c9dc5
  let c = 0xc9dc5115
  let d = 0x81f5e24b
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 16777619) >>> 0
    b = Math.imul(b ^ byte, 16777619) >>> 0
    c = Math.imul(c ^ byte, 16777619) >>> 0
    d = Math.imul(d ^ byte, 16777619) >>> 0
  }
  const out = new Uint8Array(16)
  const view = new DataView(out.buffer)
  view.setUint32(0, a, true)
  view.setUint32(4, b, true)
  view.setUint32(8, c, true)
  view.setUint32(12, d ^ 0x0a45, true)
  out[6] = (out[6]! & 0x0f) | 0x40
  out[8] = (out[8]! & 0x3f) | 0x80
  const hex = Array.from(out, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function privilegeIdFor(name: string): string {
  return stableUuid(name)
}

/**
 * Forget a land's cached bootstrap so the next access re-creates the roles. Must
 * be called when a land's privileges table is dropped (land deletion) — otherwise
 * the resolved promise would keep a deleted land's roles alive for this isolate
 * and a re-created land would come back without any roles at all.
 */
export function invalidatePrivileges(
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): void {
  privReady.delete(privKey(land, colony))
}

/** Bootstrap key for one scope. `\u0000` cannot occur in a validated scope id. */
function privKey(land: string, colony: string): string {
  return `${land || LAND_DEFAULT}\u0000${colony || COLONY_DEFAULT}`
}

/** Bootstrap the privileges collection and seed the default roles once per scope. */
export async function ensurePrivileges(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<void> {
  const key = privKey(land, colony)
  if (privReady.has(key)) return
  const pending = (async () => {
      await putCollection(db, PRIVILEGES_DEF, land, colony)
      const def = await getCollection(db, PROTECTED_COLLECTION, land, colony)
      const table = physicalTable(land, colony, PROTECTED_COLLECTION)
      const seeded = await db.all<{
        name: string
        scope: string
        permissions: unknown
        is_system: number
      }>(
        sql`SELECT name, scope, permissions, is_system FROM ${sql.raw(quoteIdentifier(table))} WHERE ${sql.raw(quoteIdentifier('name'))} IN (${sql.join(SEEDS.map((seed) => sql`${seed.name}`), sql`, `)})`,
      )
      const byName = new Map(seeded.map((row) => [row.name, row]))
      for (const seed of SEEDS) {
        const rec = byName.get(seed.name)
        if (!rec) {
          if (!seed.isSystem) continue
          await createRecord(db, def, {
            id: stableUuid(seed.name),
            name: seed.name,
            label: seed.label,
            scope: seed.scope,
            description: seed.description ?? null,
            permissions: [...seed.permissions],
            is_system: seed.isSystem ?? false,
          })
          continue
        }
        if (rec.is_system !== 1) continue
        const stored = Array.isArray(rec.permissions) ? rec.permissions : []
        const missing = seed.permissions.filter((p) => !(stored as string[]).includes(p))
        // Scope is authoritative from the seed: a row written before the scope
        // field existed defaults to 'colony', which would silently demote a
        // land_admin that already exists on disk.
        if (missing.length === 0 && rec.scope === seed.scope) continue
        const merged = [...stored, ...missing]
        await db.run(
          sql`UPDATE ${sql.raw(quoteIdentifier(table))} SET ${sql.raw(quoteIdentifier('permissions'))} = ${JSON.stringify(merged)}, ${sql.raw(quoteIdentifier('scope'))} = ${seed.scope}, ${sql.raw(quoteIdentifier('updated_at'))} = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${sql.raw(quoteIdentifier('name'))} = ${seed.name}`,
        )
      }
    })()
    await pending
    // A completion latch, NOT a shared promise: two requests bootstrapping the
    // same scope concurrently each run the work in their own request context.
    // Awaiting a promise created inside another request resumes in that
    // request's async context, and the next D1 call then throws
    // `Cannot perform I/O on behalf of a different request` (I/O type
    // `UserTraceAsyncContext`) — a self-sustaining 500 loop under any load.
    // The seed is idempotent, so the duplicate work is harmless. Latching only
    // after `await pending` also means a transient failure is retried.
    privReady.add(key)
}

async function collectionDef(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
) {
  await ensurePrivileges(db, land, colony)
  return getCollection(db, PROTECTED_COLLECTION, land, colony)
}

/** All privilege records (id, name, label, permissions, is_system). */
export async function listPrivileges(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<PrivilegeRecord[]> {
  const def = await collectionDef(db, land, colony)
  const out: PrivilegeRecord[] = []
  let page = 1
  const pageSize = 100
  for (;;) {
    const { rows, total } = await listRecords(db, def, { page, pageSize })
    for (const r of rows) {
      out.push(r as unknown as PrivilegeRecord)
    }
    if (out.length >= total) break
    page += 1
  }
  return out
}

export async function getPrivilegeById(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<PrivilegeRecord | undefined> {
  const all = await listPrivileges(db, land, colony)
  return all.find((p) => p.id === id)
}

export async function getPrivilegeByName(
  db: Db,
  name: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<PrivilegeRecord | undefined> {
  const all = await listPrivileges(db, land, colony)
  return all.find((p) => p.name === name)
}

/** id → { name, label, scope } map for serializing AuthUser rows. */
export async function getPrivilegesMap(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<Map<string, { name: string; label: string; scope: PrivilegeScope }>> {
  const all = await listPrivileges(db, land, colony)
  return new Map(
    all.map((p) => [p.id, { name: p.name, label: p.label, scope: p.scope }]),
  )
}

export { SEEDS as PRIVILEGE_SEEDS }