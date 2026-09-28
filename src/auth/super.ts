/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { sql, type SQL } from 'drizzle-orm'
import type { SuperAdminUser } from '@hamolus/types'
import type { Db } from '../db/client'
import { isIdentifier } from '../db/table'
import { badRequest, notFound } from '../errors'
import type { Env } from '../env'

/**
 * Platform super-administrator store. Super admins are GLOBAL accounts outside
 * the scoped `_auth_users` table: they can manage lands and colonies
 * registry from any land and their credentials survive even if every land is
 * deleted. Usernames are unique across the whole platform.
 */
const TABLE = '_auth_super'

export interface SuperRow {
  id: string
  username: string
  name: string | null
  password_hash: string
  is_active: number
  created_at: string
  updated_at: string
}

let superReady = false

export async function ensureSuperTable(db: Db): Promise<void> {
  if (superReady) return
  const boot = db.run(
      sql.raw(`
        CREATE TABLE IF NOT EXISTS _auth_super (
          id TEXT NOT NULL PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          name TEXT,
          password_hash TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
    )
  await boot
  superReady = true
}

export async function listSupers(db: Db): Promise<SuperRow[]> {
  await ensureSuperTable(db)
  return db.all<SuperRow>(
    sql`SELECT * FROM ${sql.raw(TABLE)} ORDER BY created_at ASC, id ASC`,
  )
}

async function getOne(db: Db, cond: SQL): Promise<SuperRow> {
  const rows = await db.all<SuperRow>(
    sql`SELECT * FROM ${sql.raw(TABLE)} WHERE ${cond} LIMIT 1`,
  )
  if (rows.length === 0) throw notFound('Super admin not found')
  return rows[0]!
}

export async function getSuperRowById(db: Db, id: string): Promise<SuperRow> {
  await ensureSuperTable(db)
  return getOne(db, sql`id = ${id}`)
}

export async function getSuperRowByUsername(db: Db, username: string): Promise<SuperRow> {
  await ensureSuperTable(db)
  return getOne(db, sql`username = ${username}`)
}

export interface CreateSuperInput {
  username: string
  name: string | null
  passwordHash: string
}

export async function createSuperRow(db: Db, input: CreateSuperInput): Promise<SuperRow> {
  await ensureSuperTable(db)
  const id = crypto.randomUUID()
  if (!isIdentifier(input.username)) throw badRequest('Invalid username')
  try {
    await db.run(
      sql`INSERT INTO ${sql.raw(TABLE)} (id, username, name, password_hash, is_active, created_at, updated_at) VALUES (${id}, ${input.username}, ${input.name}, ${input.passwordHash}, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    )
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw badRequest(`Username '${input.username}' is already taken`, 'DUPLICATE')
    throw err
  }
  return getSuperRowById(db, id)
}

export interface UpdateSuperInput {
  name?: string | null
  passwordHash?: string
  isActive?: boolean
}

export async function updateSuperRow(db: Db, id: string, input: UpdateSuperInput): Promise<SuperRow> {
  await ensureSuperTable(db)
  const sets: SQL[] = []
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`)
  if (input.passwordHash !== undefined) sets.push(sql`password_hash = ${input.passwordHash}`)
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive ? 1 : 0}`)
  sets.push(sql`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
  const res = await db.run(
    sql`UPDATE ${sql.raw(TABLE)} SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`,
  )
  if (res.meta.changes === 0) throw notFound('Super admin not found')
  return getSuperRowById(db, id)
}

export async function deleteSuperRow(db: Db, id: string): Promise<void> {
  await ensureSuperTable(db)
  const res = await db.run(sql`DELETE FROM ${sql.raw(TABLE)} WHERE id = ${id}`)
  if (res.meta.changes === 0) throw notFound('Super admin not found')
}

export async function countSupers(db: Db): Promise<number> {
  await ensureSuperTable(db)
  const res = await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM ${sql.raw(TABLE)}`)
  return Number(res?.total ?? 0)
}

export async function countActiveSupers(db: Db): Promise<number> {
  await ensureSuperTable(db)
  const res = await db.get<{ total: number }>(
    sql`SELECT count(*) AS total FROM ${sql.raw(TABLE)} WHERE is_active = 1`,
  )
  return Number(res?.total ?? 0)
}

export function serializeSuper(row: SuperRow): SuperAdminUser {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Seed the platform super admin from `SUPER_ADMIN_USERNAME`/`SUPER_ADMIN_PASSWORD`
 * on first boot. Runs once — when the table has rows the env is ignored (it can
 * be revoked/rotated later via the universe screen).
 */
let seedRan = false
export async function seedSuperFromEnv(db: Db, env: Env): Promise<void> {
  if (seedRan) return
  seedRan = true
  if (!env.SUPER_ADMIN_USERNAME || !env.SUPER_ADMIN_PASSWORD) return
  if ((await countSupers(db)) > 0) return
  const { hashPassword } = await import('./pass')
  await createSuperRow(db, {
    username: env.SUPER_ADMIN_USERNAME,
    name: 'Platform Super Admin',
    passwordHash: await hashPassword(env.SUPER_ADMIN_PASSWORD),
  })
}